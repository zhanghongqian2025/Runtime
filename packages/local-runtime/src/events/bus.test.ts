import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '@local-agent/protocol';
import { createEventBus } from './bus.js';
import { createFileEventLog } from '../sessions/event-log.js';

const draft = (text: string): RuntimeEventDraft => ({
  id: 'turn_1:1',
  seq: 1,
  sessionId: 'sess_1',
  turnId: 'turn_1',
  ts: '2026-10-21T06:00:00.000Z',
  type: 'message.delta',
  messageId: 'msg_1',
  text,
});

describe('the event bus', () => {
  it('assigns the session-scoped offsets', () => {
    const bus = createEventBus({ retainCount: 100 });
    const first = bus.publish('sess_1', draft('a'));
    const second = bus.publish('sess_1', draft('b'));

    expect(first.logOffset).toBe(1);
    expect(second.logOffset).toBe(2);
    expect(bus.latestOffset('sess_1')).toBe(2);
  });

  it('continues the offsets of the durable log after a restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-bus-'));
    const log = createFileEventLog({ dataDir, retainCount: 100 });

    const first = createEventBus({ retainCount: 100, log });
    first.publish('sess_1', draft('a'));
    first.publish('sess_1', draft('b'));

    // A new bus over the same log: the runtime restarted.
    const second = createEventBus({ retainCount: 100, log });
    expect(second.latestOffset('sess_1')).toBe(2);

    const published = second.publish('sess_1', draft('c'));
    expect(published.logOffset).toBe(3);
  });

  it('replays the events of a previous run', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-bus-'));
    const log = createFileEventLog({ dataDir, retainCount: 100 });

    const first = createEventBus({ retainCount: 100, log });
    first.publish('sess_1', draft('a'));
    first.publish('sess_1', draft('b'));

    const second = createEventBus({ retainCount: 100, log });
    const replayed = second.read('sess_1', 0);
    expect(replayed.map((event) => event.logOffset)).toEqual([1, 2]);
    expect(second.read('sess_1', 1).map((event) => event.logOffset)).toEqual([2]);
  });
});
