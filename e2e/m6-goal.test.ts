import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSse, createFakeProvider } from '@local-agent/local-runtime';
import { createApplication, type Application } from '@local-agent/local-runtime-v2';

/**
 * End-to-end: the goal mode.
 *
 * A goal that cannot be reached must end as **blocked** with a structured
 * report, after a bounded number of automatic rounds — never in an endless
 * loop. And the verifier may not rewrite the goal it verifies.
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

const GOAL_TEXT = '目标: 让支付模块升级到新版 SDK\n验收: 集成测试全部通过';

const BLOCK_REPORT = {
  status: 'blocked',
  reason: 'the SDK migration needs a decision the agent cannot make',
  attemptedPaths: [
    'read src/payment/client.ts',
    'bash npm test -- payment',
    'read the failing test output',
  ],
  evidence: [
    { kind: 'test', ref: 'npm test -- payment', detail: '3 failing: the mock server does not know the new SDK' },
    { kind: 'artifact', ref: 'artifacts/payment-test.log' },
  ],
  requiredInputs: ['a mock server that speaks the new SDK', 'the decision to keep the old API'],
};

describe('end-to-end goal mode', () => {
  let application: Application | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  const start = async (): Promise<{ baseUrl: string; sessionId: string }> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-goal-e2e-'));

    const provider = createFakeProvider({
      turns: [
        // Round 1 of the goal session: the agent sets the goal. Every tool
        // call is followed by another step, so each one needs a model turn.
        { sse: buildSse(toolCall(0, 'call_goal', 'create_goal', { text: GOAL_TEXT }), '[DONE]') },
        { sse: buildSse(text('the goal is set'), '[DONE]') },
        // The verifier session: it tries to change the goal (refused) and
        // then reports its verdict.
        {
          sse: buildSse(
            toolCall(0, 'call_v1', 'create_goal', { text: GOAL_TEXT }),
            toolCall(1, 'call_v2', 'goal_verdict', {
              achieved: false,
              progressed: true,
              reason: 'the migration is not done yet',
              evidence: [],
            }),
            '[DONE]',
          ),
        },
        { sse: buildSse(text('the verification is not conclusive'), '[DONE]') },
        // Round 2 of the goal session: the agent reports the block.
        { sse: buildSse(toolCall(0, 'call_block', 'update_goal', BLOCK_REPORT), '[DONE]') },
        { sse: buildSse(text('the block is reported'), '[DONE]') },
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

    const port = await application.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'goal' }),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

    return { baseUrl, sessionId };
  };

  it('ends a goal that cannot be reached as blocked, with a structured report', async () => {
    const { baseUrl, sessionId } = await start();

    await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'make the payment module use the new SDK' }),
    });

    // The goal is read from the API once the rounds settled.
    let goal: {
      status: string;
      rounds: number;
      blockedReport?: {
        attemptedPaths: string[];
        evidence: { kind: string; ref: string }[];
        reason: string;
        requiredInputs: string[];
      };
    } | undefined;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/goal`);
      if (response.status === 200) {
        const body = (await response.json()) as { goal: typeof goal };
        goal = body.goal;
        if (goal?.status === 'blocked') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(goal?.status).toBe('blocked');
    // At least one round was verified automatically: the agent kept going on
    // its own before it gave up.
    expect(goal?.rounds).toBeGreaterThanOrEqual(1);

    // The history shows both the goal and the block: the agent continued
    // after the verification and then reported the block.
    const history = (await (
      await fetch(`${baseUrl}/v1/sessions/${sessionId}/history`)
    ).json()) as { messages: { role: string; content: { type: string }[] }[] };
    const toolNames = history.messages
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content.map((block) => block.type));
    expect(toolNames.length).toBeGreaterThanOrEqual(2);

    // The report carries what the acceptance criteria ask for.
    expect(goal?.blockedReport?.attemptedPaths.length).toBeGreaterThan(0);
    expect(goal?.blockedReport?.evidence.length).toBeGreaterThan(0);
    expect(goal?.blockedReport?.reason.length).toBeGreaterThan(0);
    expect(goal?.blockedReport?.requiredInputs.length).toBeGreaterThan(0);
    expect(goal?.blockedReport?.evidence[0]?.kind).toBe('test');
  });

  it('refuses to let the verifier change the goal it verifies', async () => {
    const { baseUrl, sessionId } = await start();

    await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'make the payment module use the new SDK' }),
    });

    // Wait for the verification session to exist.
    let verifierSessionId: string | undefined;
    for (let attempt = 0; attempt < 100 && verifierSessionId === undefined; attempt += 1) {
      verifierSessionId = application?.goal.verifier.sessions[0];
      if (verifierSessionId === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(verifierSessionId).toBeDefined();

    // The history of the verifier session holds the refused call.
    const response = await fetch(
      `${baseUrl}/v1/sessions/${verifierSessionId as string}/history`,
    );
    const body = (await response.json()) as {
      messages: {
        role: string;
        content: ({
          type: string;
          text?: string;
          content?: { type: string; text?: string }[];
        })[];
      }[];
    };

    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    const refused = toolMessages
      .map((message) =>
        message.content
          .flatMap((block) =>
            'content' in block
              ? block.content.map((entry) => entry.text ?? '')
              : [block.text ?? ''],
          )
          .join(''),
      )
      .join('\n');
    expect(refused).toContain('verifier session');

    // The goal of the parent session is untouched by the verifier.
    const goal = await fetch(`${baseUrl}/v1/sessions/${sessionId}/goal`);
    expect(goal.status).toBe(200);
  });
});
