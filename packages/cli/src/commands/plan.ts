import { readIntegerFlag } from '../args.js';
import { fetchJson } from '../client.js';
import { readRuntimeFile } from '../runtime-file.js';

/**
 * `local-agent plan` — drive the plan mode.
 *
 * Subcommands: `enter`, `review`, `approve`, `reject`, `show`.
 */

export interface PlanOptions {
  readonly subcommand: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
  readonly writeErr?: (line: string) => void;
}

export interface PlanResult {
  readonly exitCode: number;
  readonly sessionId?: string;
}

interface PlanStateBody {
  readonly mode: string;
  readonly blocked: boolean;
  readonly review?: {
    readonly requestId: string;
    readonly state: string;
    readonly markdown: string;
    readonly feedback?: string;
  };
}

const USAGE = `Usage:
  local-agent plan enter   [--session <id>]
  local-agent plan review  [--session <id>]
  local-agent plan approve [--session <id>]
  local-agent plan reject  [--session <id>] [--feedback "<text>"]
  local-agent plan show    [--session <id>]
`;

export async function runPlan(options: PlanOptions): Promise<PlanResult> {
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

  // The session: the one that was named, or the most recent one.
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

  const readState = async (): Promise<PlanStateBody | undefined> => {
    const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/plan`, 5000);
    if (result.status !== 200) return undefined;
    return result.body as PlanStateBody;
  };

  switch (options.subcommand) {
    case 'enter': {
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/mode`, 5000, {
        method: 'POST',
        body: JSON.stringify({ interactionMode: 'plan' }),
      });
      if (result.status !== 200) {
        writeErr(`the plan mode could not be entered (HTTP ${result.status})`);
        return { exitCode: 1, sessionId };
      }
      write('the plan mode is on: the agent plans, nothing is executed until you approve the plan');
      return { exitCode: 0, sessionId };
    }

    case 'review': {
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/mode`, 5000, {
        method: 'POST',
        body: JSON.stringify({ interactionMode: 'default' }),
      });
      if (result.status !== 200) {
        const body = result.body as { error?: { message?: string } } | undefined;
        writeErr(body?.error?.message ?? `the plan could not be frozen (HTTP ${result.status})`);
        return { exitCode: 1, sessionId };
      }
      const body = result.body as { review?: { requestId: string; markdown: string } };
      write('--- the frozen plan ---');
      write(body.review?.markdown ?? '');
      write('--- approve it with: local-agent plan approve ---');
      return { exitCode: 0, sessionId };
    }

    case 'approve':
    case 'reject': {
      const state = await readState();
      const requestId = state?.review?.requestId;
      if (requestId === undefined) {
        writeErr('no plan is waiting for a review');
        return { exitCode: 1, sessionId };
      }
      const decision = options.subcommand === 'approve' ? 'approve' : 'reject';
      const result = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/plan/review`, 5000, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          decision,
          ...(options.flags['feedback'] === undefined
            ? {}
            : { feedback: options.flags['feedback'] }),
        }),
      });
      if (result.status !== 200) {
        writeErr(`the review could not be answered (HTTP ${result.status})`);
        return { exitCode: 1, sessionId };
      }
      write(decision === 'approve' ? 'the plan is approved' : 'the plan is rejected');
      return { exitCode: 0, sessionId };
    }

    case 'show': {
      const state = await readState();
      if (state === undefined) {
        writeErr('the plan state could not be read');
        return { exitCode: 1, sessionId };
      }
      write(`mode: ${state.mode}${state.blocked ? ' (a review is waiting)' : ''}`);
      if (state.review !== undefined) {
        write(`review: ${state.review.state} (${state.review.requestId})`);
      }
      return { exitCode: 0, sessionId };
    }

    default:
      writeErr(`unknown plan subcommand: ${options.subcommand}\n${USAGE}`);
      return { exitCode: 1, sessionId };
  }
}
