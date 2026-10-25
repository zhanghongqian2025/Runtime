import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@local-agent/protocol';
import { newId } from '@local-agent/protocol';
import { appendJsonLine, readJsonLines, removePath, writeFileAtomic } from './files.js';
import type {
  CreateSessionInput,
  ForkOptions,
  RewindOptions,
  Session,
  SessionStore,
  SessionView,
  TurnRecord,
} from './types.js';

/**
 * The on-disk session store.
 *
 * It is the only writer of the session facts (docs/state-ownership.md F1–F3,
 * F11). The layout is JSONL for the append-only facts and atomic replaces
 * for the small documents, so a crash can never leave half a file behind.
 */

export interface DiskSessionStoreOptions {
  /** The runtime data directory that holds the sessions. */
  readonly dataDir: string;
  readonly now?: () => string;
}

export const SESSIONS_DIRNAME = 'sessions';

export interface DiskSessionPaths {
  readonly root: string;
  readonly meta: string;
  readonly history: string;
  readonly turns: string;
  readonly events: string;
  readonly journal: string;
  readonly todo: string;
  readonly lock: string;
  readonly artifacts: string;
  readonly checkpoints: string;
}

export function sessionPaths(dataDir: string, sessionId: string): DiskSessionPaths {
  const root = join(dataDir, SESSIONS_DIRNAME, sessionId);
  return {
    root,
    meta: join(root, 'meta.json'),
    history: join(root, 'history.jsonl'),
    turns: join(root, 'turns.jsonl'),
    events: join(root, 'events.jsonl'),
    journal: join(root, 'journal.jsonl'),
    todo: join(root, 'todo.json'),
    lock: join(root, 'lock'),
    artifacts: join(root, 'artifacts'),
    checkpoints: join(root, 'history.checkpoints'),
  };
}

interface StoredMeta {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly interactionMode: 'default' | 'plan';
  readonly status: string;
  readonly providerId: string;
  readonly model: string;
  readonly forkedFrom?: string;
  /** The permission mode of the session, when it differs from the runtime's. */
  readonly permissionMode?: 'ask' | 'auto' | 'full-access' | undefined;
}

