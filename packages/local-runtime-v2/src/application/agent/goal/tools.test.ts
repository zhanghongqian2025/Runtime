import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { createDiskSessionStore, createEventBus } from '@local-agent/local-runtime';
import { createGoalStore } from './store.js';
import { createGoalService, type GoalService } from './service.js';

/**
 * The goal tools.
 *
 * The rule that matters: a **verifier session may not change the goal it is
 * verifying**. The call is refused, not silently ignored.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const GOAL_TEXT = '目标: 让支付模块升级\n验收: 集成测试通过';

interface Harness {
  readonly service: GoalService;
  readonly sessionId: string;
  readonly verifierSessionId: string;
  readonly tool: (name: string) => ToolImpl;
}

const harness = async (): Promise<Harness> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-goal-'));
  const sessions = createDiskSessionStore({ dataDir });
  const events = createEventBus({ retainCount: 100 });
  const store = createGoalStore({ dataDir });

  const service = createGoalService({
    sessions,
    events,
    turns: {
      submit: async () => ({ turnId: undefined, queued: 0, deferred: false, cancelled: false }),
    } as never,
    store,
    logger: quietLogger,
    tools: {
      resolve: () => undefined,
      list: () => [],
      bind: () => [],
    },
    toolsForVerifier: () => ({ resolve: () => undefined, list: () => [], bind: () => [] }),
    cwd: '/workspace',
    providerId: 'openai-compatible',
    model: 'm',
  });

  const session = sessions.create({
    cwd: '/workspace',
    providerId: 'openai-compatible',
    model: 'm',
  });
  const verifier = sessions.create({
    cwd: '/workspace',
    providerId: 'openai-compatible',
    model: 'm',
  });

  const byName = new Map(service.tools.map((tool) => [tool.definition.name, tool]));

  return {
    service,
    sessionId: session.id,
    verifierSessionId: verifier.id,
    tool: (name: string) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool;
    },
  };
};

const contextFor = (sessionId: string) => ({
  sessionId,
  turnId: 'turn_1',
  toolCallId: 'tool_1',
  cwd: '/workspace',
  env: {},
  now: () => 0,
  requestPermission: async () => ({
    requestId: 'req_1',
    choice: 'deny' as const,
    decidedBy: 'policy' as const,
  }),
  onFileChanged: () => undefined,
  emitEvent: async () => undefined,
  askUser: async (request: { requestId: string }) => ({
    requestId: request.requestId,
    answers: {},
  }),
  artifacts: {
    path: (name: string) => name,
    write: async () => undefined,
    append: async () => undefined,
    read: async () => undefined,
  },
  limits: { maxBytes: 32768, maxLines: 2000 },
  log: quietLogger,
});

describe('the goal tools', () => {
  it('creates a goal from a checkable text', async () => {
    const h = await harness();
    const create = h.tool('create_goal');
    const result = await create.execute(
      contextFor(h.sessionId),
      { text: GOAL_TEXT },
      new AbortController().signal,
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(h.service.read(h.sessionId)?.status).toBe('active');
    expect(h.service.read(h.sessionId)?.spec.objective).toContain('支付模块');
  });

  it('refuses to create a goal in a verifier session', async () => {
    const h = await harness();
    // The verifier session is registered when it verifies something.
    h.service.registerVerifierSession(h.verifierSessionId);

    const create = h.tool('create_goal');
    const result = await create.execute(
      contextFor(h.verifierSessionId),
      { text: GOAL_TEXT },
      new AbortController().signal,
      () => undefined,
    );

    expect(result.ok).toBe(false);
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('verifier session');
  });

  it('refuses to change a goal in a verifier session', async () => {
    const h = await harness();
    h.service.registerVerifierSession(h.verifierSessionId);

    const update = h.tool('update_goal');
    const result = await update.execute(
      contextFor(h.verifierSessionId),
      { status: 'completed' },
      new AbortController().signal,
      () => undefined,
    );

    expect(result.ok).toBe(false);
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('verifier session');
  });

  it('reads the goal', async () => {
    const h = await harness();
    const create = h.tool('create_goal');
    await create.execute(
      contextFor(h.sessionId),
      { text: GOAL_TEXT },
      new AbortController().signal,
      () => undefined,
    );

    const get = h.tool('get_goal');
    const result = await get.execute(
      contextFor(h.sessionId),
      {},
      new AbortController().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('active');
    expect(text).toContain('集成测试通过');
  });

  it('reports that there is no goal', async () => {
    const h = await harness();
    const get = h.tool('get_goal');
    const result = await get.execute(
      contextFor(h.sessionId),
      {},
      new AbortController().signal,
      () => undefined,
    );
    expect(result.ok).toBe(false);
  });
});
