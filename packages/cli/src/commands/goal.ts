import { readIntegerFlag } from '../args.js';
import { fetchJson } from '../client.js';
import { readRuntimeFile } from '../runtime-file.js';

/**
 * `local-agent goal` — drive the goal of a session.
 *
 * Subcommands: `show`, `set`, `status`.
 */

export interface GoalOptions {
  readonly subcommand: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
  readonly writeErr?: (line: string) => void;
}

export interface GoalResult {
  readonly exitCode: number;
  readonly sessionId?: string;
}

const USAGE = `Usage:
  local-agent goal show   [--session <id>]
  local-agent goal set    "<goal text>" [--session <id>] [--token-budget <n>]
  local-agent goal status <completed|blocked|paused|cleared> [--reason "<text>"] [--session <id>]
`;

export async function runGoal(options: GoalOptions): Promise<GoalResult> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const writeErr = options.writeErr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
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
    writeErr('no runtime found: start one, or pass --host and --port');
    return { exitCode: 1 };
  }

  let sessionId = options.flags['session'];
  if (sessionId === undefined) {
    const listed = await fetchJson(`${baseUrl}/v1/sessions`, 5000);
    const sessions = (listed.body as { sessions?: { id?: string }[] } | undefined)?.sessions ?? [];
    sessionId = sessions[0]?.id;
    if (sessionId === undefined) {
      writeErr('no session to work on: the runtime has no session yet');
      return { exitCode: 1 };
    }
  }

  switch (options.subcommand) {
    case 'show': {
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/goal`, 5000);
      if (result.status !== 200) {
        writeErr('this session has no goal');
        return { exitCode: 1, sessionId };
      }
      const body = result.body as { goal?: Record<string, unknown> };
      write(JSON.stringify(body.goal ?? {}, null, 2));
      return { exitCode: 0, sessionId };
    }

    case 'set': {
      const text = options.flags['text'] ?? options.flags['goal'];
      if (text === undefined || text.length === 0) {
        writeErr('no goal text given: local-agent goal set "..."');
        return { exitCode: 1, sessionId };
      }
      const budget = readIntegerFlag(options.flags, 'token-budget');
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/goal`, 5000, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(budget === undefined ? {} : { tokenBudget: budget }),
        }),
      });
      if (result.status !== 201) {
        const body = result.body as { error?: { message?: string } } | undefined;
        writeErr(body?.error?.message ?? `the goal could not be set (HTTP ${result.status})`);
        return { exitCode: 1, sessionId };
      }
      write('the goal is set');
      return { exitCode: 0, sessionId };
    }

    case 'status': {
      const status = options.flags['status'];
      if (status === undefined) {
        writeErr(`no status given\n${USAGE}`);
        return { exitCode: 1, sessionId };
      }
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/goal`, 5000, {
        method: 'POST',
        body: JSON.stringify({
          status,
          ...(options.flags['reason'] === undefined
            ? {}
            : { reason: options.flags['reason'] }),
        }),
      });
      if (result.status !== 200) {
        const body = result.body as { error?: { message?: string } } | undefined;
        writeErr(body?.error?.message ?? `the goal could not be changed (HTTP ${result.status})`);
        return { exitCode: 1, sessionId };
      }
      write(`the goal is now ${status}`);
      return { exitCode: 0, sessionId };
    }

    default:
      writeErr(`unknown goal subcommand: ${options.subcommand}\n${USAGE}`);
      return { exitCode: 1, sessionId };
  }
}
