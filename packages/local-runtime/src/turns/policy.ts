import type { AgentMessage, TokenUsage } from '@local-agent/protocol';
import type { ToolBinder } from '@local-agent/agent-core/tools';

/**
 * The turn policy.
 *
 * The host (the application layer) owns the policy: it decides whether a
 * submitted item runs now, waits or is dropped, and it may inject the
 * authoritative context of a turn. The loop asks, it does not decide.
 *
 * See docs/contracts.md §9.
 */

export type QueueItemKind = 'message' | 'plan-entry' | 'plan-review';

export interface QueueItem {
  readonly kind: QueueItemKind;
  readonly sessionId: string;
  readonly text?: string;
  /** The review request the item answers. */
  readonly requestId?: string;
}

export type QueueClassification =
  /** Run it now. */
  | 'run'
  /** Keep it queued until the fence clears. */
  | 'defer'
  /** Drop it: it is not valid anymore. */
  | 'cancel';

export interface TurnPolicy {
  classify(item: QueueItem): QueueClassification;
  /**
   * The authoritative context of the next turn.
   *
   * The returned messages are appended to the canonical history before the
   * turn starts, so they are part of the request **and** of the record.
   */
  prepareTurn?(sessionId: string, turnId: string): Promise<readonly AgentMessage[] | undefined>;
  /**
   * The tools of the turn.
   *
   * The plan mode uses it to take the execution tools away: the agent may
   * look around, but it may not change anything but the plan draft.
   */
  binderForTurn?(sessionId: string, turnId: string): ToolBinder | undefined;
  /**
   * Called when a turn of the session ended.
   *
   * The goal mode uses it to decide whether another round runs, whether the
   * goal pauses, or whether it is blocked.
   */
  afterTurn?(
    sessionId: string,
    turnId: string,
    outcome: {
      readonly usage: TokenUsage;
      readonly status: 'completed' | 'failed' | 'aborted';
    },
  ): Promise<void>;
}
