import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { ToolArtifacts } from '@local-agent/agent-core/tools';

/**
 * Session artifacts.
 *
 * The root is the **session directory**, so a tool addresses a session file
 * by its relative path: `todo.json`, `artifacts/plan.md`,
 * `artifacts/background/<taskId>.log`. That matches the on-disk layout in
 * docs/state-ownership.md §2.
 */

export interface SessionArtifactsOptions {
  /** The runtime data directory that holds the sessions. */
  readonly dataDir: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class InvalidArtifactPath extends Error {
  constructor(readonly target: string) {
    super(`invalid artifact path: ${target}`);
    this.name = 'InvalidArtifactPath';
  }
}

/** Resolve a session-relative path, refusing escapes. */
export function resolveArtifactPath(root: string, target: string): string {
  if (target.length === 0) throw new InvalidArtifactPath(target);
  if (isAbsolute(target)) throw new InvalidArtifactPath(target);
  if (target.includes('\0')) throw new InvalidArtifactPath(target);

  const segments = target.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new InvalidArtifactPath(target);
    if (segment === '.' || segment === '..') throw new InvalidArtifactPath(target);
    if (!SEGMENT.test(segment)) throw new InvalidArtifactPath(target);
  }

  const base = resolve(root);
  const absolute = resolve(base, target);
  if (!absolute.startsWith(base + sep)) throw new InvalidArtifactPath(target);
  return absolute;
}

export function createSessionArtifacts(
  sessionId: string,
  options: SessionArtifactsOptions,
): ToolArtifacts {
  const root = resolve(options.dataDir, 'sessions', sessionId);

  return {
    path(target: string): string {
      return resolveArtifactPath(root, target);
    },
    async write(target: string, content: string): Promise<void> {
      const absolute = resolveArtifactPath(root, target);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    },
    async append(target: string, content: string): Promise<void> {
      const absolute = resolveArtifactPath(root, target);
      mkdirSync(dirname(absolute), { recursive: true });
      appendFileSync(absolute, content, 'utf8');
    },
    async read(target: string): Promise<string | undefined> {
      try {
        return readFileSync(resolveArtifactPath(root, target), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}
