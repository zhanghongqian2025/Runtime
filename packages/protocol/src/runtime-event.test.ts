import { describe, expect, it } from 'vitest';
import { assignLogOffset, RuntimeEventSchema } from './runtime-event.js';

const draft = {
  id: 'turn_abcdefghijklmnopqrstuvwxyz:1',
  seq: 1,
  sessionId: 'sess_abcdefghijklmnopqrstuvwxyz',
  turnId: 'turn_abcdefghijklmnopqrstuvwxyz',
  ts: '2026-10-21T06:00:00.000Z',
  type: 'message.delta',
  messageId: 'msg_1',
  text: 'hi',
} as const;

describe('RuntimeEvent', () => {
  it('requires the full envelope', () => {
    expect(RuntimeEventSchema.safeParse(draft).success).toBe(false);
  });

  it('rejects unknown payload fields', () => {
    const result = RuntimeEventSchema.safeParse({ ...draft, logOffset: 1, surprise: true });
    expect(result.success).toBe(false);
  });

  it('assigns the session-scoped offset without changing the payload', () => {
    const event = assignLogOffset(draft, 12);
    expect(event.logOffset).toBe(12);
    expect(event.seq).toBe(1);
    expect(event.type).toBe('message.delta');
  });

  it('refuses a negative offset', () => {
    expect(() => assignLogOffset(draft, -1)).toThrow();
  });

  it('carries a structured error on a terminal status', () => {
    const event = assignLogOffset(
      {
        id: 'turn_abcdefghijklmnopqrstuvwxyz:2',
        seq: 2,
        sessionId: 'sess_abcdefghijklmnopqrstuvwxyz',
        turnId: 'turn_abcdefghijklmnopqrstuvwxyz',
        ts: '2026-10-21T06:00:01.000Z',
        type: 'session.status',
        status: 'failed',
        error: { code: 'HOOK_ACK_FAILED', message: 'a hook did not acknowledge' },
      },
      2,
    );
    expect(event.type).toBe('session.status');
    if (event.type === 'session.status') {
      expect(event.status).toBe('failed');
      expect(event.error?.code).toBe('HOOK_ACK_FAILED');
    }
  });
});
