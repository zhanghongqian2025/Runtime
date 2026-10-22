import type { RuntimeEvent, RuntimeEventBody, RuntimeEventDraft } from '@local-agent/protocol';
import { assignLogOffset } from '@local-agent/protocol';
import type { SessionEventLog } from '../sessions/event-log.js';
import { RETAINED_EVENT_TYPES, type EventDelivery } from './types.js';

/**
 * The session event bus.
 *
 * Every published event gets the next session-scoped offset, so a client that
 * reconnects with `after=<offset>` receives exactly the events it missed.
 * The buffer rotates, but the key events (status, approvals, questions,
 * compaction, goal) survive the rotation.
 */

export interface EventBusOptions {
  /** Events kept per session before the oldest ones are dropped. */
  readonly retainCount: number;
  /** The durable log. When present the events survive a restart. */
  readonly log?: SessionEventLog;
}

interface SessionLog {
  readonly events: RuntimeEvent[];
  nextOffset: number;
  readonly listeners: Set<(event: RuntimeEvent) => void>;
}

export function createEventBus(options: EventBusOptions): EventDelivery {
  const logs = new Map<string, SessionLog>();

  const logFor = (sessionId: string): SessionLog => {
    const existing = logs.get(sessionId);
    if (existing) return existing;
    // A restarted runtime continues the offsets of the durable log.
    const resumed = options.log?.latestOffset(sessionId) ?? 0;
    const created: SessionLog = {
      events: [],
      nextOffset: resumed + 1,
      listeners: new Set(),
    };
    logs.set(sessionId, created);
    return created;
  };

  const rotate = (log: SessionLog): void => {
    if (log.events.length <= options.retainCount) return;
    const keep: RuntimeEvent[] = [];
    const dropCount = log.events.length - options.retainCount;
    for (let index = 0; index < log.events.length; index += 1) {
      const event = log.events[index] as RuntimeEvent;
      if (index < dropCount && !RETAINED_EVENT_TYPES.has(event.type)) continue;
      keep.push(event);
    }
    log.events.length = 0;
    log.events.push(...keep);
  };

  return {
    publish(sessionId: string, draft: RuntimeEventDraft): RuntimeEvent {
      const log = logFor(sessionId);
      const event = assignLogOffset(draft, log.nextOffset);
      log.nextOffset += 1;
      log.events.push(event);
      rotate(log);
      options.log?.append(sessionId, event);
      for (const listener of log.listeners) {
        listener(event);
      }
      return event;
    },

    /**
     * Publish an event that happens **outside** a turn.
     *
     * A turn-less event has no turn-scoped sequence number, so it uses the
     * session-scoped offset for both (docs/contracts.md §2.4).
     */
    publishHost(sessionId: string, body: RuntimeEventBody): RuntimeEvent {
      const log = logFor(sessionId);
      const offset = log.nextOffset;
      const event: RuntimeEvent = {
        ...(body as Record<string, unknown>),
        id: `host:${offset}`,
        seq: offset,
        logOffset: offset,
        sessionId,
        turnId: null,
        ts: new Date().toISOString(),
      } as RuntimeEvent;
      log.nextOffset += 1;
      log.events.push(event);
      rotate(log);
      options.log?.append(sessionId, event);
      for (const listener of log.listeners) {
        listener(event);
      }
      return event;
    },

    read(sessionId: string, after: number): readonly RuntimeEvent[] {
      const log = logs.get(sessionId);
      const memory = log ? log.events : [];
      const durable = options.log?.read(sessionId, after, 1000) ?? [];

      // The durable log is the authority; the memory buffer is the fast path.
      const byOffset = new Map<number, RuntimeEvent>();
      for (const event of memory) {
        if (event.logOffset > after) byOffset.set(event.logOffset, event);
      }
      for (const event of durable) {
        if (event.logOffset > after) byOffset.set(event.logOffset, event);
      }
      return [...byOffset.values()].sort((left, right) => left.logOffset - right.logOffset);
    },

    subscribe(sessionId: string, listener: (event: RuntimeEvent) => void): () => void {
      const log = logFor(sessionId);
      log.listeners.add(listener);
      return () => {
        log.listeners.delete(listener);
      };
    },

    latestOffset(sessionId: string): number {
      const log = logs.get(sessionId);
      const memory = log ? log.nextOffset - 1 : 0;
      // After a restart the memory buffer is empty but the durable log is not.
      const durable = options.log?.latestOffset(sessionId) ?? 0;
      return Math.max(memory, durable);
    },

    oldestOffset(sessionId: string): number {
      const log = logs.get(sessionId);
      const first = log?.events[0];
      return first ? first.logOffset : 0;
    },
  };
}
