import type {
  AgentEvent,
  AgentMessage,
  ContentBlock,
  RuntimeEventBody,
  RuntimeEventDraft,
  TokenUsage,
  ToolResult,
  ToolUpdate,
} from '@local-agent/protocol';
import { newId } from '@local-agent/protocol';
import { createTurnEventEmitter } from '../event-bridge/index.js';
import { toJsonSchema } from '../tools/json-schema.js';
import type { ToolExecutionContext } from '../tools/index.js';
import type {
  BlockedToolCall,
  BeforeLlmCallContext,
  BeforeLlmCallDecision,
  FollowUp,
  ToolCallSummary,
} from './hooks.js';
import { isAppendMessageAllowed, isRespondAllowed } from './hooks.js';
import { projectAgentMessagesForModel } from './projection.js';
import type {
  ProviderCallContext,
  ProviderRequest,
  RunTurnInput,
  RunTurnResult,
} from './types.js';

/**
 * The agent loop.
 *
 * `runTurn` is a clean input/output boundary: everything the loop needs is
 * in `RunTurnInput`, and the result is the list of wire events, always ending
 * with a terminal `session.status` event.
 *
 * The loop has no filesystem, no network and no clock of its own: the host
 * provides the tool execution context, the stream function and the sinks.
 */

/** Per-attempt timeouts. The host may tighten them; it cannot loosen them silently. */
export const DEFAULT_PROVIDER_TIMEOUTS = {
  firstEventTimeoutMs: 300_000,
  idleTimeoutMs: 3_600_000,
  totalTimeoutMs: 1_200_000,
} as const;

/**
 * Budgets that keep a turn finite.
 *
 * A hook that keeps asking for a retry, or a model that keeps calling tools,
 * must not spin forever: the turn fails closed with a clear reason instead.
 */
export const MAX_LLM_RETRIES = 5;
export const MAX_STEPS = 50;

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

class TurnAborted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TurnAborted';
  }
}

class HookAcknowledgementFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookAcknowledgementFailed';
  }
}

interface ToolIntent {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
}

interface BeforeLlmOutcome {
  readonly kind: 'continue' | 'skip' | 'respond' | 'abort';
  readonly requestMessages: readonly AgentMessage[];
  readonly historyReplacement: readonly AgentMessage[] | undefined;
  readonly markers: readonly AgentMessage[];
  readonly respondText: string | undefined;
  readonly abortReason: string | undefined;
}

/** The marker kind of a hidden custom message, if it has one. */
function markerKindOf(message: AgentMessage): string | undefined {
  const block = message.content.find((entry) => entry.type === 'custom');
  return block?.type === 'custom' ? block.kind : undefined;
}

