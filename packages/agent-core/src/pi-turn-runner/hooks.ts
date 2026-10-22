import type {
  AgentMessage,
  ApprovalRequest,
  ApprovalResolution,
  RuntimeEventBody,
  TokenUsage,
  ToolResult,
} from '@local-agent/protocol';

/**
 * Hook contracts.
 *
 * The three hook families are deliberately different types, so the compiler
 * rejects mixing them up:
 *
 * - **decision pipeline** (`beforeLlmCall`, `afterLlmCall`, `beforeToolCall`,
 *   `afterToolCall`): hooks run in registration order and their return value
 *   participates in the decision. A failing hook fails the turn closed.
 * - **notification fan-out** (`onHistoryChanged`): hooks are awaited one by
 *   one. The resolved promise *is* the delivery acknowledgement: the history
 *   cursor only advances once every hook acknowledged.
 * - **boundary** (`onStepEnd`): hooks run in order at a step boundary, so two
 *   modules cannot race for the same boundary.
 *
 * See docs/contracts.md §3.
 */

/* ------------------------------------------------------------------ *
 * beforeLlmCall
 * ------------------------------------------------------------------ */

export type BeforeLlmCallDecision =
  /** Keep going. */
  | { readonly kind: 'continue' }
  /** Do not call the provider; end the step. */
  | { readonly kind: 'skip' }
  /** Replace the request-bound copy only; canonical history is untouched. */
  | { readonly kind: 'replaceRequestMessages'; readonly messages: readonly AgentMessage[] }
  /** Durably replace the canonical history. */
  | { readonly kind: 'replaceMessages'; readonly messages: readonly AgentMessage[] }
  /** Append a hidden typed custom message. Does not end the pipeline. */
  | { readonly kind: 'appendMessage'; readonly message: AgentMessage }
  /** Answer with a zero-usage assistant message without calling the provider. */
  | { readonly kind: 'respond'; readonly text: string; readonly verified: true }
  /** Stop the turn. */
  | { readonly kind: 'abort'; readonly reason: string };

export interface BeforeLlmCallContext {
  readonly turnId: string;
  readonly stepIndex: number;
  /**
   * Publish a host-side event on the session stream.
   *
   * The core assigns the envelope, so a hook can report what it does (a
   * compaction, for instance) without inventing a sequence number.
   */
  readonly publishEvent: (body: RuntimeEventBody) => Promise<void>;
  /** Physical attempt number of the upcoming provider call. */
  readonly attempt: number;
  /** Request-bound copy of the messages; replacing it does not touch history. */
  readonly requestMessages: readonly AgentMessage[];
  /** Markers accumulated by earlier hooks of the same pipeline. */
  readonly pendingMarkers: readonly AgentMessage[];
  /** True once a provider request has been made in this turn. */
  readonly providerCalled: boolean;
}

export type BeforeLlmCallHook = (
  context: BeforeLlmCallContext,
) => Promise<BeforeLlmCallDecision> | BeforeLlmCallDecision;

/* ------------------------------------------------------------------ *
 * afterLlmCall
 * ------------------------------------------------------------------ */

export type AfterLlmCallDecision =
  | { readonly kind: 'continue' }
  /** Retry inside the same product turn through the internal follow-up queue. */
  | { readonly kind: 'retry'; readonly reason: string }
  /** Terminate the loop at the current step boundary. */
  | { readonly kind: 'fail'; readonly reason: string; readonly error?: { code: string; message: string } };

export interface AfterLlmCallContext {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly usage: TokenUsage;
  /** Tool intents created by the response under review. */
  readonly toolCallIds: readonly string[];
}

export type AfterLlmCallHook = (
  context: AfterLlmCallContext,
) => Promise<AfterLlmCallDecision> | AfterLlmCallDecision;

/* ------------------------------------------------------------------ *
 * beforeToolCall / afterToolCall
 * ------------------------------------------------------------------ */

export type BeforeToolCallDecision =
  | { readonly kind: 'continue' }
  /**
   * Block the call. The permission layer blocks; it never executes.
   */
  | {
      readonly kind: 'block';
      readonly reason: string;
      readonly blockedBy?: 'permission' | 'policy' | 'extension';
    };

