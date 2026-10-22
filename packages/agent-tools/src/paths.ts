import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Path resolution.
 *
 * A tool may only touch files inside the workspace root. Anything that
 * escapes it is refused with a diagnosable error instead of being silently
 * rewritten.
 */

export interface ResolvedPath {
  /** Absolute path on disk. */
  readonly absolute: string;
  /** Path relative to the workspace root, with forward slashes. */
  readonly relative: string;
}

export class PathOutsideWorkspace extends Error {
  constructor(readonly target: string, readonly root: string) {
    super(`path escapes the workspace: ${target}`);
    this.name = 'PathOutsideWorkspace';
  }
}

/** Resolve a target path against the workspace root and refuse escapes. */
export function resolveWorkspacePath(cwd: string, target: string): ResolvedPath {
  if (target.length === 0) {
    throw new Error('path must not be empty');
  }
  if (target.includes('\0')) {
    throw new Error('path must not contain a null byte');
  }

  const root = resolve(cwd);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);

  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new PathOutsideWorkspace(target, root);
  }

  return { absolute, relative: relative(root, absolute) || '.' };
}

/** True when `child` is inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  return to === from || to.startsWith(from + sep);
}