/** Index of the current real user message, or the end of the history. */
function currentUserIndex(history: readonly AgentMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'user') continue;
    if (markerKindOf(message) !== undefined) continue;
    return index;
  }
  return history.length;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const { hooks } = input;
  const emitter = createTurnEventEmitter({
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  const events: RuntimeEventDraft[] = [];

  const emit = async (event: AgentEvent): Promise<void> => {
    const draft = emitter.emit(event);
    if (!draft) return;
    events.push(draft);
    await input.writeEvent(draft);
  };

  /** Publish a host-side event; the core owns the envelope. */
  const publish = async (body: RuntimeEventBody): Promise<void> => {
    const draft = emitter.emitHost(body);
    events.push(draft);
    await input.writeEvent(draft);
  };

  const history: AgentMessage[] = [...input.history];
  const followUps: FollowUp[] = [];
  const signal = input.signal ?? new AbortController().signal;

  let usage: TokenUsage = ZERO_USAGE;
  let providerCalled = false;
  let stepIndex = 0;
  let llmRetries = 0;
  let terminalError: { code: string; message: string } | undefined;

  /** Persist a history change and notify the fan-out hooks. */
  const persist = async (
    next: readonly AgentMessage[],
    appended: readonly AgentMessage[],
    replace: boolean,
    reason: 'flush' | 'replace',
  ): Promise<void> => {
    if (replace) {
      await input.messageSink.replace(next);
    } else if (appended.length > 0) {
      await input.messageSink.append(appended);
    }
    for (const hook of hooks.onHistoryChanged ?? []) {
      try {
        await hook({ turnId: input.turnId, messages: appended, reason });
      } catch (error: unknown) {
        throw new HookAcknowledgementFailed(
          `history notification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  };

  /** Run the beforeLlmCall decision pipeline. */
  const runBeforeLlmCall = async (
    requestMessages: readonly AgentMessage[],
  ): Promise<BeforeLlmOutcome> => {
    let context: BeforeLlmCallContext = {
      turnId: input.turnId,
      stepIndex,
      attempt: 1,
      requestMessages,
      pendingMarkers: [],
      providerCalled,
      publishEvent: publish,
    };

    let effectiveRequest = requestMessages;
    let historyReplacement: readonly AgentMessage[] | undefined;
    let markers: AgentMessage[] = [];
    let respondText: string | undefined;
    let abortReason: string | undefined;

    for (const hook of hooks.beforeLlmCall ?? []) {
      const decision: BeforeLlmCallDecision = await hook(context);

      switch (decision.kind) {
        case 'continue':
          break;
        case 'skip':
          return {
            kind: 'skip',
            requestMessages: effectiveRequest,
            historyReplacement,
            markers,
            respondText,
            abortReason,
          };
        case 'replaceRequestMessages':
          effectiveRequest = decision.messages;
          break;
        case 'replaceMessages':
          historyReplacement = decision.messages;
          break;
        case 'appendMessage':
          // A decision that does not respect the contract is rejected and
          // treated as `continue`; it never reaches the canonical history.
          if (!isAppendMessageAllowed(decision.message)) break;
          markers = [...markers, decision.message];
          break;
        case 'respond':
          if (!isRespondAllowed(decision, context)) break;
          respondText = decision.text;
          break;
        case 'abort':
          abortReason = decision.reason;
          break;
        default:
          break;
      }

      // Later hooks see the markers accumulated so far.
      context = { ...context, requestMessages: effectiveRequest, pendingMarkers: markers };
    }

    if (abortReason !== undefined) {
      return {
        kind: 'abort',
        requestMessages: effectiveRequest,
        historyReplacement,
        markers,
        respondText,
        abortReason,
      };
    }

    if (respondText !== undefined) {
      return {
        kind: 'respond',
        requestMessages: effectiveRequest,
        historyReplacement,
        markers,
        respondText,
        abortReason,
      };
    }

    return {
      kind: 'continue',
      requestMessages: effectiveRequest,
      historyReplacement,
      markers,
      respondText,
      abortReason,
    };
  };

  /** Apply the marker rules and write the history exactly once. */
  const flushMarkers = async (outcome: BeforeLlmOutcome): Promise<void> => {
    if (outcome.markers.length === 0 && outcome.historyReplacement === undefined) {
      return;
    }

    const base = outcome.historyReplacement ?? history;
    const tailMarkers = outcome.markers.filter((m) => markerKindOf(m) === 'marker.tail');
    const beforeUserMarkers = outcome.markers.filter(
      (m) => markerKindOf(m) === 'marker.before-current-user',
    );
    const afterCommit = outcome.markers.filter((m) => markerKindOf(m) === 'after-commit');

    const next: AgentMessage[] = [...base];
    if (beforeUserMarkers.length > 0) {
      const index = currentUserIndex(next);
      next.splice(index, 0, ...beforeUserMarkers);
    }
    // after-commit messages sit before every tail marker.
    next.push(...afterCommit, ...tailMarkers);

    const added = [...afterCommit, ...tailMarkers, ...beforeUserMarkers];
    const requiresReplace = outcome.historyReplacement !== undefined || beforeUserMarkers.length > 0;

    if (requiresReplace) {
      await persist(next, added, true, 'replace');
    } else {
      await persist(next, added, false, 'flush');
    }

    history.length = 0;
    history.push(...next);
  };

  /** Execute the tool intents of one step. */
  const executeTools = async (
    intents: readonly ToolIntent[],
  ): Promise<{ completed: ToolCallSummary[]; blocked: BlockedToolCall[]; messages: AgentMessage[] }> => {
    const completed: ToolCallSummary[] = [];
    const blocked: BlockedToolCall[] = [];
    const messages: AgentMessage[] = [];

    for (const intent of intents) {
      await emit({
        type: 'tool.intent.created',
        turnId: input.turnId,
        toolCallId: intent.toolCallId,
        name: intent.name,
        input: intent.input,
      });

      let block: { by: string; reason: string } | undefined;
      for (const hook of hooks.beforeToolCall ?? []) {
        const decision = await hook({
          turnId: input.turnId,
          toolCallId: intent.toolCallId,
          toolName: intent.name,
          input: intent.input,
          publishEvent: publish,
          requestApproval: async (request) => {
            await publish({ type: 'permission.requested', approval: request });
            const resolution = (await input.onApprovalRequested?.(request)) ?? {
              requestId: request.requestId,
              choice: 'deny' as const,
              decidedBy: 'policy' as const,
            };
            await publish({ type: 'permission.resolved', resolution });
            return resolution;
          },
        });
        if (decision.kind === 'block') {
          block = { by: decision.blockedBy ?? 'policy', reason: decision.reason };
          break;
        }
      }

      if (block) {
        await emit({
          type: 'tool.intent.blocked',
          turnId: input.turnId,
          toolCallId: intent.toolCallId,
          name: intent.name,
          blockedBy: block.by,
          reason: block.reason,
        });
        blocked.push({
          toolCallId: intent.toolCallId,
          name: intent.name,
          blockedBy: block.by,
          reason: block.reason,
        });
        // A blocked call still has to be answered. A tool call without a
        // result leaves the history malformed, and a provider may answer a
        // malformed history with an empty completion.
        messages.push({
          id: newId('message'),
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: intent.toolCallId,
              content: [
                { type: 'text', text: `the tool call was blocked (${block.by}): ${block.reason}` },
              ],
              isError: true,
            },
          ],
          createdAt: new Date().toISOString(),
          meta: { turnId: input.turnId, stepIndex },
        });
        continue;
      }

      await emit({
        type: 'tool.intent.started',
        turnId: input.turnId,
        toolCallId: intent.toolCallId,
      });

      const implementation = input.tools.resolve(intent.name);
      let result: ToolResult;

      if (!implementation) {
        result = {
          ok: false,
          isError: true,
          content: [{ type: 'text', text: `unknown tool: ${intent.name}` }],
        };
      } else {
        const context: ToolExecutionContext = {
          ...input.toolEnvironment,
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: intent.toolCallId,
          emitEvent: publish,
          // The core publishes the file change so the event carries a
          // turn-scoped sequence number; the host callback still runs.
          onFileChanged: async (change) => {
            await input.toolEnvironment.onFileChanged(change);
            await publish({
              type: 'file.changed',
              path: change.path,
              change: change.change,
              ...(change.bytes === undefined ? {} : { bytes: change.bytes }),
            });
          },
        };
        let pending: Promise<void> = Promise.resolve();
        const onUpdate = (update: ToolUpdate): void => {
          pending = pending.then(() =>
            emit({
              type: 'tool.intent.progress',
              turnId: input.turnId,
              toolCallId: intent.toolCallId,
              name: intent.name,
              chunk: update.chunk,
            }),
          );
        };

        try {
          result = await implementation.execute(context, intent.input, signal, onUpdate);
        } catch (error: unknown) {
          result = {
            ok: false,
            isError: true,
            content: [
              {
                type: 'text',
                text: `tool failed: ${error instanceof Error ? error.message : 'unknown error'}`,
              },
            ],
          };
        }
        await pending;
      }

      for (const hook of hooks.afterToolCall ?? []) {
        const decision = await hook({
          turnId: input.turnId,
          toolCallId: intent.toolCallId,
          toolName: intent.name,
          result,
        });
        if (decision.kind === 'replaceResult') {
          result = decision.result;
        }
      }

      await emit({
        type: 'tool.intent.completed',
        turnId: input.turnId,
        toolCallId: intent.toolCallId,
        name: intent.name,
        result,
      });

      completed.push({
        toolCallId: intent.toolCallId,
        name: intent.name,
        isError: result.isError,
      });

      messages.push({
        id: newId('message'),
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: intent.toolCallId,
            content: result.content,
            isError: result.isError,
          },
        ],
        createdAt: new Date().toISOString(),
        meta: { turnId: input.turnId, stepIndex },
      });
    }

    return { completed, blocked, messages };
  };

  /** Run the boundary hooks at the end of a step. */
  const runStepEnd = async (
    completed: readonly ToolCallSummary[],
    blocked: readonly BlockedToolCall[],
  ): Promise<void> => {
    for (const hook of hooks.onStepEnd ?? []) {
      await hook({
        turnId: input.turnId,
        stepIndex,
        completedToolCalls: completed,
        blockedToolCalls: blocked,
        usage,
        state: 'step-end',
        enqueueFollowUp: (followUp) => {
          followUps.push(followUp);
        },
      });
    }
  };

  try {
    await emit({
      type: 'turn.started',
      turnId: input.turnId,
      sessionId: input.sessionId,
      stepCount: 1,
    });

    let continueLoop = true;

    while (continueLoop) {
      stepIndex += 1;
      if (stepIndex > MAX_STEPS) {
        throw new TurnAborted(
          `the turn exceeded the step budget of ${MAX_STEPS} steps`,
        );
      }
      await emit({ type: 'step.started', turnId: input.turnId, stepIndex });

      const before = await runBeforeLlmCall(history);
      await flushMarkers(before);

      if (before.kind === 'abort') {
        throw new TurnAborted(before.abortReason ?? 'the turn was aborted');
      }

      if (before.kind === 'skip') {
        await runStepEnd([], []);
        continueLoop = followUps.length > 0;
        if (!continueLoop) break;
        followUps.length = 0;
        continue;
      }

      if (before.kind === 'respond') {
        const message: AgentMessage = {
          id: newId('message'),
          role: 'assistant',
          content: [{ type: 'text', text: before.respondText ?? '' }],
          createdAt: new Date().toISOString(),
          meta: {
            turnId: input.turnId,
            stepIndex,
            usage: ZERO_USAGE,
            providerId: input.model.providerId,
            model: input.model.model,
          },
        };
        await emit({
          type: 'message.completed',
          turnId: input.turnId,
          message,
          usage: ZERO_USAGE,
        });
        history.push(message);
        await persist(history, [message], false, 'flush');
        await runStepEnd([], []);
        break;
      }

      const projected = projectAgentMessagesForModel(before.requestMessages, {
        providerId: input.model.providerId,
        supportsThinking: input.model.thinking?.enabled ?? false,
        supportsImages: true,
      });

      const request: ProviderRequest = {
        model: input.model.model,
        messages: projected,
        tools: input.tools
          .list()
          .filter((tool) => tool.enabled)
          .map((tool) => ({
            name: tool.definition.name,
            description: tool.definition.description,
            schema: toJsonSchema(tool.definition.schema),
          })),
        maxOutputTokens: input.model.maxOutputTokens,
        signal,
      };

      const providerContext: ProviderCallContext = {
        attempt: 1,
        logicalCallId: `${input.turnId}:${stepIndex}`,
        firstEventTimeoutMs: DEFAULT_PROVIDER_TIMEOUTS.firstEventTimeoutMs,
        idleTimeoutMs: DEFAULT_PROVIDER_TIMEOUTS.idleTimeoutMs,
        totalTimeoutMs: DEFAULT_PROVIDER_TIMEOUTS.totalTimeoutMs,
      };

      providerCalled = true;
      await emit({ type: 'llm.request.started', turnId: input.turnId, attempt: 1 });

      const messageId = newId('message');
      let text = '';
      let thinking = '';
      let stepUsage: TokenUsage = ZERO_USAGE;
      const intents: ToolIntent[] = [];

      for await (const chunk of input.stream(request, providerContext)) {
        switch (chunk.kind) {
          case 'text':
            text += chunk.text;
            await emit({
              type: 'text.delta',
              turnId: input.turnId,
              messageId,
              text: chunk.text,
            });
            break;
          case 'thinking':
            thinking += chunk.text;
            await emit({
              type: 'thinking.delta',
              turnId: input.turnId,
              messageId,
              text: chunk.text,
            });
            break;
          case 'tool_call':
            intents.push({
              toolCallId: chunk.toolCallId,
              name: chunk.name,
              input: chunk.input,
            });
            break;
          case 'usage':
            stepUsage = chunk.usage;
            break;
          case 'done':
            break;
          default:
            break;
        }
      }

      usage = {
        inputTokens: usage.inputTokens + stepUsage.inputTokens,
        outputTokens: usage.outputTokens + stepUsage.outputTokens,
      };

      const afterDecision = await (async () => {
        for (const hook of hooks.afterLlmCall ?? []) {
          const decision = await hook({
            turnId: input.turnId,
            stepIndex,
            attempt: 1,
            usage: stepUsage,
            toolCallIds: intents.map((intent) => intent.toolCallId),
          });
          if (decision.kind !== 'continue') return decision;
        }
        return { kind: 'continue' } as const;
      })();

      if (afterDecision.kind === 'retry') {
        // The rejected response never becomes a completed message and never
        // enters the history; its tool intents are dropped with it.
        llmRetries += 1;
        if (llmRetries > MAX_LLM_RETRIES) {
          await runStepEnd([], []);
          followUps.length = 0;
          throw new TurnAborted(
            `the turn exceeded the LLM retry budget of ${MAX_LLM_RETRIES} retries`,
          );
        }
        followUps.push({ kind: 'retry', reason: afterDecision.reason });
        await runStepEnd([], []);
        followUps.length = 0;
        continue;
      }

      if (afterDecision.kind === 'fail') {
        // Un-executed tool intents are dropped and the loop stops at the
        // current step boundary. Follow-ups queued by the step-end hook are
        // not consumed.
        await runStepEnd([], []);
        followUps.length = 0;
        throw new TurnAborted(
          afterDecision.error?.message ?? afterDecision.reason ?? 'the LLM response was rejected',
        );
      }

      const content: ContentBlock[] = [];
      if (thinking.length > 0) content.push({ type: 'thinking', text: thinking });
      if (text.length > 0) content.push({ type: 'text', text });
      for (const intent of intents) {
        content.push({
          type: 'tool_use',
          toolCallId: intent.toolCallId,
          name: intent.name,
          input: intent.input,
        });
      }

      const message: AgentMessage = {
        id: messageId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        meta: {
          turnId: input.turnId,
          stepIndex,
          usage: stepUsage,
          providerId: input.model.providerId,
          model: input.model.model,
        },
      };

      await emit({
        type: 'message.completed',
        turnId: input.turnId,
        message,
        usage: stepUsage,
      });

      history.push(message);
      await persist(history, [message], false, 'flush');

      const toolOutcome = await executeTools(intents);

      if (toolOutcome.messages.length > 0) {
        history.push(...toolOutcome.messages);
        await persist(history, toolOutcome.messages, false, 'flush');
      }

      await runStepEnd(toolOutcome.completed, toolOutcome.blocked);

      // Another step runs when the model has to react to tool results, or
      // when a hook queued internal work. A blocked call counts: the model
      // has to be told that the call did not run.
      continueLoop =
        toolOutcome.completed.length > 0 ||
        toolOutcome.blocked.length > 0 ||
        followUps.length > 0;
      followUps.length = 0;
    }

    await emit({ type: 'turn.completed', turnId: input.turnId, stepCount: stepIndex });
    return { status: 'completed', events, usage };
  } catch (error: unknown) {
    const aborted = error instanceof TurnAborted;
    const ackFailed = error instanceof HookAcknowledgementFailed;
    terminalError = {
      code: ackFailed ? 'HOOK_ACK_FAILED' : aborted ? 'TURN_ABORTED' : 'TURN_FAILED',
      message: error instanceof Error ? error.message : 'the turn failed',
    };
    await emit({
      type: 'turn.failed',
      turnId: input.turnId,
      code: terminalError.code,
      reason: terminalError.message,
    });
    return {
      status: aborted ? 'aborted' : 'failed',
      events,
      usage,
      error: terminalError,
    };
  }
}
