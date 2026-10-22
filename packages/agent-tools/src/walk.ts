import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Directory walking.
 *
 * Shared by `grep` and `glob`. The walk is bounded: it skips the usual noise
 * directories and refuses to read files that are too large to be text.
 */

export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
];

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export interface WalkedFile {
  readonly absolute: string;
  readonly relative: string;
  readonly size: number;
}

export interface WalkOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly skipDirectories?: readonly string[];
}

export function* walkFiles(options: WalkOptions): Generator<WalkedFile> {
  const maxFileBytes = options.maxFileBytes ?? MAX_TEXT_FILE_BYTES;
  const skip = new Set(options.skipDirectories ?? SKIPPED_DIRECTORIES);
  const root = options.root;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > maxFileBytes) continue;
      yield { absolute, relative: relative(root, absolute), size };
    }
  }
}
