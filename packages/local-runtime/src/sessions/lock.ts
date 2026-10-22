import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The session lock.
 *
 * The file on disk is the authority: a second process must not write the same
 * session. A lock whose owner died is stale and can be taken over.
 */

export interface SessionLock {
  /** False when the lock is held by a live process. */
  readonly acquired: boolean;
  readonly reason?: string;
  release(): void;
}

export interface LockOptions {
  readonly now?: () => number;
  /** A lock whose heartbeat is older than this is considered stale. */
  readonly staleMs?: number;
}

interface LockContent {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

const DEFAULT_STALE_MS = 30_000;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function acquireSessionLock(
  lockPath: string,
  options: LockOptions = {},
): SessionLock {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  const content = (): LockContent => ({
    pid: process.pid,
    hostname: 'localhost',
    acquiredAt: new Date(now()).toISOString(),
    heartbeatAt: new Date(now()).toISOString(),
  });

  const write = (): void => {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify(content(), null, 2)}\n`, 'utf8');
  };

  const tryCreate = (): boolean => {
    try {
      const descriptor = openSync(lockPath, 'wx');
      closeSync(descriptor);
      write();
      return true;
    } catch {
      return false;
    }
  };

  if (!tryCreate()) {
    // The lock exists: is it stale?
    let existing: LockContent | undefined;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContent;
    } catch {
      existing = undefined;
    }

    const stale =
      existing === undefined ||
      !isProcessAlive(existing.pid) ||
      now() - Date.parse(existing.heartbeatAt) > staleMs;

    if (!stale) {
      return {
        acquired: false,
        reason: `the session is locked by pid ${existing?.pid ?? 'unknown'}`,
        release: () => undefined,
      };
    }

    rmSync(lockPath, { force: true });
    if (!tryCreate()) {
      return {
        acquired: false,
        reason: 'the session lock could not be taken over',
        release: () => undefined,
      };
    }
  }

  let released = false;
  return {
    acquired: true,
    release(): void {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}
