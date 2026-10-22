import type { RuntimeEvent, RuntimeEventBody, RuntimeEventDraft } from '@local-agent/protocol';

/**
 * Event delivery.
 *
 * The host owns the session event log: it assigns the session-scoped
 * `logOffset` that an SSE client resumes on, keeps a bounded buffer for
 * reconnects and fans the events out to the live subscribers.
 */
export interface EventDelivery {
  /** Append a wire event to the session log and publish it. */
  publish(sessionId: string, draft: RuntimeEventDraft): RuntimeEvent;
  /** Publish an event that happens outside a turn (the plan mode, for instance). */
  publishHost(sessionId: string, body: RuntimeEventBody): RuntimeEvent;
  /** Read the buffered events with an offset greater than `after`. */
  read(sessionId: string, after: number): readonly RuntimeEvent[];
  /** Subscribe to the live events of a session. Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void): () => void;
  /** The highest offset written for a session. */
  latestOffset(sessionId: string): number;
  /** The lowest offset still available in the buffer. */
  oldestOffset(sessionId: string): number;
}

/** Events that are kept even when the buffer rotates. */
export const RETAINED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.status',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'context.compaction.started',
  'context.compaction.completed',
  'goal.updated',
]);
