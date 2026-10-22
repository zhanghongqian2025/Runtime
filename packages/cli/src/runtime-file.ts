import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_NAME } from '@local-agent/protocol';

/**
 * Discovery of a running runtime.
 *
 * The runtime writes its bound port to a file when it starts; the CLI reads
 * it so the user does not have to remember a port.
 */

export interface RuntimeFile {
  readonly pid: number;
  readonly httpPort: number;
  readonly startedAt: string;
  readonly version: string;
}

export function runtimeStateDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const base = env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, RUNTIME_NAME);
}

export function runtimeFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(runtimeStateDir(env), 'runtime.json');
}

/** Read the runtime file, returning `undefined` when it is absent or invalid. */
export function readRuntimeFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(runtimeFilePath(env), 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeFile>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.httpPort === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.version === 'string'
    ) {
      return parsed as RuntimeFile;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
