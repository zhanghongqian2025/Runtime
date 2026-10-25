import type {
  AgentMessage,
  ApprovalChoice,
  ApprovalRequest,
  ApprovalResolution,
  RiskLevel,
  RuntimeEventBody,
} from '@local-agent/protocol';
import { newId } from '@local-agent/protocol';
import { runTurn, type ToolBinder, type ToolEnvironment } from '@local-agent/agent-core';
import type { BeforeLlmCallDecision } from '@local-agent/agent-core/pi-turn-runner';
import type { ProviderAdapter } from '../providers/types.js';
import type { EventDelivery } from '../events/types.js';
import type { Logger } from '../logging/logger.js';
import type { SessionStatus, SessionStore, ToolCallRecord, TurnRecord } from '../sessions/types.js';
import type { LoadedRuntimeConfig } from '../config/types.js';
import { createSessionArtifacts } from '../artifacts.js';
import { createQuestionBridge, type QuestionBridge } from '../questions.js';
import { createPermissionService, type PermissionService } from '../permissions/core.js';
import {
  buildCompactionPrompt,
  computeContextBudget,
  estimateMessagesTokens,
} from '@local-agent/agent-core/pi-turn-runner';
import { compactSession } from '../sessions/compaction.js';
import { createJournal, type Journal } from '../sessions/journal.js';
import type { QueueClassification, TurnPolicy } from './policy.js';
import { sessionPaths } from '../sessions/disk-store.js';
import { normalizeToolCall } from '../permissions/normalize.js';
import { redactText } from '../logging/logger.js';

/**
 * The turn system.
 *
 * One turn at a time per session: a new message is queued behind the running
 * turn. Different sessions run in parallel.
 */

export interface TurnSystemOptions {
  readonly sessions: SessionStore;
  readonly events: EventDelivery;
  readonly config: LoadedRuntimeConfig;
  readonly provider: ProviderAdapter | undefined;
  readonly tools: ToolBinder;
  readonly logger: Logger;
  /** The runtime data directory that holds the session artifacts. */
  readonly dataDir: string;
  /** The turn policy: the fence, the queue classification and the context. */
  readonly policy?: TurnPolicy;
}

export interface SubmitResult {
  /** Undefined when the item was dropped before it was accepted. */
  readonly turnId: string | undefined;
  /** Position in the session queue, starting at 0 for a running turn. */
  readonly queued: number;
  /** True when the fence deferred the turn. */
  readonly deferred: boolean;
  /** True when the item was not valid anymore and was dropped. */
  readonly cancelled: boolean;
}

export interface TurnSystem {
  submit(sessionId: string, text: string): Promise<SubmitResult>;
  status(sessionId: string): SessionStatus;
  /** Answer a question the `ask_user` tool is waiting for. */
  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string>): boolean;
  /** The questions waiting for an answer in a session. */
  pendingQuestions(sessionId: string): readonly string[];
  /** Answer a permission request. */
  answerApproval(sessionId: string, requestId: string, choice: ApprovalChoice): boolean;
  /** The permission requests waiting for an answer in a session. */
  pendingApprovals(sessionId: string): readonly string[];
  /** Run the turns the fence deferred. Returns how many were released. */
  resumeDeferred(sessionId: string): number;
  /**
   * Accept a plan entry.
   *
   * The plan entry is a turn that only switches the mode: it is recorded in
   * the turn index so it can be settled when the admission is compensated.
   */
  acceptPlanEntry(sessionId: string): { turnId: string };
  /** Settle a turn as failed. */
  failTurn(sessionId: string, turnId: string, reason: string): void;
  /** Install (or replace) the turn policy. */
  setPolicy(policy: TurnPolicy | undefined): void;
  /**
   * Register a tool of the host with the permission core.
   *
   * A tool nobody registers is denied by the permission policy.
   */
  registerPermissionTool(name: string, risk: RiskLevel): void;
  /**
   * Run another round on the existing history.
   *
   * No message is appended: the loop continues with the history as it is.
   * This is how a goal keeps going without a hidden prompt.
   */
  continueTurn(sessionId: string): { turnId: string };
  /** Wait for a turn to finish. */
  awaitTurn(sessionId: string, turnId: string): Promise<void>;
  /** The turns the fence is holding back. */
  deferredTurns(sessionId: string): readonly string[];
}

/** Mask credential-shaped values before they reach the approval card. */
export function redactApprovalInput(input: unknown): unknown {
  if (typeof input === 'string') return redactText(input);
  if (Array.isArray(input)) return input.map((entry) => redactApprovalInput(entry));
  if (input !== null && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = redactApprovalInput(value);
    }
    return output;
  }
  return input;
}

