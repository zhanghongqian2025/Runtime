import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '@local-agent/protocol';
import {
  buildSse,
  createFakeProvider,
  createRuntimeServer,
  loadRuntimeConfig,
  type RuntimeServer,
} from '@local-agent/local-runtime';

/**
 * End-to-end: one turn that calls three tools.
 *
 * The recorded provider asks for `read`, `write` and `grep`; the runtime
 * executes them and the assistant summarises the results.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const toolCall = (index: number, id: string, name: string, args: unknown): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })}\n\n`;

const TOOL_TURN = buildSse(
  toolCall(0, 'call_read', 'read', { path: 'input.txt' }),
  toolCall(1, 'call_write', 'write', { path: 'output.txt', content: 'written by the agent\n' }),
  toolCall(2, 'call_grep', 'grep', { pattern: 'alpha' }),
  '[DONE]',
);

const FINAL_TURN = buildSse(
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'All three tools ran.' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`,
  '[DONE]',
);

const collectEvents = async (
  baseUrl: string,
  sessionId: string,
  after: number,
): Promise<RuntimeEvent[]> => {
  const response = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/events?after=${after}`);
  const events: RuntimeEvent[] = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index < 0) break;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        const line = block.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as RuntimeEvent;
        events.push(event);

        const last = events.at(-1);
        if (last?.type === 'session.status' && (last.status === 'completed' || last.status === 'failed')) {
          return events;
        }
      }
    }
  } finally {
    // The stream is abandoned on purpose: cancelling it keeps the connection
    // pool healthy for the next request.
    await reader.cancel();
  }

  return events;
};



/** A fetch that survives a broken pooled connection (the runtime may have restarted). */
const fetchResilient = async (url: string, init?: RequestInit): Promise<Response> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error: unknown) {
      const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= 2 || (code !== 'ECONNRESET' && code !== 'ECONNREFUSED')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

describe('end-to-end turn with tools', () => {
  let server: RuntimeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('runs three tool calls and lands the results in the history', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'local-agent-e2e-'));
    writeFileSync(join(workspace, 'input.txt'), 'alpha\nbeta\n');

    const provider = createFakeProvider({ turns: [{ sse: TOOL_TURN }, { sse: FINAL_TURN }] });
    // The tools need to run without a human in the loop.
    const config = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: 'full-access' }, { readFile: false });
    server = createRuntimeServer({
      config,
      provider,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      defaultCwd: workspace,
      dataDir: mkdtempSync(join(tmpdir(), 'local-agent-e2e-')),
    });
    const port = await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do the three things' }),
    });

    const events = await collectEvents(baseUrl, sessionId, 0);
    const types = events.map((event) => event.type);

    // The three tool calls are visible on the stream.
    const started = events.filter((event) => event.type === 'tool.call.started');
    expect(started).toHaveLength(3);
    expect(started.map((event) => (event.type === 'tool.call.started' ? event.name : '')).sort()).toEqual([
      'grep',
      'read',
      'write',
    ]);

    const completed = events.filter((event) => event.type === 'tool.call.completed');
    expect(completed).toHaveLength(3);
    for (const event of completed) {
      if (event.type === 'tool.call.completed') {
        expect(event.result.isError).toBe(false);
      }
    }

    // The assistant answered after the tools ran.
    expect(types).toContain('message.completed');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('session.status');
    if (terminal?.type === 'session.status') {
      expect(terminal.status).toBe('completed');
    }

    // The tools really touched the workspace.
    expect(readFileSync(join(workspace, 'output.txt'), 'utf8')).toBe('written by the agent\n');

    // The history holds the tool results and the final answer.
    const history = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/history`);
    const messages = (await history.json()) as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };

    const toolMessages = messages.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(3);

    const assistantMessages = messages.messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.at(-1)?.content[0]?.text).toBe('All three tools ran.');
  });
});
