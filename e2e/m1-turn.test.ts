import { mkdtempSync } from 'node:fs';
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
 * End-to-end: a recorded-replay provider drives a full turn.
 *
 * Nothing here touches the network: the fixture is replayed through the same
 * SSE parser the real adapters use.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const FIXTURE = buildSse(
  JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
  JSON.stringify({ choices: [{ delta: { content: ' from the fake provider' } }] }),
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  }),
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

describe('end-to-end turn', () => {
  let server: RuntimeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (): Promise<string> => {
    const provider = createFakeProvider({ turns: [{ sse: FIXTURE }] });
    const config = loadRuntimeConfig({}, { readFile: false });
    server = createRuntimeServer({
      config,
      provider,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir: mkdtempSync(join(tmpdir(), 'local-agent-e2e-')),
    });
    const port = await server.listen(0);
    return `http://127.0.0.1:${port}`;
  };

  it('runs a turn from a user message to the assistant reply', async () => {
    const baseUrl = await start();

    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'e2e' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { session: { id: string } };
    const sessionId = createdBody.session.id;

    const status = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/status`);
    const statusBody = (await status.json()) as { latestEventOffset: number };

    const submitted = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'say hello' }),
    });
    expect(submitted.status).toBe(202);
    const submittedBody = (await submitted.json()) as { turnId: string };
    expect(submittedBody.turnId).toMatch(/^turn_/);

    const events = await collectEvents(baseUrl, sessionId, statusBody.latestEventOffset);
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('session.status');
    expect(types).toContain('step.started');
    expect(types).toContain('llm.request.started');
    expect(types).toContain('message.delta');
    expect(types).toContain('message.completed');
    expect(types.at(-1)).toBe('session.status');

    const terminal = events.at(-1);
    if (terminal?.type === 'session.status') {
      expect(terminal.status).toBe('completed');
    }

    // The deltas carry the whole reply.
    const text = events
      .filter((event): event is RuntimeEvent & { type: 'message.delta' } => event.type === 'message.delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('Hello from the fake provider');

    // Every event belongs to the same turn and the sequence is contiguous.
    const offsets = events.map((event) => event.logOffset);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(new Set(offsets).size).toBe(offsets.length);
    for (const event of events) {
      expect(event.turnId).toBe(submittedBody.turnId);
    }
  });

  it('lands the user message and the assistant reply in the history', async () => {
    const baseUrl = await start();

    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createdBody = (await created.json()) as { session: { id: string } };
    const sessionId = createdBody.session.id;

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'say hello' }),
    });
    await collectEvents(baseUrl, sessionId, 0);

    const history = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/history`);
    const body = (await history.json()) as { messages: { role: string; content: { type: string; text?: string }[] }[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content[0]?.text).toBe('say hello');
    expect(body.messages[1]?.role).toBe('assistant');
    expect(body.messages[1]?.content[0]?.text).toBe('Hello from the fake provider');
  });

  it('resumes the event stream from an offset without duplicates', async () => {
    const baseUrl = await start();

    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createdBody = (await created.json()) as { session: { id: string } };
    const sessionId = createdBody.session.id;

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'say hello' }),
    });

    const all = await collectEvents(baseUrl, sessionId, 0);
    expect(all.length).toBeGreaterThan(2);

    // Reconnect from the second event: the client must receive the rest and
    // nothing it already had.
    const resumeAfter = all[1]?.logOffset ?? 0;
    const resumed = await collectEvents(baseUrl, sessionId, resumeAfter);

    expect(resumed.length).toBe(all.length - 2);
    expect(resumed[0]?.logOffset).toBe(resumeAfter + 1);
    const resumedOffsets = resumed.map((event) => event.logOffset);
    expect(new Set(resumedOffsets).size).toBe(resumedOffsets.length);
  });

  it('reports a structured error for an unknown session', async () => {
    const baseUrl = await start();
    const response = await fetchResilient(`${baseUrl}/v1/sessions/sess_missing/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
