import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendJsonLine, readJsonLines } from './files.js';

/**
 * The write-ahead journal.
 *
 * A state change that spans several files is written down before it happens:
 * `begin` records the intent, `commit` records that it finished. On startup
 * every `begin` without a `commit` is rolled back, so a crash never leaves
 * half of a change behind.
 */

export type JournalState = 'begin' | 'commit' | 'rolled-back';

export interface JournalRecord {
  readonly txId: string;
  readonly kind: string;
  readonly state: JournalState;
  readonly ts: string;
  /** The values needed to undo the change. */
  readonly before?: unknown;
}

export interface Journal {
  append(record: JournalRecord): void;
  /** The transactions that were started but never committed. */
  pending(): readonly JournalRecord[];
  /** Mark a transaction as rolled back. */
  markRolledBack(txId: string): void;
  readonly filePath: string;
}

export interface JournalOptions {
  readonly filePath: string;
  readonly now?: () => string;
}

export function createJournal(options: JournalOptions): Journal {
  const now = options.now ?? ((): string => new Date().toISOString());

  const append = (record: JournalRecord): void => {
    mkdirSync(dirname(options.filePath), { recursive: true });
    appendJsonLine(options.filePath, record);
  };

  return {
    filePath: options.filePath,

    append(record: JournalRecord): void {
      append(record);
    },

    pending(): readonly JournalRecord[] {
      const { records } = readJsonLines<JournalRecord>(options.filePath);
      const committed = new Set(
        records.filter((record) => record.state !== 'begin').map((record) => record.txId),
      );
      return records.filter(
        (record) => record.state === 'begin' && !committed.has(record.txId),
      );
    },

    markRolledBack(txId: string): void {
      append({
        txId,
        kind: 'rollback',
        state: 'rolled-back',
        ts: now(),
      });
    },
  };
}

/** Read a journal file without creating a journal (used during recovery). */
export function readJournal(filePath: string): readonly JournalRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const { records } = readJsonLines<JournalRecord>(filePath);
    return records;
  } catch {
    return [];
  }
}

/** Compact the journal: keep only the last lines. */
export function trimJournal(filePath: string, keepLines = 200): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= keepLines) return;
  writeFileSync(filePath, `${lines.slice(lines.length - keepLines).join('\n')}\n`, 'utf8');
}

/** Append a raw line; used by the recovery path. */
export function appendJournalLine(filePath: string, record: JournalRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}