/** The auxiliary summary call must not be able to call a tool. */
const NO_TOOLS: ToolBinder = {
  resolve: () => undefined,
  list: () => [],
  bind: () => [],
};

export class SessionNotFound extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFound';
  }
}

export class NoProviderConfigured extends Error {
  constructor() {
    super('no provider is configured; set one in the runtime configuration');
    this.name = 'NoProviderConfigured';
  }
}

export function createTurnSystem(options: TurnSystemOptions): TurnSystem {
  // The policy is installed by the application layer, which needs the
  // services the turn system itself provides.
  let policy: TurnPolicy | undefined = options.policy;

  const chains = new Map<string, Promise<unknown>>();
  const deferred: { sessionId: string; turnId: string }[] = [];
  const running = new Map<string, Promise<void>>();
  const bridges = new Map<string, QuestionBridge>();
  const permissions = new Map<string, PermissionService>();
  // The tools the application registers are known to every session.
  const permissionToolRisks = new Map<string, RiskLevel>();
  const journals = new Map<string, Journal>();
  const toolCalls = new Map<string, Map<string, ToolCallRecord>>();

  const journalFor = (sessionId: string): Journal => {
    const existing = journals.get(sessionId);
    if (existing) return existing;
    const created = createJournal({
      filePath: sessionPaths(options.dataDir, sessionId).journal,
    });
    journals.set(sessionId, created);
    return created;
  };

  const enqueue = (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  };

  const permissionFor = (sessionId: string): PermissionService => {
    const existing = permissions.get(sessionId);
    if (existing) return existing;
    const created = createPermissionService({
      mode: options.config.config.permissionMode,
      toolRisks: permissionToolRisks,
    });
    permissions.set(sessionId, created);
    return created;
  };

  const bridgeFor = (sessionId: string): QuestionBridge => {
    const existing = bridges.get(sessionId);
    if (existing) return existing;
    const created = createQuestionBridge();
    bridges.set(sessionId, created);
    return created;
  };

  const runTurnFor = async (sessionId: string, turnId: string): Promise<void> => {
    const session = options.sessions.get(sessionId);
    if (!session) throw new SessionNotFound(sessionId);

    // The provider *adapter* is mandatory; its model settings come from the
    // configuration when it is listed there, and fall back to safe defaults
    // otherwise (an injected provider, for instance).
    if (!options.provider) throw new NoProviderConfigured();
    const providerConfig = options.config.config.providers.find(
      (provider) => provider.id === session.providerId,
    );

    options.sessions.update(sessionId, { status: 'running' });

    // The policy may inject the authoritative context of this turn (the
    // frozen plan, for instance). It is appended to the history, so it is
    // both part of the request and part of the record.
    const injected = await policy?.prepareTurn?.(sessionId, turnId);
    if (injected !== undefined && injected.length > 0) {
      options.sessions.appendHistory(sessionId, injected);
    }

    const history = options.sessions.readHistory(sessionId);
    const bridge = bridgeFor(sessionId);
    const permission = permissionFor(sessionId);
    const journal = journalFor(sessionId);
    const startedAt = new Date().toISOString();
    const calls = new Map<string, ToolCallRecord>();
    toolCalls.set(sessionId, calls);

    const model = {
      providerId: session.providerId,
      model: session.model,
      contextWindowTokens: providerConfig?.contextWindowTokens ?? 128_000,
      maxOutputTokens: providerConfig?.maxOutputTokens ?? 4096,
    };

    const recordTurn = (status: TurnRecord['status']): void => {
      options.sessions.appendTurn(sessionId, {
        turnId,
        startedAt,
        endedAt: new Date().toISOString(),
        status,
        toolCalls: [...calls.values()],
      });
    };

    options.sessions.appendTurn(sessionId, {
      turnId,
      startedAt,
      status: 'running',
      toolCalls: [],
    });

    // The summary runs in its own turn: it never touches the history.
    const summarize = async (content: string): Promise<string | undefined> => {
      if (!options.provider) return undefined;
      const summaryTurnId = newId('turn');
      const result = await runTurn({
        sessionId,
        turnId: summaryTurnId,
        model,
        tools: NO_TOOLS,
        history: [
          {
            id: newId('message'),
            role: 'user',
            content: [{ type: 'text', text: buildCompactionPrompt(content) }],
            createdAt: new Date().toISOString(),
          },
        ],
        hooks: {},
        messageSink: {
          append: async () => undefined,
          replace: async () => undefined,
        },
        writeEvent: (draft): void => {
          options.events.publish(sessionId, draft);
          switch (draft.type) {
            case 'tool.call.started':
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: draft.name,
                status: 'started',
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            case 'tool.call.completed': {
              const existing = calls.get(draft.toolCallId);
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: existing?.name ?? draft.name,
                status: 'completed',
                finishedAt: new Date().toISOString(),
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            }
            case 'tool.call.blocked': {
              const existing = calls.get(draft.toolCallId);
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: existing?.name ?? draft.name,
                status: 'blocked',
                finishedAt: new Date().toISOString(),
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            }
            case 'session.status':
              if (draft.status === 'completed') recordTurn('completed');
              else if (draft.status === 'failed' || draft.status === 'aborted') recordTurn('failed');
              break;
            default:
              break;
          }
        },
        stream: options.provider.stream,
        toolEnvironment,
      });
      for (let index = result.events.length - 1; index >= 0; index -= 1) {
        const event = result.events[index];
        if (event?.type === 'message.completed') {
          const text = event.message.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('');
          return text.length > 0 ? text : undefined;
        }
      }
      return undefined;
    };

    // The compaction runs as a beforeLlmCall hook: the durable replace is
    // the same mechanism the hook contract already defines.
    const compactionHook = async (context: {
      readonly publishEvent: (body: RuntimeEventBody) => Promise<void>;
    }): Promise<BeforeLlmCallDecision> => {
      const current = options.sessions.readHistory(sessionId);
      const budget = computeContextBudget(model);
      const beforeTokens = estimateMessagesTokens(current);
      if (beforeTokens <= budget.compactWatermark) {
        return { kind: 'continue' };
      }

      await context.publishEvent({
        type: 'context.compaction.started',
        reason: 'watermark',
        beforeTokens,
      });

      const outcome = await compactSession(sessionId, {
        sessions: options.sessions,
        logger: options.logger,
        model,
        summarize,
        journal,
      });

      await context.publishEvent({
        type: 'context.compaction.completed',
        beforeTokens: outcome.beforeTokens,
        afterTokens: outcome.afterTokens,
        savedRatio: outcome.savedRatio,
        checkpointId: outcome.checkpointId ?? '',
      });

      if (!outcome.compacted) {
        return { kind: 'continue' };
      }
      return { kind: 'replaceMessages', messages: outcome.messages ?? [] };
    };

    const toolEnvironment: ToolEnvironment = {
      cwd: session.cwd,
      env: {},
      now: () => Date.now(),
      limits: {
        maxBytes: options.config.config.tools.maxResultBytes,
        maxLines: options.config.config.tools.maxLines,
      },
      // Until the permission core is wired in (M3), a tool that asks for
      // permission is denied: fail-closed beats guessing.
      requestPermission: async (request): Promise<ApprovalResolution> => ({
        requestId: request.requestId,
        choice: 'deny',
        decidedBy: 'policy',
      }),
      onFileChanged: () => undefined,
      askUser: async (request) => {
        options.sessions.update(sessionId, { status: 'awaiting_input' });
        try {
          return await bridge.askUser(request);
        } finally {
          options.sessions.update(sessionId, { status: 'running' });
        }
      },
      artifacts: createSessionArtifacts(session.id, { dataDir: options.dataDir }),
      log: options.logger,
    };

    let turnStatus: 'completed' | 'failed' | 'aborted' = 'completed';
    let turnUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      const result = await runTurn({
        sessionId,
        turnId,
        model: {
          providerId: session.providerId,
          model: session.model,
          contextWindowTokens: providerConfig?.contextWindowTokens ?? 128_000,
          maxOutputTokens: providerConfig?.maxOutputTokens ?? 4096,
          ...(providerConfig?.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: providerConfig.reasoningEffort }),
          ...(providerConfig?.thinking === undefined
            ? {}
            : { thinking: providerConfig.thinking }),
        },
        tools: policy?.binderForTurn?.(sessionId, turnId) ?? options.tools,
        history,
        hooks: {
          beforeLlmCall: [compactionHook],
          beforeToolCall: [
            async (context) => {
              const call = normalizeToolCall(context.toolName, context.input, session.cwd);
              const decision = permission.decide({
                toolName: context.toolName,
                normalizedInput: call.input,
                // A session may carry its own permission mode. The runtime
                // configuration is the default, not the rule.
                mode: session.permissionMode ?? options.config.config.permissionMode,
                sessionRules: permission.listSessionRules(sessionId),
                cwd: session.cwd,
              });

              options.logger.info('permission decision', {
                tool: context.toolName,
                outcome: decision.outcome,
                risk: decision.risk,
                ...(decision.matchedRule === undefined
                  ? {}
                  : { matchedRule: decision.matchedRule }),
              });

              if (decision.outcome === 'deny') {
                return { kind: 'block', reason: decision.reason, blockedBy: 'permission' };
              }

              if (decision.outcome === 'ask') {
                const request: ApprovalRequest = {
                  requestId: newId('request'),
                  toolName: context.toolName,
                  input: redactApprovalInput(call.input),
                  risk: decision.risk,
                  ...(decision.matchedRule === undefined
                    ? {}
                    : { matchedRule: decision.matchedRule }),
                  reason: decision.reason,
                  options: [
                    { id: 'allow-once', label: 'Allow once' },
                    { id: 'allow-session', label: 'Allow for this session' },
                    { id: 'deny', label: 'Deny', default: true },
                  ],
                };

                const resolution = await context.requestApproval(request);

                if (resolution.choice === 'deny') {
                  return {
                    kind: 'block',
                    reason: 'the user denied the call',
                    blockedBy: 'permission',
                  };
                }
                if (resolution.choice === 'allow-session') {
                  permission.grantSessionRule(sessionId, {
                    id: newId('request'),
                    description: `${context.toolName} was allowed for this session`,
                    toolName: context.toolName,
                    ...(call.command === undefined
                      ? {}
                      : { commandPrefix: call.command.trim().split(/\s+/)[0] ?? call.command }),
                  });
                }
                return { kind: 'continue' };
              }

              return { kind: 'continue' };
            },
          ],
        },
        messageSink: {
          append: async (messages: readonly AgentMessage[]): Promise<void> => {
            options.sessions.appendHistory(sessionId, messages);
          },
          replace: async (messages: readonly AgentMessage[]): Promise<void> => {
            options.sessions.replaceHistory(sessionId, messages);
          },
        },
        writeEvent: (draft): void => {
          options.events.publish(sessionId, draft);
          switch (draft.type) {
            case 'tool.call.started':
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: draft.name,
                status: 'started',
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            case 'tool.call.completed': {
              const existing = calls.get(draft.toolCallId);
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: existing?.name ?? draft.name,
                status: 'completed',
                finishedAt: new Date().toISOString(),
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            }
            case 'tool.call.blocked': {
              const existing = calls.get(draft.toolCallId);
              calls.set(draft.toolCallId, {
                toolCallId: draft.toolCallId,
                name: existing?.name ?? draft.name,
                status: 'blocked',
                finishedAt: new Date().toISOString(),
              });
              options.sessions.appendTurn(sessionId, {
                turnId,
                startedAt,
                status: 'running',
                toolCalls: [...calls.values()],
              });
              break;
            }
            case 'session.status':
              if (draft.status === 'completed') recordTurn('completed');
              else if (draft.status === 'failed' || draft.status === 'aborted') recordTurn('failed');
              break;
            default:
              break;
          }
        },
        stream: options.provider.stream,
        toolEnvironment,
        onApprovalRequested: async (request: ApprovalRequest): Promise<ApprovalResolution> => {
          options.sessions.update(sessionId, { status: 'awaiting_approval' });
          try {
            return await permission.requestApproval(request);
          } finally {
            options.sessions.update(sessionId, { status: 'running' });
          }
        },
      });
      turnStatus = result.status;
      turnUsage = result.usage;
      if (result.error !== undefined) {
        options.logger.error('turn failed', {
          sessionId,
          turnId,
          code: result.error.code,
          error: result.error.message,
        });
      }
    } catch (error: unknown) {
      turnStatus = 'failed';
      throw error;
    } finally {
      options.sessions.update(sessionId, { status: 'idle' });
      // The policy decides what happens next: the goal mode continues on its
      // own when the goal is not reached yet.
      await policy?.afterTurn?.(sessionId, turnId, {
        usage: turnUsage,
        status: turnStatus,
      });
    }
  };

  return {
    async submit(sessionId: string, text: string): Promise<SubmitResult> {
      const session = options.sessions.get(sessionId);
      if (!session) throw new SessionNotFound(sessionId);

      // The policy decides whether the message runs, waits or is dropped.
      const classification: QueueClassification =
        policy?.classify({ kind: 'message', sessionId, text }) ?? 'run';
      if (classification === 'cancel') {
        return { turnId: undefined, queued: 0, deferred: false, cancelled: true };
      }

      const turnId = newId('turn');
      const userMessage: AgentMessage = {
        id: newId('message'),
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: new Date().toISOString(),
        meta: { turnId },
      };
      options.sessions.appendHistory(sessionId, [userMessage]);

      // A turn that finds a running turn in this session is queued behind it.
      const queued = chains.has(sessionId) ? 1 : 0;

      if (classification === 'defer') {
        // The fence is closed: the message is accepted and kept, but it does
        // not run until the fence clears.
        deferred.push({ sessionId, turnId });
        options.sessions.update(sessionId, { status: 'idle' });
        return { turnId, queued: 1, deferred: true, cancelled: false };
      }

      const promise = enqueue(sessionId, async () => {
        try {
          await runTurnFor(sessionId, turnId);
        } catch (error: unknown) {
          options.logger.error('turn failed', {
            sessionId,
            turnId,
            error: error instanceof Error ? error.message : 'unknown error',
          });
        }
      });
      running.set(turnId, promise);

      return { turnId, queued, deferred: false, cancelled: false };
    },

    setPolicy(next: TurnPolicy | undefined): void {
      policy = next;
    },

    registerPermissionTool(name: string, risk: RiskLevel): void {
      permissionToolRisks.set(name, risk);
    },

    continueTurn(sessionId: string): { turnId: string } {
      const turnId = newId('turn');
      const promise = enqueue(sessionId, async () => {
        try {
          await runTurnFor(sessionId, turnId);
        } catch (error: unknown) {
          options.logger.error('turn failed', {
            sessionId,
            turnId,
            error: error instanceof Error ? error.message : 'unknown error',
          });
        }
      });
      running.set(turnId, promise);
      return { turnId };
    },

    async awaitTurn(_sessionId: string, turnId: string): Promise<void> {
      const promise = running.get(turnId);
      if (promise === undefined) return;
      await promise;
      running.delete(turnId);
    },

    acceptPlanEntry(sessionId: string): { turnId: string } {
      const turnId = newId('turn');
      const timestamp = new Date().toISOString();
      // The plan entry is the **mode switch**, not work: it is settled right
      // away. A turn that stays "running" for ever is a lie in the turn log,
      // and the recovery would keep reporting it as interrupted.
      options.sessions.appendTurn(sessionId, {
        turnId,
        startedAt: timestamp,
        endedAt: timestamp,
        status: 'completed',
        toolCalls: [],
      });
      return { turnId };
    },

    failTurn(sessionId: string, turnId: string, reason: string): void {
      options.sessions.appendTurn(sessionId, {
        turnId,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: 'failed',
        toolCalls: [],
      });
      options.events.publishHost(sessionId, {
        type: 'session.status',
        status: 'failed',
        reason,
        error: { code: 'PLAN_ADMISSION_COMPENSATED', message: reason },
      });
    },

    /**
     * Run the turns that the fence deferred.
     */
    resumeDeferred(sessionId: string): number {
      const pending = deferred.filter((entry) => entry.sessionId === sessionId);
      for (const entry of pending) {
        const index = deferred.indexOf(entry);
        if (index >= 0) deferred.splice(index, 1);
        void enqueue(sessionId, async () => {
          try {
            await runTurnFor(sessionId, entry.turnId);
          } catch (error: unknown) {
            options.logger.error('deferred turn failed', {
              sessionId,
              turnId: entry.turnId,
              error: error instanceof Error ? error.message : 'unknown error',
            });
          }
        });
      }
      return pending.length;
    },

    /** The turns the fence is holding back. */
    deferredTurns(sessionId: string): readonly string[] {
      return deferred.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.turnId);
    },

    status(sessionId: string): SessionStatus {
      return options.sessions.get(sessionId)?.status ?? 'idle';
    },

    answerQuestion(sessionId: string, requestId: string, answers: Record<string, string>): boolean {
      const bridge = bridges.get(sessionId);
      if (!bridge) return false;
      return bridge.resolve(requestId, answers);
    },

    pendingQuestions(sessionId: string): readonly string[] {
      return bridges.get(sessionId)?.pending() ?? [];
    },

    answerApproval(sessionId: string, requestId: string, choice: ApprovalChoice): boolean {
      const permission = permissions.get(sessionId);
      if (!permission) return false;
      if (!permission.pending().includes(requestId)) return false;
      permission.resolveApproval(requestId, choice);
      return true;
    },

    pendingApprovals(sessionId: string): readonly string[] {
      return permissions.get(sessionId)?.pending() ?? [];
    },
  };
}
