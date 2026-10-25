import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeProvider, buildSse } from '@local-agent/local-runtime';
import { createSessionArtifacts } from '@local-agent/local-runtime';
import { createApplication, type Application } from '@local-agent/local-runtime-v2';

/**
 * End-to-end: the plan mode.
 *
 * The agent plans, the user reviews the frozen snapshot, and the
 * implementation turn follows the snapshot — not the draft that may have
 * changed in between.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const text = (value: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\n`;

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

interface HistoryEntry {
  readonly role: string;
  readonly content: { readonly type: string; text?: string }[];
}

const readHistory = async (baseUrl: string, sessionId: string): Promise<HistoryEntry[]> => {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/history`);
  const body = (await response.json()) as { messages: HistoryEntry[] };
  return body.messages;
};

describe('end-to-end plan mode', () => {
  let application: Application | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  const start = async (): Promise<{ baseUrl: string; dataDir: string; sessionId: string }> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-plan-e2e-'));
    const provider = createFakeProvider({
      turns: [
        // The plan turn: the agent writes the draft with plan_write, then
        // answers. Every tool call is followed by another step.
        {
          sse: buildSse(
            toolCall(0, 'call_plan', 'plan_write', {
              content: '# Plan\n\n1. the approved step\n',
            }),
            '[DONE]',
          ),
        },
        { sse: buildSse(text('The plan is written.'), '[DONE]') },
        // The implementation turn, after the user approved the plan.
        { sse: buildSse(text('Implemented.'), '[DONE]') },
      ],
    });

    application = createApplication({
      config: {
        config: {
          host: '127.0.0.1',
          httpPort: 0,
          permissionMode: 'full-access',
          providers: [],
          events: { retainCount: 2000 },
          tools: { maxResultBytes: 32768, maxCallBytes: 262144, maxLines: 2000 },
        },
        secrets: new Map(),
      },
      provider,
      logger: quietLogger,
      writeRuntimeFile: false,
      env: {},
      dataDir,
    });

    const port = await application.listen(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'plan' }),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

    return { baseUrl, dataDir, sessionId };
  };

  it('plans, freezes, reviews and implements from the frozen snapshot', async () => {
    const { baseUrl, dataDir, sessionId } = await start();

    // 1. Enter the plan mode.
    const entered = await fetch(`${baseUrl}/v1/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'plan' }),
    });
    expect(entered.status).toBe(200);

    const planState = await fetch(`${baseUrl}/v1/sessions/${sessionId}/plan`);
    const planBody = (await planState.json()) as { mode: string; blocked: boolean };
    expect(planBody.mode).toBe('plan');

    // 2. The agent writes the draft: the message runs in the plan mode, and
    //    the plan tools are the only ones it gets.
    await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write me a plan' }),
    });

    const artifacts = createSessionArtifacts(sessionId, { dataDir });
    let draft = '';
    for (let attempt = 0; attempt < 100 && draft.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      draft = (await artifacts.read('artifacts/plan.md')) ?? '';
    }
    expect(draft).toContain('the approved step');

    // 3. Leave the plan mode: the draft is frozen and the review is asked.
    const exited = await fetch(`${baseUrl}/v1/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'default' }),
    });
    expect(exited.status).toBe(200);
    const exitedBody = (await exited.json()) as {
      review: { requestId: string; markdown: string };
    };
    expect(exitedBody.review.markdown).toContain('the approved step');

    // 4. The fence holds the ordinary turns back.
    const blocked = await fetch(`${baseUrl}/v1/sessions/${sessionId}/status`);
    const blockedBody = (await blocked.json()) as { pendingApprovals: string[] };
    expect(blockedBody.pendingApprovals).toEqual([]);

    // 5. The user approves the plan.
    const approved = await fetch(`${baseUrl}/v1/sessions/${sessionId}/plan/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: exitedBody.review.requestId, decision: 'approve' }),
    });
    expect(approved.status).toBe(200);

    // 6. The draft changes after the approval: the snapshot stays the authority.
    await artifacts.write('artifacts/plan.md', '# Plan\n\n1. a later edit\n');

    // 7. The implementation turn follows the frozen snapshot.
    await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'implement it' }),
    });

    const history = await readHistory(baseUrl, sessionId);
    const injected = history.find((message) => message.role === 'system');
    expect(injected).toBeDefined();
    expect(injected?.content[0]?.text).toContain('the approved step');
    expect(injected?.content[0]?.text).not.toContain('a later edit');
  });

  it('keeps the review pending and the fence closed until the user answers', async () => {
    const { baseUrl, dataDir, sessionId } = await start();

    await fetch(`${baseUrl}/v1/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'plan' }),
    });
    const artifacts = createSessionArtifacts(sessionId, { dataDir });
    await artifacts.write('artifacts/plan.md', '# Plan\n');

    await fetch(`${baseUrl}/v1/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'default' }),
    });

    const planState = await fetch(`${baseUrl}/v1/sessions/${sessionId}/plan`);
    const body = (await planState.json()) as { blocked: boolean; review: { state: string } };
    expect(body.blocked).toBe(true);
    expect(body.review.state).toBe('pending');

    // A message submitted while the fence is closed is deferred: it is kept
    // but it does not run.
    const submitted = await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do it' }),
    });
    expect(submitted.status).toBe(202);
    const submittedBody = (await submitted.json()) as { turnId?: string; deferred?: boolean };
    expect(submittedBody.deferred).toBe(true);
  });
});
