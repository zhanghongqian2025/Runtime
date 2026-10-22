import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@local-agent/protocol';
import { createDiskSessionStore, sessionPaths } from './disk-store.js';

const workspace = (): string => mkdtempSync(join(tmpdir(), 'local-agent-store-'));

const message = (id: string, role: 'user' | 'assistant', turnId?: string): AgentMessage => ({
  id,
  role,
  content: [{ type: 'text', text: id }],
  createdAt: '2026-10-21T06:00:00.000Z',
  ...(turnId === undefined ? {} : { meta: { turnId } }),
});

describe('the disk session store', () => {
  it('creates a session and reads it back', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    expect(store.get(session.id)?.id).toBe(session.id);
    expect(store.list()).toHaveLength(1);
    expect(existsSync(join(dataDir, 'sessions', session.id, 'meta.json'))).toBe(true);
  });

  it('appends the history one line per message', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.appendHistory(session.id, [message('m1', 'user', 'turn_1')]);
    store.appendHistory(session.id, [message('m2', 'assistant', 'turn_1')]);

    expect(store.readHistory(session.id).map((entry) => entry.id)).toEqual(['m1', 'm2']);
    const raw = readFileSync(sessionPaths(dataDir, session.id).history, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('replaces the history atomically', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.appendHistory(session.id, [message('m1', 'user')]);
    store.replaceHistory(session.id, [message('m9', 'user')]);

    expect(store.readHistory(session.id).map((entry) => entry.id)).toEqual(['m9']);
  });

  it('forks the session up to a message', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });
    store.appendHistory(session.id, [
      message('m1', 'user', 'turn_1'),
      message('m2', 'assistant', 'turn_1'),
      message('m3', 'user', 'turn_2'),
    ]);

    const forked = store.fork(session.id, { fromMessageId: 'm1' });
    expect(forked).toBeDefined();
    expect(forked?.id).not.toBe(session.id);
    expect(store.readHistory(forked?.id ?? '').map((entry) => entry.id)).toEqual(['m1']);
    // The original is untouched.
    expect(store.readHistory(session.id)).toHaveLength(3);
  });

  it('rewinds the session to a point', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });
    store.appendHistory(session.id, [
      message('m1', 'user', 'turn_1'),
      message('m2', 'assistant', 'turn_1'),
      message('m3', 'user', 'turn_2'),
    ]);

    const rewound = store.rewind(session.id, { toTurnId: 'turn_1', resend: 'again' });
    expect(rewound).toBeDefined();
    // The rewind cuts the history; the resent message is added by the turn
    // system, so it is stored exactly once.
    expect(store.readHistory(session.id).map((entry) => entry.id)).toEqual(['m1', 'm2']);
  });

  it('keeps the last turn record', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.appendTurn(session.id, {
      turnId: 'turn_1',
      startedAt: '2026-10-21T06:00:00.000Z',
      status: 'running',
      toolCalls: [],
    });
    store.appendTurn(session.id, {
      turnId: 'turn_1',
      startedAt: '2026-10-21T06:00:00.000Z',
      status: 'completed',
      toolCalls: [{ toolCallId: 'tool_1', name: 'read', status: 'completed' }],
    });

    const turns = store.readTurns(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('completed');
    expect(turns[0]?.toolCalls).toHaveLength(1);
  });

  it('stores and reads the checkpoints', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.writeCheckpoint(session.id, 'ckpt_1', [message('m1', 'user')]);
    expect(store.listCheckpoints(session.id)).toEqual(['ckpt_1']);
    expect(store.readCheckpoint(session.id, 'ckpt_1').map((entry) => entry.id)).toEqual(['m1']);
  });

  it('survives a new store instance over the same directory', () => {
    const dataDir = workspace();
    const first = createDiskSessionStore({ dataDir });
    const session = first.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });
    first.appendHistory(session.id, [message('m1', 'user')]);

    const second = createDiskSessionStore({ dataDir });
    expect(second.get(session.id)?.title).toBe(session.title);
    expect(second.readHistory(session.id).map((entry) => entry.id)).toEqual(['m1']);
  });

  it('deletes a session and its files', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    expect(store.delete(session.id)).toBe(true);
    expect(store.get(session.id)).toBeUndefined();
    expect(existsSync(join(dataDir, 'sessions', session.id))).toBe(false);
  });
});
