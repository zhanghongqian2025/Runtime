import { readFileSync } from 'node:fs';
import { createSessionArtifacts } from '@local-agent/local-runtime';
import type { GoalState } from './types.js';

/**
 * The goal store.
 *
 * The goal lives in the session directory (`goal.json`), so it survives a
 * restart together with the rest of the session state.
 *
 * See docs/state-ownership.md F7.
 */

export const GOAL_FILE = 'goal.json';

export interface GoalStore {
  read(sessionId: string): GoalState | undefined;
  write(sessionId: string, state: GoalState): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export interface GoalStoreOptions {
  readonly dataDir: string;
}

export function createGoalStore(options: GoalStoreOptions): GoalStore {
  const artifactsFor = (sessionId: string) =>
    createSessionArtifacts(sessionId, { dataDir: options.dataDir });

  return {
    read(sessionId: string): GoalState | undefined {
      const raw = readGoalFile(artifactsFor(sessionId).path(GOAL_FILE));
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as GoalState;
      } catch {
        return undefined;
      }
    },

    async write(sessionId: string, state: GoalState): Promise<void> {
      await artifactsFor(sessionId).write(GOAL_FILE, `${JSON.stringify(state, null, 2)}\n`);
    },

    async remove(sessionId: string): Promise<void> {
      await artifactsFor(sessionId).write(GOAL_FILE, '');
    },
  };
}

function readGoalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
