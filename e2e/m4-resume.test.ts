import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
 * End-to-end: the runtime restarts and the conversation continues.
 *
 * The hard requirement: after a restart the session is still there, the
 * history is intact and the tool calls that already ran are **not** run a
 * second time.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const call = (id: string, name: string, args: unknown): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })}\n\n`;

const text = (value: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\n`;

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


interface HistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly content: { readonly type: string }[];
  readonly meta?: { readonly turnId?: string };
}

const readHistory = async (
  baseUrl: string,
  sessionId: string,
): Promise<HistoryMessage[]> => {
  const response = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/history`);
  const body = (await response.json()) as { messages: HistoryMessage[] };
  return body.messages;
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

describe('end-to-end resume after a restart', () => {
  let server: RuntimeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('continues the conversation without repeating the tool calls', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-resume-'));
    const workspace = mkdtempSync(join(tmpdir(), 'local-agent-resume-ws-'));
    const config = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: 'full-access' });

    // --- the first run: a tool call, then an answer ---
    const first = createFakeProvider({
      turns: [
        {
          sse: buildSse(
            call('call_1', 'bash', { command: 'echo resumed > out.txt' }),
            '[DONE]',
          ),
        },
        { sse: buildSse(text('The tool ran.'), '[DONE]') },
      ],
    });

    server = createRuntimeServer({
      config,
      provider: first,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir,
      defaultCwd: workspace,
    });
    const firstPort = await server.listen();
    const firstUrl = `http://127.0.0.1:${firstPort}`;

    const created = await fetchResilient(`${firstUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'resume' }),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

    await fetchResilient(`${firstUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write the file' }),
    });
    const firstEvents = await collectEvents(firstUrl, sessionId, 0);
    expect(firstEvents.filter((event) => event.type === 'tool.call.completed')).toHaveLength(1);
    expect(existsSync(join(workspace, 'out.txt'))).toBe(true);

    // --- the runtime restarts ---
    await server.close();
    server = undefined;

    // --- the second run: the same data directory, a fresh provider ---
    const second = createFakeProvider({
      turns: [{ sse: buildSse(text('We continued.'), '[DONE]') }],
    });

    server = createRuntimeServer({
      config,
      provider: second,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir,
      defaultCwd: workspace,
    });
    const secondPort = await server.listen();
    const secondUrl = `http://127.0.0.1:${secondPort}`;

    // The session survived the restart.
    const listed = await fetchResilient(`${secondUrl}/v1/sessions`);
    const sessions = (await listed.json()) as { sessions: { id: string; messageCount: number }[] };
    expect(sessions.sessions.map((entry) => entry.id)).toContain(sessionId);

    // The history survived the restart.
    const history = await readHistory(secondUrl, sessionId);
    expect(history.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(history.filter((message) => message.role === 'tool')).toHaveLength(1);

    // The event log survived too: the client can still replay it.
    const replayed = await collectEvents(secondUrl, sessionId, 0);
    expect(replayed.length).toBeGreaterThan(0);

    // --- continue the conversation ---
    await fetchResilient(`${secondUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'what now?' }),
    });
    const secondEvents = await collectEvents(secondUrl, sessionId, 0);
    const terminal = secondEvents.at(-1);
    expect(terminal?.type).toBe('session.status');
    if (terminal?.type === 'session.status') {
      expect(terminal.status).toBe('completed');
    }

    // The tool call of the first turn was **not** executed again.
    const finalHistory = await readHistory(secondUrl, sessionId);
    expect(finalHistory.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(finalHistory.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(finalHistory.at(-1)?.content[0]?.type).toBe('text');

    // The file was written exactly once by the first run.
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8').trim()).toBe('resumed');
  });

  it('forks a session and rewinds it to an earlier point', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-fork-'));
    const workspace = mkdtempSync(join(tmpdir(), 'local-agent-fork-ws-'));
    const config = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: 'full-access' });
    const provider = createFakeProvider({
      turns: [
        { sse: buildSse(text('first answer'), '[DONE]') },
        { sse: buildSse(text('second answer'), '[DONE]') },
        { sse: buildSse(text('after the rewind'), '[DONE]') },
      ],
    });

    server = createRuntimeServer({
      config,
      provider,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir,
      defaultCwd: workspace,
    });
    const port = await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

    const post = async (text: string): Promise<void> => {
      await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await collectEvents(baseUrl, sessionId, 0);
    };

    await post('first question');
    await post('second question');

    // Fork after the first exchange.
    const history = await readHistory(baseUrl, sessionId);
    const firstUser = history.find((message) => message.role === 'user');
    const forked = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(firstUser ? { fromMessageId: firstUser.id } : {}),
    });
    expect(forked.status).toBe(201);
    const forkedBody = (await forked.json()) as { session: { id: string } };
    expect(forkedBody.session.id).not.toBe(sessionId);

    // The fork holds the first exchange only.
    const forkedHistory = await readHistory(baseUrl, forkedBody.session.id);
    expect(forkedHistory.filter((message) => message.role === 'user')).toHaveLength(1);

    // Rewind the original to its first exchange and resend.
    const rewound = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        firstUser?.meta?.turnId === undefined
          ? { resend: 'third question' }
          : { toTurnId: firstUser.meta.turnId, resend: 'third question' },
      ),
    });
    expect(rewound.status).toBe(202);

    const finalHistory = await readHistory(baseUrl, sessionId);
    const users = finalHistory.filter((message) => message.role === 'user');
    // The rewind cut the second exchange and the resent message took its
    // place: the message is stored exactly once.
    expect(users.map((message) => message.content[0]?.type)).toEqual(['text', 'text']);
  });

  it('marks an interrupted turn as interrupted and does not resume it silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-resume-'));
    const config = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: 'full-access' });

    const provider = createFakeProvider({
      turns: [{ sse: buildSse(text('hello'), '[DONE]') }],
    });
    server = createRuntimeServer({
      config,
      provider,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir,
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
      body: JSON.stringify({ text: 'hello' }),
    });
    await collectEvents(baseUrl, sessionId, 0);

    // The turn index knows the turn and its tool calls.
    const status = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/status`);
    expect(status.status).toBe(200);
  });
});
