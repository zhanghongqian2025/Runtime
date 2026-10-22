import { readIntegerFlag } from '../args.js';
import { fetchJson } from '../client.js';
import { readRuntimeFile } from '../runtime-file.js';

/**
 * `local-agent health` — check that a runtime is reachable.
 *
 * The endpoint is resolved from `--host` / `--port`, falling back to the
 * runtime file written by a running runtime.
 */

export interface HealthOptions {
  readonly flags: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
}

export interface HealthResult {
  readonly exitCode: number;
  readonly baseUrl: string | undefined;
}

export async function runHealth(options: HealthOptions): Promise<HealthResult> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;

  const host = options.flags['host'];
  const port = readIntegerFlag(options.flags, 'port');

  let baseUrl: string | undefined;
  if (host !== undefined && port !== undefined) {
    baseUrl = `http://${host}:${port}`;
  } else {
    const runtime = readRuntimeFile(env);
    if (runtime) {
      baseUrl = `http://127.0.0.1:${runtime.httpPort}`;
    }
  }

  if (baseUrl === undefined) {
    write(
      'no runtime found: start one, or pass --host and --port (the runtime file is missing)',
    );
    return { exitCode: 1, baseUrl: undefined };
  }

  try {
    const result = await fetchJson(`${baseUrl}/health`);
    if (result.status !== 200) {
      write(`runtime responded with HTTP ${result.status}`);
      return { exitCode: 1, baseUrl };
    }
    write(JSON.stringify(result.body, null, 2));
    return { exitCode: 0, baseUrl };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    write(`cannot reach the runtime at ${baseUrl}: ${message}`);
    return { exitCode: 1, baseUrl };
  }
}
