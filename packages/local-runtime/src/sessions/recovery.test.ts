import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiskSessionStore, sessionPaths } from './disk-store.js';
import { createJournal } from './journal.js';
import { recoverSessions } from './recovery.js';

const workspace = (): string => mkdtempSync(join(tmpdir(), 'local-agent-recovery-'));

describe('crash recovery', () => {
  it('drops the half line a crash left in an append-only file', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });
    const paths = sessionPaths(dataDir, session.id);

    store.appendHistory(session.id, [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'one' }], createdAt: '2026-10-21T06:00:00.000Z' },
    ]);
    // A crash in the middle of an append.
    appendFileSync(paths.history, '{"id":"m2","role":"user","cont', 'utf8');

    const report = recoverSessions(dataDir);
    expect(report.repairedFiles).toBeGreaterThan(0);

    const raw = readFileSync(paths.history, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).toContain('m1');
    expect(raw).not.toContain('m2');
  });

  it('marks a turn that was still running as interrupted', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.appendTurn(session.id, {
      turnId: 'turn_1',
      startedAt: '2026-10-21T06:00:00.000Z',
      status: 'running',
      toolCalls: [{ toolCallId: 'tool_1', name: 'read', status: 'started' }],
    });

    const report = recoverSessions(dataDir);
    expect(report.interruptedTurns).toBe(1);

    const turns = store.readTurns(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('interrupted');
    // The tool call state is kept, so a resume never repeats it blindly.
    expect(turns[0]?.toolCalls).toHaveLength(1);
  });

  it('rolls back a transaction that was never committed', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });
    const paths = sessionPaths(dataDir, session.id);

    const original = {
      id: 'm1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'one' }],
      createdAt: '2026-10-21T06:00:00.000Z',
    };
    store.appendHistory(session.id, [original]);

    // A compaction that started, wrote its checkpoint and then died before
    // it could commit the replacement.
    store.writeCheckpoint(session.id, 'ckpt_1', [original]);
    writeFileSync(
      paths.history,
      `${JSON.stringify({ ...original, id: 'm2' })}\n`,
      'utf8',
    );

    const journal = createJournal({ filePath: paths.journal });
    journal.append({
      txId: 'tx_1',
      kind: 'compaction',
      state: 'begin',
      ts: '2026-10-21T06:00:00.000Z',
      before: { checkpointId: 'ckpt_1' },
    });

    const report = recoverSessions(dataDir);
    expect(report.rolledBackTransactions).toBe(1);

    // The history is back to the checkpointed state.
    const history = store.readHistory(session.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe('m1');
  });

  it('closes a tool call that the interrupted turn never answered', () => {
    const dataDir = workspace();
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({ cwd: '/workspace', providerId: 'openai-compatible', model: 'm' });

    store.appendHistory(session.id, [
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'read a.md' }],
        createdAt: '2026-10-21T06:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'tool_use', toolCallId: 'call_1', name: 'read', input: { path: 'a.md' } }],
        createdAt: '2026-10-21T06:00:01.000Z',
      },
    ]);
    store.appendTurn(session.id, {
      turnId: 'turn_1',
      startedAt: '2026-10-21T06:00:00.000Z',
      status: 'running',
      toolCalls: [{ toolCallId: 'call_1', name: 'read', status: 'started' }],
    });

    const report = recoverSessions(dataDir);
    expect(report.interruptedTurns).toBe(1);
    expect(report.repairedToolCalls).toBe(1);

    // A history with an unanswered tool call is malformed: a provider may
    // answer it with an empty completion, and the session looks alive while
    // every request silently does nothing.
    const history = store.readHistory(session.id);
    expect(history).toHaveLength(3);
    expect(history[2]?.role).toBe('tool');
    const block = history[2]?.content[0];
    expect(block?.type).toBe('tool_result');
  });

  it('does nothing for an empty data directory', () => {
    const dataDir = workspace();
    const report = recoverSessions(dataDir);
    expect(report.sessions).toBe(0);
  });

  it('creates the session directory layout on recovery', () => {
    const dataDir = workspace();
    mkdirSync(join(dataDir, 'sessions', 'sess_manual'), { recursive: true });
    writeFileSync(
      join(dataDir, 'sessions', 'sess_manual', 'meta.json'),
      JSON.stringify({
        id: 'sess_manual',
        title: 'manual',
        cwd: '/workspace',
        createdAt: '2026-10-21T06:00:00.000Z',
        updatedAt: '2026-10-21T06:00:00.000Z',
        interactionMode: 'default',
        status: 'idle',
        providerId: 'openai-compatible',
        model: 'm',
      }),
      'utf8',
    );

    const report = recoverSessions(dataDir);
    expect(report.sessions).toBe(1);
  });
});
