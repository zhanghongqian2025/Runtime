import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@local-agent/protocol';
import {
  computeContextBudget,
  estimateMessagesTokens,
  estimateTokens,
  trimHistory,
} from '@local-agent/agent-core/pi-turn-runner';
import { createDiskSessionStore } from './disk-store.js';
import { compactSession, MIN_SAVED_RATIO } from './compaction.js';
import { createJournal } from './journal.js';
import { sessionPaths } from './disk-store.js';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const toolMessage = (id: string, size: number): AgentMessage => ({
  id,
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId: `tool_${id}`,
      content: [{ type: 'text', text: 'x'.repeat(size) }],
      isError: false,
    },
  ],
  createdAt: '2026-10-21T06:00:00.000Z',
  meta: { turnId: 'turn_1' },
});

const userMessage = (id: string): AgentMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: id }],
  createdAt: '2026-10-21T06:00:00.000Z',
  meta: { turnId: 'turn_1' },
});

describe('the token estimate and the budget', () => {
  it('estimates four bytes per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });

  it('reserves the whole output budget before compacting', () => {
    const budget = computeContextBudget({
      contextWindowTokens: 100_000,
      maxOutputTokens: 32_000,
    });
    expect(budget.outputBudget).toBe(25_000);
    // The watermark leaves room for the whole answer: the history plus the
    // answer still fits in the window.
    expect(budget.compactWatermark + budget.outputBudget).toBeLessThanOrEqual(100_000);
    expect(budget.compactWatermark).toBe(100_000 - 25_000 - 2048);
  });
});

describe('trimming', () => {
  it('keeps the head and the tail untouched', () => {
    const messages = [userMessage('head'), toolMessage('a', 100_000), userMessage('tail')];
    const trimmed = trimHistory(messages, {
      keepHeadMessages: 1,
      keepTailMessages: 1,
      keepToolHeadBytes: 100,
      keepToolTailBytes: 50,
      targetTokens: 0,
    });

    expect(trimmed.messages[0]?.id).toBe('head');
    expect(trimmed.messages.at(-1)?.id).toBe('tail');
    expect(trimmed.afterTokens).toBeLessThan(trimmed.beforeTokens);
  });

  it('keeps the parallel results of a round together', () => {
    const messages: AgentMessage[] = [
      userMessage('head'),
      {
        id: 'assistant',
        role: 'assistant',
        content: [
          { type: 'tool_use', toolCallId: 't1', name: 'read', input: {} },
          { type: 'tool_use', toolCallId: 't2', name: 'read', input: {} },
        ],
        createdAt: '2026-10-21T06:00:00.000Z',
        meta: { turnId: 'turn_1' },
      },
      toolMessage('r1', 40_000),
      toolMessage('r2', 40_000),
      userMessage('tail'),
    ];

    const trimmed = trimHistory(messages, {
      keepHeadMessages: 1,
      keepTailMessages: 1,
      keepToolHeadBytes: 50,
      keepToolTailBytes: 50,
      targetTokens: 200,
    });

    const ids = trimmed.messages.map((entry) => entry.id);
    // The two results of the round are either both there or both gone.
    expect(ids.includes('r1')).toBe(ids.includes('r2'));
  });
});

describe('compacting a session', () => {
  const setup = (): { dataDir: string; sessionId: string } => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-compact-'));
    const store = createDiskSessionStore({ dataDir });
    const session = store.create({
      cwd: '/workspace',
      providerId: 'openai-compatible',
      model: 'm',
    });
    return { dataDir, sessionId: session.id };
  };

  it('leaves a small history alone', async () => {
    const { dataDir, sessionId } = setup();
    const store = createDiskSessionStore({ dataDir });
    store.appendHistory(sessionId, [userMessage('m1')]);

    const outcome = await compactSession(sessionId, {
      sessions: store,
      logger: quietLogger,
      model: { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
    });

    expect(outcome.compacted).toBe(false);
    expect(store.readHistory(sessionId)).toHaveLength(1);
  });

  it('compacts a huge history, saves the checkpoint and replaces the history', async () => {
    const { dataDir, sessionId } = setup();
    const store = createDiskSessionStore({ dataDir });
    for (let index = 0; index < 12; index += 1) {
      store.appendHistory(sessionId, [toolMessage(`m${index}`, 40_000)]);
    }

    const before = estimateMessagesTokens(store.readHistory(sessionId));
    const outcome = await compactSession(sessionId, {
      sessions: store,
      logger: quietLogger,
      model: { contextWindowTokens: 20_000, maxOutputTokens: 4_000 },
    });

    expect(outcome.compacted).toBe(true);
    expect(outcome.savedRatio).toBeGreaterThanOrEqual(MIN_SAVED_RATIO);
    expect(outcome.beforeTokens).toBe(before);

    // The checkpoint holds the history as it was.
    const checkpoints = store.listCheckpoints(sessionId);
    expect(checkpoints).toHaveLength(1);
    expect(store.readCheckpoint(sessionId, checkpoints[0] ?? '')).toHaveLength(12);

    // The history was replaced by the compacted one.
    const after = estimateMessagesTokens(store.readHistory(sessionId));
    expect(after).toBeLessThan(before * 0.3);
  });

  it('keeps the task list, which lives outside the history', async () => {
    const { dataDir, sessionId } = setup();
    const store = createDiskSessionStore({ dataDir });
    for (let index = 0; index < 12; index += 1) {
      store.appendHistory(sessionId, [toolMessage(`m${index}`, 40_000)]);
    }
    store.appendTurn(sessionId, {
      turnId: 'turn_1',
      startedAt: '2026-10-21T06:00:00.000Z',
      status: 'running',
      toolCalls: [{ toolCallId: 'tool_1', name: 'read', status: 'completed' }],
    });

    await compactSession(sessionId, {
      sessions: store,
      logger: quietLogger,
      model: { contextWindowTokens: 20_000, maxOutputTokens: 4_000 },
    });

    // The parallel task state is not part of the history, so it survives.
    expect(store.readTurns(sessionId)[0]?.toolCalls).toHaveLength(1);
  });

  it('reports a compaction that cannot save enough and leaves the history alone', async () => {
    const { dataDir, sessionId } = setup();
    const store = createDiskSessionStore({ dataDir });
    store.appendHistory(sessionId, [userMessage('m1'), userMessage('m2')]);

    const outcome = await compactSession(sessionId, {
      sessions: store,
      logger: quietLogger,
      // A window so small that even an aggressive trim cannot save 70%.
      model: { contextWindowTokens: 1_024, maxOutputTokens: 256 },
    });

    expect(outcome.compacted).toBe(false);
    expect(outcome.savedRatio).toBeLessThan(MIN_SAVED_RATIO);
    expect(store.readHistory(sessionId)).toHaveLength(2);
  });

  it('writes the transaction to the journal', async () => {
    const { dataDir, sessionId } = setup();
    const store = createDiskSessionStore({ dataDir });
    for (let index = 0; index < 12; index += 1) {
      store.appendHistory(sessionId, [toolMessage(`m${index}`, 40_000)]);
    }

    const journal = createJournal({
      filePath: sessionPaths(dataDir, sessionId).journal,
    });
    await compactSession(sessionId, {
      sessions: store,
      logger: quietLogger,
      model: { contextWindowTokens: 20_000, maxOutputTokens: 4_000 },
      journal,
    });

    expect(journal.pending()).toHaveLength(0);
  });
});
