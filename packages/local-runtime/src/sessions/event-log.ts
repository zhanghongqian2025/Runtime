import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@local-agent/protocol';
import { appendJsonLine, readJsonLines, writeFileAtomic } from './files.js';
import { sessionPaths } from './disk-store.js';
import { RETAINED_EVENT_TYPES } from '../events/types.js';

/**
 * The session event log on disk.
 *
 * It is the authority for the SSE resume: the client asks for the events
 * after an offset and the log answers, even after a restart.
 */

export interface SessionEventLog {
  append(sessionId: string, event: RuntimeEvent): void;
  read(sessionId: string, after: number, limit: number): readonly RuntimeEvent[];
  latestOffset(sessionId: string): number;
}

export interface FileEventLogOptions {
  readonly dataDir: string;
  /** Events kept before the log is rewritten. */
  readonly retainCount: number;
}

export function createFileEventLog(options: FileEventLogOptions): SessionEventLog {
  const counts = new Map<string, number>();

  const pathFor = (sessionId: string): string => sessionPaths(options.dataDir, sessionId).events;

  const rotate = (sessionId: string): void => {
    const path = pathFor(sessionId);
    const { records } = readJsonLines<RuntimeEvent>(path);
    if (records.length <= options.retainCount) return;

    const keep: RuntimeEvent[] = [];
    for (const event of records) {
      if (keep.length >= options.retainCount && !RETAINED_EVENT_TYPES.has(event.type)) continue;
      keep.push(event);
    }
    const content = keep.map((event) => JSON.stringify(event)).join('\n');
    writeFileAtomic(path, content.length > 0 ? `${content}\n` : '');
    counts.set(sessionId, keep.length);
  };

  return {
    append(sessionId: string, event: RuntimeEvent): void {
      appendJsonLine(pathFor(sessionId), event);
      const count = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, count);
      if (count > options.retainCount * 2) {
        rotate(sessionId);
      }
    },

    read(sessionId: string, after: number, limit: number): readonly RuntimeEvent[] {
      const path = pathFor(sessionId);
      if (!existsSync(path)) return [];
      const { records } = readJsonLines<RuntimeEvent>(path);
      const selected = records.filter((event) => event.logOffset > after);
      return selected.length > limit ? selected.slice(selected.length - limit) : selected;
    },

    latestOffset(sessionId: string): number {
      const path = pathFor(sessionId);
      if (!existsSync(path)) return 0;
      const { records } = readJsonLines<RuntimeEvent>(path);
      return records.reduce((max, event) => Math.max(max, event.logOffset), 0);
    },
  };
}

/** The event files of every session, used by the recovery report. */
export function listEventLogs(dataDir: string): readonly string[] {
  const root = join(dataDir, 'sessions');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) =>
    existsSync(join(root, entry, 'events.jsonl')),
  );
}

/** Read the raw event log of a session, used by the recovery report. */
export function readEventLog(dataDir: string, sessionId: string): readonly RuntimeEvent[] {
  const path = join(dataDir, 'sessions', sessionId, 'events.jsonl');
  try {
    return readJsonLines<RuntimeEvent>(path).records;
  } catch {
    return [];
  }
}

/** Read a raw file, used by the recovery report. */
export function readRawFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
