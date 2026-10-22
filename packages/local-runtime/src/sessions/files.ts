import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable file helpers.
 *
 * Every write that replaces a file is atomic: a temporary file is written,
 * flushed and renamed over the target. Appends are one line per record, so a
 * crash can only damage the last line, which the reader drops.
 */

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

/** Append one JSON record as a line. */
export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

/**
 * Read a JSONL file.
 *
 * A trailing half line (a crash during the last append) is dropped and the
 * number of dropped lines is reported.
 */
export function readJsonLines<T>(path: string): { readonly records: T[]; readonly dropped: number } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { records: [], dropped: 0 };
  }

  if (raw.length === 0) return { records: [], dropped: 0 };

  const lines = raw.split('\n');
  const trailing = lines.pop() ?? '';
  const records: T[] = [];
  let dropped = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      dropped += 1;
    }
  }

  // A file that does not end with a newline means the last append was cut.
  if (trailing.trim().length > 0) {
    dropped += 1;
  }

  return { records, dropped };
}

/** Remove a file or a directory tree. */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
