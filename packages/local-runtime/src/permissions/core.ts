import type {
  ApprovalChoice,
  ApprovalRequest,
  ApprovalResolution,
} from '@local-agent/protocol';
import type { RiskLevel } from '@local-agent/protocol';
import type {
  PermissionCore,
  PermissionDecision,
  PermissionQuery,
  SessionRule,
} from '@local-agent/agent-core/tools';
import { decidePermission } from './policy.js';
import type { NormalizedCall } from './types.js';

/**
 * The permission service.
 *
 * It owns the deterministic policy, the session rules granted by the user and
 * the pending approval requests. It **never executes a tool**: the only thing
 * it does to a call is decide whether it may run.
 */

export interface PermissionService extends PermissionCore {
  /** The mode the service decides with. */
  readonly mode: PermissionMode;
  /**
   * Registers a tool of the host (the goal tools, for instance).
   *
   * A tool nobody registered is denied: the policy only approves what it
   * knows.
   */
  registerTool(name: string, risk: RiskLevel): void;
  /** Ask the user and wait for the answer. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResolution>;
  /** Grant a rule for the rest of the session. */
  grantSessionRule(sessionId: string, rule: SessionRule): void;
  /** The ids of the approvals waiting for an answer. */
  pending(): readonly string[];
}

export type PermissionMode = 'ask' | 'auto' | 'full-access';

export interface PermissionServiceOptions {
  readonly mode: PermissionMode;
  /**
   * The shared registry of the host tools.
   *
   * It is shared by every session, so a tool the application registers once
   * is known to all of them.
   */
  readonly toolRisks?: Map<string, RiskLevel>;
}

const asRecord = (input: unknown): Record<string, unknown> | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;

const stringField = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
};

/** Rebuild the normalized call from a decision query. */
export function callFromQuery(query: PermissionQuery): NormalizedCall {
  const record = asRecord(query.normalizedInput);
  return {
    toolName: query.toolName,
    input: query.normalizedInput,
    ...(stringField(record, 'command') === undefined
      ? {}
      : { command: stringField(record, 'command') as string }),
    ...(stringField(record, 'path') === undefined
      ? {}
      : { path: stringField(record, 'path') as string }),
  };
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const rules = new Map<string, SessionRule[]>();
  const pending = new Map<string, (resolution: ApprovalResolution) => void>();
  const toolRisks = options.toolRisks ?? new Map<string, RiskLevel>();

  return {
    mode: options.mode,

    decide(query: PermissionQuery): PermissionDecision {
      return decidePermission(callFromQuery(query), {
        mode: query.mode,
        sessionRules: query.sessionRules,
        cwd: query.cwd,
        toolRisks,
      });
    },

    registerTool(name: string, risk: RiskLevel): void {
      toolRisks.set(name, risk);
    },

    requestApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
      return new Promise<ApprovalResolution>((resolve) => {
        pending.set(request.requestId, resolve);
      });
    },

    resolveApproval(requestId: string, choice: ApprovalChoice): void {
      const resolvePending = pending.get(requestId);
      if (!resolvePending) return;
      pending.delete(requestId);
      resolvePending({ requestId, choice, decidedBy: 'user' });
    },

    listSessionRules(sessionId: string): readonly SessionRule[] {
      return rules.get(sessionId) ?? [];
    },

    grantSessionRule(sessionId: string, rule: SessionRule): void {
      const existing = rules.get(sessionId) ?? [];
      rules.set(sessionId, [...existing, rule]);
    },

    pending(): readonly string[] {
      return [...pending.keys()];
    },
  };
}