export interface BeforeToolCallContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /**
   * Ask the user for permission and wait for the answer.
   *
   * The core publishes `permission.requested` and `permission.resolved` on the
   * event stream; the host answers through the pending request it owns.
   */
  readonly requestApproval: (request: ApprovalRequest) => Promise<ApprovalResolution>;
  /** Publish a host-side event on the session stream. */
  readonly publishEvent: (body: RuntimeEventBody) => Promise<void>;
}

export type BeforeToolCallHook = (
  context: BeforeToolCallContext,
) => Promise<BeforeToolCallDecision> | BeforeToolCallDecision;

export type AfterToolCallDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'replaceResult'; readonly result: ToolResult };

export interface AfterToolCallContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
}

export type AfterToolCallHook = (
  context: AfterToolCallContext,
) => Promise<AfterToolCallDecision> | AfterToolCallDecision;

/* ------------------------------------------------------------------ *
 * onHistoryChanged (notification fan-out)
 * ------------------------------------------------------------------ */

export interface HistoryChangedContext {
  readonly turnId: string;
  /** The messages that were flushed. */
  readonly messages: readonly AgentMessage[];
  readonly reason: 'flush' | 'replace';
}

export type OnHistoryChangedHook = (
  context: HistoryChangedContext,
) => Promise<void> | void;

/* ------------------------------------------------------------------ *
 * onStepEnd (boundary)
 * ------------------------------------------------------------------ */

export interface ToolCallSummary {
  readonly toolCallId: string;
  readonly name: string;
  readonly isError: boolean;
}

/** A blocked tool call. Read-only: a blocked call has no executable handle. */
export interface BlockedToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly blockedBy: string;
  readonly reason: string;
}

/**
 * Internal work queued for the next step.
 *
 * A step-end hook may queue steering; a rejected LLM response queues a
 * retry. The queue is internal: it never becomes a hidden prompt and never
 * enters the canonical history.
 */
export interface FollowUp {
  readonly kind: 'steer' | 'retry';
  readonly reason?: string;
}

export interface StepEndContext {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly completedToolCalls: readonly ToolCallSummary[];
  readonly blockedToolCalls: readonly BlockedToolCall[];
  readonly usage: TokenUsage;
  readonly state: 'step-end';
  /** Queue internal work for the next step. */
  readonly enqueueFollowUp: (followUp: FollowUp) => void;
}

export type OnStepEndHook = (context: StepEndContext) => Promise<void> | void;

/* ------------------------------------------------------------------ *
 * Hook registry
 * ------------------------------------------------------------------ */

export interface TurnHooks {
  readonly beforeLlmCall?: readonly BeforeLlmCallHook[];
  readonly afterLlmCall?: readonly AfterLlmCallHook[];
  readonly beforeToolCall?: readonly BeforeToolCallHook[];
  readonly afterToolCall?: readonly AfterToolCallHook[];
  readonly onHistoryChanged?: readonly OnHistoryChangedHook[];
  readonly onStepEnd?: readonly OnStepEndHook[];
}

/** The three hook families, used by the runner to pick the right semantics. */
export const HOOK_CATEGORY = {
  beforeLlmCall: 'decision-pipeline',
  afterLlmCall: 'decision-pipeline',
  beforeToolCall: 'decision-pipeline',
  afterToolCall: 'decision-pipeline',
  onHistoryChanged: 'notification-fan-out',
  onStepEnd: 'boundary',
} as const satisfies Readonly<Record<keyof TurnHooks, string>>;

export type HookCategory = (typeof HOOK_CATEGORY)[keyof typeof HOOK_CATEGORY];

/* ------------------------------------------------------------------ *
 * Decision validation
 * ------------------------------------------------------------------ */

/**
 * `appendMessage` only accepts a hidden typed custom message.
 *
 * Anything else is rejected: the decision is treated as `continue` and the
 * rejection is recorded, so a buggy extension cannot smuggle arbitrary
 * structures into the canonical history.
 */
export function isAppendMessageAllowed(message: AgentMessage): boolean {
  if (message.content.length === 0) return false;
  return message.content.every(
    (block) => block.type === 'custom' && block.hidden === true,
  );
}

/**
 * `respond` is only allowed for a host-verified, non-empty text, and never
 * after a provider call has already happened in the same turn.
 */
export function isRespondAllowed(
  decision: { readonly kind: 'respond'; readonly text: string; readonly verified: true },
  context: Pick<BeforeLlmCallContext, 'providerCalled'>,
): boolean {
  if (decision.text.trim().length === 0) return false;
  if (decision.verified !== true) return false;
  return context.providerCalled === false;
}
