import { createInterface } from 'node:readline/promises';
import { readIntegerFlag } from '../args.js';
import { fetchJson, fetchWithRetry } from '../client.js';
import { readRuntimeFile } from '../runtime-file.js';
import { readSse } from '../sse.js';

/**
 * `local-agent send` — send a message and render the turn.
 *
 * The command creates a session (or reuses `--session`), posts the message
 * and then subscribes to the session event stream. The subscription resumes
 * from the offset the session had *before* the message was posted, so no
 * event is missed and no old event is replayed.
 */

export interface SendOptions {
  readonly flags: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Writes text without a line break, used for the streaming deltas. */
  readonly writeRaw?: (text: string) => void;
  readonly writeErr?: (line: string) => void;
}

export interface SendResult {
  readonly exitCode: number;
  readonly sessionId: string | undefined;
}

interface RuntimeEventPayload {
  readonly type?: string;
  readonly turnId?: string | null;
  readonly text?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly toolCallId?: string;
  readonly name?: string;
  readonly blockedBy?: string;
  readonly approval?: {
    readonly requestId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly risk: string;
    readonly matchedRule?: string;
    readonly reason: string;
  };
  readonly question?: {
    readonly requestId: string;
    readonly title: string;
    readonly questions: { readonly id: string; readonly question: string }[];
  };
}

/** Read one line from the terminal. */
const ask = async (prompt: string): Promise<string> => {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
};