export function createDiskSessionStore(options: DiskSessionStoreOptions): SessionStore {
  const now = options.now ?? ((): string => new Date().toISOString());
  const sessionsRoot = join(options.dataDir, SESSIONS_DIRNAME);
  const metaCache = new Map<string, StoredMeta>();

  const pathsFor = (sessionId: string): DiskSessionPaths => sessionPaths(options.dataDir, sessionId);

  const readMeta = (sessionId: string): StoredMeta | undefined => {
    const cached = metaCache.get(sessionId);
    if (cached) return cached;

    const paths = pathsFor(sessionId);
    if (!existsSync(paths.meta)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(paths.meta, 'utf8')) as StoredMeta;
      metaCache.set(sessionId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  };

  const writeMeta = (meta: StoredMeta): void => {
    metaCache.set(meta.id, meta);
    writeFileAtomic(pathsFor(meta.id).meta, `${JSON.stringify(meta, null, 2)}\n`);
  };

  const toSession = (meta: StoredMeta): Session => ({
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    interactionMode: meta.interactionMode,
    status: meta.status === 'awaiting_approval' || meta.status === 'awaiting_input'
      ? meta.status
      : 'idle',
    providerId: meta.providerId,
    model: meta.model,
    ...(meta.permissionMode === undefined ? {} : { permissionMode: meta.permissionMode }),
  });

  const historyFor = (sessionId: string): AgentMessage[] =>
    readJsonLines<AgentMessage>(pathsFor(sessionId).history).records;

  /** The index of the last message of a turn, or the whole history. */
  const boundaryIndex = (
    history: readonly AgentMessage[],
    options: { fromMessageId?: string | undefined; fromTurnId?: string | undefined },
  ): number => {
    if (options.fromMessageId !== undefined) {
      const index = history.findIndex((message) => message.id === options.fromMessageId);
      return index === -1 ? history.length : index + 1;
    }
    if (options.fromTurnId !== undefined) {
      let index = -1;
      for (let position = 0; position < history.length; position += 1) {
        const message = history[position];
        if (message?.meta?.turnId === options.fromTurnId) index = position;
      }
      return index === -1 ? history.length : index + 1;
    }
    return history.length;
  };

  return {
    create(input: CreateSessionInput): Session {
      const timestamp = now();
      const meta: StoredMeta = {
        id: input.id ?? newId('session'),
        title: input.title ?? 'untitled session',
        cwd: input.cwd,
        createdAt: timestamp,
        updatedAt: timestamp,
        interactionMode: 'default',
        status: 'idle',
        providerId: input.providerId,
        model: input.model,
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      };
      const paths = pathsFor(meta.id);
      mkdirSync(paths.root, { recursive: true });
      mkdirSync(paths.artifacts, { recursive: true });
      mkdirSync(paths.checkpoints, { recursive: true });
      writeMeta(meta);
      return toSession(meta);
    },

    get(id: string): Session | undefined {
      const meta = readMeta(id);
      return meta ? toSession(meta) : undefined;
    },

    list(): readonly SessionView[] {
      let entries: string[];
      try {
        entries = readdirSync(sessionsRoot);
      } catch {
        return [];
      }

      const views: SessionView[] = [];
      for (const entry of entries) {
        const meta = readMeta(entry);
        if (!meta) continue;
        views.push({
          ...toSession(meta),
          messageCount: historyFor(entry).length,
        });
      }
      return views.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    update(id: string, patch: Partial<Omit<Session, 'id' | 'createdAt'>>): Session | undefined {
      const meta = readMeta(id);
      if (!meta) return undefined;
      const next: StoredMeta = {
        ...meta,
        ...patch,
        updatedAt: now(),
      };
      writeMeta(next);
      return toSession(next);
    },

    readHistory(id: string): readonly AgentMessage[] {
      return historyFor(id);
    },

    appendHistory(id: string, messages: readonly AgentMessage[]): void {
      if (messages.length === 0) return;
      const paths = pathsFor(id);
      for (const message of messages) {
        appendJsonLine(paths.history, message);
      }
      const meta = readMeta(id);
      if (meta) writeMeta({ ...meta, updatedAt: now() });
    },

    replaceHistory(id: string, messages: readonly AgentMessage[]): void {
      const paths = pathsFor(id);
      const content = messages.map((message) => JSON.stringify(message)).join('\n');
      writeFileAtomic(paths.history, content.length > 0 ? `${content}\n` : '');
      const meta = readMeta(id);
      if (meta) writeMeta({ ...meta, updatedAt: now() });
    },

    delete(id: string): boolean {
      const meta = readMeta(id);
      if (!meta) return false;
      metaCache.delete(id);
      removePath(pathsFor(id).root);
      return true;
    },

    fork(id: string, forkOptions: ForkOptions): Session | undefined {
      const meta = readMeta(id);
      if (!meta) return undefined;

      const history = historyFor(id);
      const boundary = boundaryIndex(history, forkOptions);
      const branch = history.slice(0, boundary);

      const timestamp = now();
      const forkedMeta: StoredMeta = {
        id: newId('session'),
        title: forkOptions.title ?? `${meta.title} (fork)`,
        cwd: meta.cwd,
        createdAt: timestamp,
        updatedAt: timestamp,
        interactionMode: meta.interactionMode,
        status: 'idle',
        providerId: meta.providerId,
        model: meta.model,
        forkedFrom: meta.id,
      };

      const paths = pathsFor(forkedMeta.id);
      mkdirSync(paths.artifacts, { recursive: true });
      mkdirSync(paths.checkpoints, { recursive: true });
      writeMeta(forkedMeta);

      const content = branch.map((message) => JSON.stringify(message)).join('\n');
      writeFileAtomic(paths.history, content.length > 0 ? `${content}\n` : '');

      return toSession(forkedMeta);
    },

    rewind(id: string, rewindOptions: RewindOptions): Session | undefined {
      const meta = readMeta(id);
      if (!meta) return undefined;

      const history = historyFor(id);
      const boundary = boundaryIndex(history, {
        ...(rewindOptions.toMessageId === undefined
          ? {}
          : { fromMessageId: rewindOptions.toMessageId }),
        ...(rewindOptions.toTurnId === undefined
          ? {}
          : { fromTurnId: rewindOptions.toTurnId }),
      });
      const kept = history.slice(0, boundary);

      // The rewind only cuts the history; the resent message is appended by
      // the turn system, so it is stored exactly once.
      const next = [...kept];
      const paths = pathsFor(id);
      const content = next.map((message) => JSON.stringify(message)).join('\n');
      writeFileAtomic(paths.history, content.length > 0 ? `${content}\n` : '');

      // The turns after the boundary are gone; their index entries are stale.
      const keptTurns = new Set(kept.map((message) => message.meta?.turnId).filter(Boolean));
      const turns = readJsonLines<TurnRecord>(paths.turns).records.filter(
        (record) => keptTurns.has(record.turnId),
      );
      const turnContent = turns.map((record) => JSON.stringify(record)).join('\n');
      writeFileAtomic(paths.turns, turnContent.length > 0 ? `${turnContent}\n` : '');

      const nextMeta: StoredMeta = { ...meta, updatedAt: now() };
      writeMeta(nextMeta);
      return toSession(nextMeta);
    },

    appendTurn(id: string, record: TurnRecord): void {
      appendJsonLine(pathsFor(id).turns, record);
    },

    readTurns(id: string): readonly TurnRecord[] {
      const { records } = readJsonLines<TurnRecord>(pathsFor(id).turns);
      // The last record for a turn wins: the store appends a full snapshot
      // every time the state of a turn changes.
      const byTurn = new Map<string, TurnRecord>();
      for (const record of records) {
        byTurn.set(record.turnId, record);
      }
      return [...byTurn.values()].sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt),
      );
    },

    writeCheckpoint(id: string, checkpointId: string, messages: readonly AgentMessage[]): void {
      const paths = pathsFor(id);
      mkdirSync(paths.checkpoints, { recursive: true });
      const content = messages.map((message) => JSON.stringify(message)).join('\n');
      writeFileAtomic(
        join(paths.checkpoints, `${checkpointId}.jsonl`),
        content.length > 0 ? `${content}\n` : '',
      );
    },

    readCheckpoint(id: string, checkpointId: string): readonly AgentMessage[] {
      const path = join(pathsFor(id).checkpoints, `${checkpointId}.jsonl`);
      return readJsonLines<AgentMessage>(path).records;
    },

    listCheckpoints(id: string): readonly string[] {
      const directory = pathsFor(id).checkpoints;
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => entry.replace(/\.jsonl$/, ''))
        .sort();
    },
  };
}

/** The size of a session directory, used by the status endpoint. */
export function sessionDirectorySize(paths: DiskSessionPaths): number {
  try {
    return statSync(paths.root).size;
  } catch {
    return 0;
  }
}
