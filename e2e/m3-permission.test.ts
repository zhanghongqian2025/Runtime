import { mkdtempSync, existsSync } from 'node:fs';
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
 * End-to-end: the permission core in the loop.
 *
 * A denied call never runs, and an asked call waits for a human answer.
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

describe('end-to-end permissions', () => {
  let server: RuntimeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (
    mode: string,
    turns: readonly { readonly sse: string }[],
  ): Promise<{ baseUrl: string; workspace: string }> => {
    const workspace = mkdtempSync(join(tmpdir(), 'local-agent-perm-'));
    const provider = createFakeProvider({ turns });
    const config = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: mode }, { readFile: false });
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
    return { baseUrl: `http://127.0.0.1:${port}`, workspace };
  };

  const createSession = async (baseUrl: string): Promise<string> => {
    const created = await fetchResilient(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    return ((await created.json()) as { session: { id: string } }).session.id;
  };

  const dangerousTurn = {
    sse: buildSse(call('c1', 'bash', { command: 'rm -rf /' }), '[DONE]'),
  };
  const writeTurn = {
    sse: buildSse(
      call('c2', 'write', { path: 'allowed.txt', content: 'written after approval\n' }),
      '[DONE]',
    ),
  };

  it('blocks a dangerous command without running it', async () => {
    const { baseUrl, workspace } = await start('ask', [dangerousTurn]);
    const sessionId = await createSession(baseUrl);

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'clean up' }),
    });

    const events = await collectEvents(baseUrl, sessionId, 0);
    const blocked = events.filter((event) => event.type === 'tool.call.blocked');
    expect(blocked).toHaveLength(1);
    if (blocked[0]?.type === 'tool.call.blocked') {
      expect(blocked[0].blockedBy).toBe('permission');
      expect(blocked[0].name).toBe('bash');
      expect(blocked[0].reason.length).toBeGreaterThan(0);
    }

    // The tool never ran: there is no tool completion event for it.
    expect(events.filter((event) => event.type === 'tool.call.completed')).toHaveLength(0);
    expect(existsSync(join(workspace, 'allowed.txt'))).toBe(false);
  });

  it('asks for approval and runs the tool once the user allows it', async () => {
    const { baseUrl, workspace } = await start('ask', [writeTurn]);
    const sessionId = await createSession(baseUrl);

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write a file' }),
    });

    // The turn waits for the approval.
    let pending: string[] = [];
    for (let attempt = 0; attempt < 50 && pending.length === 0; attempt += 1) {
      const status = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/status`);
      const body = (await status.json()) as { pendingApprovals: string[] };
      pending = body.pendingApprovals;
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pending).toHaveLength(1);

    const answered = await fetchResilient(
      `${baseUrl}/v1/sessions/${sessionId}/permissions/${pending[0]}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice: 'allow-once' }),
      },
    );
    expect(answered.status).toBe(200);

    const events = await collectEvents(baseUrl, sessionId, 0);
    expect(events.filter((event) => event.type === 'permission.requested')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'permission.resolved')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.call.completed')).toHaveLength(1);
    expect(existsSync(join(workspace, 'allowed.txt'))).toBe(true);
  });

  it('keeps the tool from running when the user denies', async () => {
    const { baseUrl, workspace } = await start('ask', [writeTurn]);
    const sessionId = await createSession(baseUrl);

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write a file' }),
    });

    let pending: string[] = [];
    for (let attempt = 0; attempt < 50 && pending.length === 0; attempt += 1) {
      const status = await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/status`);
      const body = (await status.json()) as { pendingApprovals: string[] };
      pending = body.pendingApprovals;
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pending).toHaveLength(1);

    await fetchResilient(`${baseUrl}/v1/sessions/${sessionId}/permissions/${pending[0]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'deny' }),
    });

    const events = await collectEvents(baseUrl, sessionId, 0);
    expect(events.filter((event) => event.type === 'tool.call.blocked')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.call.completed')).toHaveLength(0);
    expect(existsSync(join(workspace, 'allowed.txt'))).toBe(false);
  });
});
