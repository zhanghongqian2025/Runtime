import { describe, expect, it } from 'vitest';
import { createTurnEventEmitter } from './bridge.js';

const sessionId = 'sess_abcdefghijklmnopqrstuvwxyz';
const turnId = 'turn_abcdefghijklmnopqrstuvwxyz';
const fixedNow = (): string => '2026-10-21T06:00:00.000Z';

const emitter = () => createTurnEventEmitter({ sessionId, turnId, now: fixedNow });

describe('turn event emitter', () => {
  it('assigns turn-scoped ids and sequence numbers', () => {
    const events = emitter();
    const first = events.emit({
      type: 'turn.started',
      turnId,
      sessionId,
      stepCount: 1,
    });
    expect(first?.seq).toBe(1);
    expect(first?.id).toBe(`${turnId}:1`);

    const second = events.emit({
      type: 'text.delta',
      turnId,
      messageId: 'msg_1',
      text: 'hi',
    });
    expect(second?.seq).toBe(2);
    expect(events.emittedCount).toBe(2);
  });

  it('maps the turn lifecycle onto session.status', () => {
    const events = emitter();
    const started = events.emit({ type: 'turn.started', turnId, sessionId, stepCount: 1 });
    expect(started?.type).toBe('session.status');
    if (started?.type === 'session.status') {
      expect(started.status).toBe('running');
    }

    const failed = events.emit({
      type: 'turn.failed',
      turnId,
      code: 'HOOK_ACK_FAILED',
      reason: 'a hook did not acknowledge',
    });
    if (failed?.type === 'session.status') {
      expect(failed.status).toBe('failed');
      expect(failed.error?.code).toBe('HOOK_ACK_FAILED');
    } else {
      expect.unreachable('expected a session.status event');
    }
  });

  it('does not spend a sequence number on internal-only events', () => {
    const events = emitter();
    const flushed = events.emit({ type: 'history.flushed', turnId, messageCount: 2 });
    expect(flushed).toBeUndefined();
    expect(events.emittedCount).toBe(0);
  });

  it('remembers the tool name and input for a started call', () => {
    const events = emitter();
    events.emit({
      type: 'tool.intent.created',
      turnId,
      toolCallId: 'tool_1',
      name: 'read',
      input: { path: 'a.txt' },
    });
    const started = events.emit({ type: 'tool.intent.started', turnId, toolCallId: 'tool_1' });
    expect(started).toMatchObject({
      type: 'tool.call.started',
      name: 'read',
      input: { path: 'a.txt' },
    });
  });

  it('publishes a blocked call instead of running it', () => {
    const events = emitter();
    const blocked = events.emit({
      type: 'tool.intent.blocked',
      turnId,
      toolCallId: 'tool_1',
      name: 'bash',
      blockedBy: 'permission',
      reason: 'command is not provably safe',
    });
    expect(blocked).toMatchObject({
      type: 'tool.call.blocked',
      blockedBy: 'permission',
      reason: 'command is not provably safe',
    });
  });
});
