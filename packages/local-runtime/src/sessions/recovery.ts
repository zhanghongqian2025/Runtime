import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createJournal, type JournalRecord } from './journal.js';
import { readJsonLines, writeFileAtomic } from './files.js';
import { sessionPaths } from './disk-store.js';
import { repairDanglingToolCalls } from './history-repair.js';
import type { AgentMessage } from '@local-agent/protocol';
import type { TurnRecord } from './types.js';

/**
 * Crash recovery.
 *
 * A process that dies mid-write can leave a half line in an append-only file
 * and a transaction without a commit. On startup both are repaired:
 *
 * - a half line is dropped and the file is rewritten;
 * - a transaction without a commit is rolled back;
 * - a turn that was still running is marked as interrupted, so it is never
 *   resumed silently: its tool calls are not replayed.
 */

export interface RecoveryReport {
  readonly sessions: number;
  readonly repairedFiles: number;
  readonly rolledBackTransactions: number;
  readonly interruptedTurns: number;
  /** Tool calls that were closed because their turn never finished. */
  readonly repairedToolCalls: number;
}

const repairJsonl = (path: string): number => {
  if (!existsSync(path)) return 0;
  const { records, dropped } = readJsonLines<unknown>(path);
  if (dropped === 0) return 0;
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileAtomic(path, content.length > 0 ? `${content}\n` : '');
  return dropped;
};

export function recoverSessions(dataDir: string): RecoveryReport {
  const root = join(dataDir, 'sessions');
  if (!existsSync(root)) {
    return {
      sessions: 0,
      repairedFiles: 0,
      rolledBackTransactions: 0,
      interruptedTurns: 0,
      repairedToolCalls: 0,
    };
  }

  let sessions = 0;
  let repairedFiles = 0;
  let rolledBackTransactions = 0;
  let interruptedTurns = 0;
  let repairedToolCalls = 0;

  for (const entry of readdirSync(root)) {
    const paths = sessionPaths(dataDir, entry);
    if (!existsSync(paths.meta)) continue;
    sessions += 1;

    repairedFiles += repairJsonl(paths.history);
    repairedFiles += repairJsonl(paths.turns);
    repairedFiles += repairJsonl(paths.events);

    // 1. Roll back the transactions that were never committed.
    const journal = createJournal({ filePath: paths.journal });
    for (const transaction of journal.pending()) {
      rolledBackTransactions += 1;
      rollbackTransaction(paths, transaction);
      journal.markRolledBack(transaction.txId);
    }

    // 2. Mark the turns that were still running as interrupted.
    const { records } = readJsonLines<TurnRecord>(paths.turns);
    const byTurn = new Map<string, TurnRecord>();
    for (const record of records) byTurn.set(record.turnId, record);

    for (const record of byTurn.values()) {
      if (record.status !== 'running') continue;
      interruptedTurns += 1;
      const updated: TurnRecord = { ...record, status: 'interrupted' };
      appendFileSync(paths.turns, `${JSON.stringify(updated)}\n`, 'utf8');
    }

    // 3. Close the tool calls of the turns that never finished. Without a
    //    result for every call the history is malformed, and a provider may
    //    answer a malformed history with an empty completion.
    repairedToolCalls += closeDanglingToolCalls(paths.history);
  }

  return {
    sessions,
    repairedFiles,
    rolledBackTransactions,
    interruptedTurns,
    repairedToolCalls,
  };
}

/**
 * Close every tool call in the history that never got a result.
 *
 * @returns the number of closed tool calls.
 */
function closeDanglingToolCalls(historyPath: string): number {
  if (!existsSync(historyPath)) return 0;
  const { records } = readJsonLines<AgentMessage>(historyPath);
  const repair = repairDanglingToolCalls(records);
  if (repair.repairedToolCallIds.length === 0) return 0;

  const content = repair.messages.map((record) => JSON.stringify(record)).join('\n');
  writeFileAtomic(historyPath, content.length > 0 ? `${content}\n` : '');
  return repair.repairedToolCallIds.length;
}

/** Undo a transaction that never committed. */
function rollbackTransaction(
  paths: ReturnType<typeof sessionPaths>,
  transaction: JournalRecord,
): void {
  if (transaction.kind !== 'compaction') return;

  const before = transaction.before as { readonly checkpointId?: string } | undefined;
  const checkpointId = before?.checkpointId;
  if (checkpointId === undefined) return;

  const checkpoint = join(paths.checkpoints, `${checkpointId}.jsonl`);
  if (!existsSync(checkpoint)) return;

  const { records } = readJsonLines<AgentMessage>(checkpoint);
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileAtomic(paths.history, content.length > 0 ? `${content}\n` : '');
}