export async function runSend(options: SendOptions): Promise<SendResult> {
  const writeRaw = options.writeRaw ?? ((text: string): void => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const env = options.env ?? process.env;

  const text = options.flags['message'] ?? options.flags['text'];
  if (text === undefined || text.length === 0) {
    writeErr('no message given: local-agent send --message "hello"');
    return { exitCode: 1, sessionId: undefined };
  }

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
    return { exitCode: 1, sessionId: undefined };
  }

  try {
    // Reuse the requested session, continue the most recent one, or create one.
    let sessionId = options.flags['session'];
    if (sessionId === undefined && options.flags['continue'] === 'true') {
      const listed = await fetchJson(`${baseUrl}/v1/sessions`, 5000);
      const sessions = (listed.body as { sessions?: { id?: string }[] } | undefined)?.sessions ?? [];
      sessionId = sessions[0]?.id;
      if (sessionId === undefined) {
        writeErr('no session to continue: the runtime has no session yet');
        return { exitCode: 1, sessionId: undefined };
      }
    }
    if (sessionId === undefined) {
      const created = await fetchJson(`${baseUrl}/v1/sessions`, 5000, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (created.status !== 201) {
        writeErr(`cannot create a session (HTTP ${created.status})`);
        return { exitCode: 1, sessionId: undefined };
      }
      const body = created.body as { session?: { id?: string } };
      sessionId = body.session?.id;
      if (sessionId === undefined) {
        writeErr('the runtime did not return a session id');
        return { exitCode: 1, sessionId: undefined };
      }
    }

    // The offset before the message: everything after it belongs to this turn.
    const status = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/status`, 5000);
    const statusBody = status.body as { latestEventOffset?: number } | undefined;
    const after = statusBody?.latestEventOffset ?? 0;

    const submitted = await fetchJson(`${baseUrl}/v1/sessions/${sessionId}/messages`, 5000, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (submitted.status !== 202) {
      const body = submitted.body as { error?: { message?: string } } | undefined;
      writeErr(body?.error?.message ?? `the runtime rejected the message (HTTP ${submitted.status})`);
      return { exitCode: 1, sessionId };
    }
    const submittedBody = submitted.body as
      | { turnId?: string; deferred?: boolean; cancelled?: boolean }
      | undefined;

    if (submittedBody?.cancelled === true) {
      writeErr('the message was dropped: it is not valid in the current mode');
      return { exitCode: 1, sessionId };
    }
    if (submittedBody?.deferred === true) {
      // The fence holds the turn back: there is nothing to render yet.
      writeErr('the message was accepted but deferred: it waits for the plan review');
      return { exitCode: 0, sessionId };
    }

    const turnId = submittedBody?.turnId;

    // The stream is aborted when the turn ends: an open SSE connection would
    // keep the client process alive.
    const controller = new AbortController();
    let response: Response;
    try {
      response = await fetchWithRetry(
        `${baseUrl}/v1/sessions/${sessionId}/events?after=${after}`,
        { signal: controller.signal },
      );
    } catch (error: unknown) {
      writeErr(
        `cannot subscribe to the event stream: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return { exitCode: 1, sessionId };
    }
    if (!response.ok) {
      writeErr(`cannot subscribe to the event stream (HTTP ${response.status})`);
      return { exitCode: 1, sessionId };
    }

    try {
      for await (const message of readSse(response)) {
        if (message.data.length === 0) continue;
        let event: RuntimeEventPayload;
        try {
          event = JSON.parse(message.data) as RuntimeEventPayload;
        } catch {
          continue;
        }

        // The stream may replay the events of an earlier turn; only the
        // events of this turn belong to this command.
        if (turnId !== undefined && event.turnId !== null && event.turnId !== turnId) {
          continue;
        }

        switch (event.type) {
          case 'message.delta':
            writeRaw(event.text ?? '');
            break;
          case 'thinking.delta':
            writeErr(`[thinking] ${event.text ?? ''}`);
            break;
          case 'permission.requested': {
            const approval = event.approval;
            if (!approval) break;
            writeErr('');
            writeErr(`[permission] ${approval.toolName} needs your approval (risk: ${approval.risk})`);
            writeErr(`  reason: ${approval.reason}`);
            if (approval.matchedRule) writeErr(`  matched rule: ${approval.matchedRule}`);
            writeErr(`  input: ${JSON.stringify(approval.input)}`);
            writeErr('  1) allow once   2) allow for this session   3) deny');
            const answer = await ask('  your choice [3]: ');
            const choice =
              answer === '1'
                ? 'allow-once'
                : answer === '2'
                  ? 'allow-session'
                  : 'deny';
            const result = await fetchJson(
              `${baseUrl}/v1/sessions/${sessionId}/permissions/${approval.requestId}`,
              5000,
              { method: 'POST', body: JSON.stringify({ choice }) },
            );
            if (result.status !== 200) {
              writeErr(`  the approval could not be sent (HTTP ${result.status})`);
            }
            break;
          }
          case 'question.requested': {
            const question = event.question;
            if (!question) break;
            writeErr('');
            writeErr(`[question] ${question.title}`);
            for (const item of question.questions) {
              writeErr(`  ${item.id}: ${item.question}`);
            }
            const answer = await ask('  your answer: ');
            const answers: Record<string, string> = {};
            for (const item of question.questions) {
              answers[item.id] = answer;
            }
            const result = await fetchJson(
              `${baseUrl}/v1/sessions/${sessionId}/questions/${question.requestId}`,
              5000,
              { method: 'POST', body: JSON.stringify({ answers }) },
            );
            if (result.status !== 200) {
              writeErr(`  the answer could not be sent (HTTP ${result.status})`);
            }
            break;
          }
          case 'tool.call.started':
            writeErr(`[tool] ${event.name ?? 'unknown'} started`);
            break;
          case 'tool.call.blocked':
            writeErr(`[tool] blocked (${event.blockedBy ?? 'unknown'})`);
            break;
          case 'tool.call.completed':
            writeErr(`[tool] ${event.name ?? 'unknown'} finished`);
            break;
          case 'session.status': {
            const status = event.status ?? 'unknown';
            if (status === 'completed') {
              writeRaw('\n');
              // The turn is over: stop reading, the server keeps the stream
              // open for the next turn.
              return { exitCode: 0, sessionId };
            }
            if (status === 'failed' || status === 'aborted') {
              writeErr(`[turn] ${status}${event.reason ? `: ${event.reason}` : ''}`);
              return { exitCode: status === 'failed' ? 1 : 2, sessionId };
            }
            break;
          }
          default:
            break;
        }
      }
    } finally {
      // The stream is aborted on the way out: an open SSE connection would
      // keep the client process alive.
      controller.abort();
    }

    return { exitCode: 0, sessionId };
  } catch (error: unknown) {
    writeErr(
      `the request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return { exitCode: 1, sessionId: undefined };
  }
}
