import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { NormalizedCall } from './types.js';

/**
 * Argument normalization.
 *
 * The decision must not depend on how the model spelled a path, so the
 * arguments are reduced to a stable form: absolute paths become workspace
 * relative, and a path that leaves the workspace is flagged.
 */

const asRecord = (input: unknown): Record<string, unknown> | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;

const stringField = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
};

/** Normalize a path against the workspace root. */
export function normalizePath(cwd: string, target: string): { path: string; outside: boolean } {
  const root = resolve(cwd);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const inside = absolute === root || absolute.startsWith(root + sep);
  return {
    path: inside ? relative(root, absolute) || '.' : absolute,
    outside: !inside,
  };
}

export function normalizeToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
): NormalizedCall {
  const record = asRecord(input);
  const command = stringField(record, 'command');
  const rawPath = stringField(record, 'path');

  if (rawPath !== undefined) {
    const normalized = normalizePath(cwd, rawPath);
    return {
      toolName,
      input: { ...record, path: normalized.path },
      path: normalized.path,
      outsideWorkspace: normalized.outside,
    };
  }

  if (command !== undefined) {
    return { toolName, input: { ...record, command }, command };
  }

  return { toolName, input };
}

/** The credential directories, matched as path segments. */
const CREDENTIAL_DIRECTORIES = ['.ssh', '.aws', '.gnupg', '.kube'];

/** The files that hold credentials, matched by name. */
const CREDENTIAL_FILES = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
  '.netrc',
  'config.json',
];

/** The shell and git configuration files, matched by name. */
const CONFIGURATION_FILES = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.gitconfig',
];

/** The system directories, matched as the first segment of an absolute path. */
const SYSTEM_DIRECTORIES = ['etc', 'usr', 'bin', 'sbin', 'boot', 'system'];

const splitPath = (path: string): string[] =>
  path.replace(/\\/g, '/').toLowerCase().split('/').filter((segment) => segment.length > 0);

/** True when the path points at a credential store. */
export function isCredentialPath(path: string): boolean {
  const segments = splitPath(path);
  if (segments.length === 0) return false;
  const name = segments[segments.length - 1] as string;

  if (segments.some((segment) => CREDENTIAL_DIRECTORIES.includes(segment))) return true;
  if (CREDENTIAL_FILES.includes(name)) return true;
  if (name.endsWith('.pem') || name.endsWith('.p12') || name.endsWith('.pfx')) return true;
  if (segments.includes('.docker') && name === 'config.json') return true;
  return false;
}

/** True when the path points at a system or shell configuration file. */
export function isSystemPath(path: string): boolean {
  const segments = splitPath(path);
  if (segments.length === 0) return false;
  const name = segments[segments.length - 1] as string;

  const absolute = path.replace(/\\/g, '/').startsWith('/');
  if (absolute && SYSTEM_DIRECTORIES.includes(segments[0] as string)) return true;
  if (CONFIGURATION_FILES.includes(name)) return true;
  return false;
}
