import { readIntegerFlag } from '../args.js';
import { fetchJson } from '../client.js';
import { readRuntimeFile } from '../runtime-file.js';

/**
 * `local-agent sessions` — list the sessions of the runtime.
 */

export interface SessionsOptions {
  readonly flags: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
}

export interface SessionsResult {
  readonly exitCode: number;
  readonly count: number;
}

interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export async function runSessions(options: SessionsOptions): Promise<SessionsResult> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;

  const host = options.flags['host'];
  const port = readIntegerFlag(options.flags, 'port');
  let baseUrl: string | undefined;
  if (host !== undefined && port !== undefined) {
    baseUrl = `http://${host}:${port}`;
  } else {
    const runtime = readRuntimeFile(env);
    if (runtime) baseUrl = `http://127.0.0.1:${runtime.httpPort}`;
  }
  if (baseUrl === undefined) {
    write('no runtime found: start one, or pass --host and --port');
    return { exitCode: 1, count: 0 };
  }

  const result = await fetchJson(`${baseUrl}/v1/sessions`, 5000);
  if (result.status !== 200) {
    write(`the runtime answered with HTTP ${result.status}`);
    return { exitCode: 1, count: 0 };
  }

  const sessions = (result.body as { sessions?: SessionSummary[] } | undefined)?.sessions ?? [];
  if (sessions.length === 0) {
    write('no session yet');
    return { exitCode: 0, count: 0 };
  }

  for (const session of sessions) {
    write(`${session.id}  ${String(session.messageCount).padStart(4)} msgs  ${session.updatedAt}  ${session.title}`);
  }
  return { exitCode: 0, count: sessions.length };
}
