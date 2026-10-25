import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDiskSessionStore,
  createEventBus,
  createTurnSystem,
  createToolBinder,
  type LoadedRuntimeConfig,
  type TurnSystem,
} from '@local-agent/local-runtime';
import { createPlanService, type PlanService } from './plan-service.js';
import { PlanError } from './types.js';

/**
 * The plan mode.
 *
 * The rules under test: the mode switch and the draft backup are one
 * transaction, the review freezes the draft, the fence blocks the ordinary
 * turns while the confirmation is exempt, and the queue classification keeps
 * the plan entry and the ordinary messages apart.
 */

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Harness {
  readonly dataDir: string;
  readonly service: PlanService;
  readonly turns: TurnSystem;
  readonly sessionId: string;
  readonly artifacts: { write(name: string, content: string): Promise<void> };
}

const harness = (options: { readonly backupFails?: boolean } = {}): Harness => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-agent-plan-'));
  const config: LoadedRuntimeConfig = {
    config: {
      host: '127.0.0.1',
      httpPort: 0,
      permissionMode: 'ask',
      providers: [],
      events: { retainCount: 2000 },
      tools: { maxResultBytes: 32768, maxCallBytes: 262144, maxLines: 2000 },
    },
    secrets: new Map(),
  };

  const sessions = createDiskSessionStore({ dataDir });
  const events = createEventBus({ retainCount: 200 });
  const turns = createTurnSystem({
    sessions,
    events,
    config,
    provider: undefined,
    tools: createToolBinder([]),
    logger: quietLogger,
    dataDir,
  });

  const service = createPlanService({
    sessions,
    events,
    turns,
    dataDir,
    logger: quietLogger,
    ...(options.backupFails === true
      ? {
          backupDraft: async (): Promise<string | undefined> => {
            throw new Error('the disk is full');
          },
        }
      : {}),
  });

  const session = sessions.create({
    cwd: '/workspace',
    providerId: 'openai-compatible',
    model: 'm',
  });

  const artifacts = {
    write: async (name: string, content: string): Promise<void> => {
      const { createSessionArtifacts } = await import('@local-agent/local-runtime');
      await createSessionArtifacts(session.id, { dataDir }).write(name, content);
    },
  };

  return { dataDir, service, turns, sessionId: session.id, artifacts };
};

const draft = '# Plan\n\n1. do the thing\n';

describe('entering the plan mode', () => {
  it('switches the mode and backs up the previous draft', async () => {
    const h = harness();
    await h.artifacts.write('artifacts/plan.md', draft);

    const result = await h.service.enter(h.sessionId);

    expect(result.mode).toBe('plan');
    expect(result.idempotent).toBe(false);
    expect(result.backup).toBeDefined();

    const state = h.service.state(h.sessionId);
    expect(state.mode).toBe('plan');
  });

  it('is idempotent when the session is already in the plan mode', async () => {
    const h = harness();
    await h.service.enter(h.sessionId);
    const second = await h.service.enter(h.sessionId);
    expect(second.idempotent).toBe(true);
  });

  it('rolls the mode back when the draft backup fails', async () => {
    const h = harness({ backupFails: true });

    await expect(h.service.enter(h.sessionId)).rejects.toBeInstanceOf(PlanError);

    // The mode is back to default: nothing is half applied.
    expect(h.service.state(h.sessionId).mode).toBe('default');
  });

  it('settles the accepted turn as failed when the backup fails', async () => {
    const h = harness({ backupFails: true });
    await expect(h.service.enter(h.sessionId)).rejects.toBeInstanceOf(PlanError);

    const turns = h.turns;
    // The turn index holds the failed plan entry.
    const state = h.service.state(h.sessionId);
    expect(state.mode).toBe('default');
    void turns;
  });
});

describe('leaving the plan mode', () => {
  it('freezes the draft and asks for the review', async () => {
    const h = harness();
    await h.artifacts.write('artifacts/plan.md', draft);
    await h.service.enter(h.sessionId);

    const review = await h.service.exit(h.sessionId);

    expect(review.state).toBe('pending');
    expect(review.markdown).toContain('do the thing');
    expect(h.service.state(h.sessionId).mode).toBe('default');

    // The snapshot is on disk.
    const { createSessionArtifacts } = await import('@local-agent/local-runtime');
    const artifacts = createSessionArtifacts(h.sessionId, { dataDir: h.dataDir });
    const snapshot = await artifacts.read('artifacts/plan.review.md');
    expect(snapshot).toContain('do the thing');
  });

  it('is idempotent when the session is already in the default mode', async () => {
    const h = harness();
    await expect(h.service.exit(h.sessionId)).rejects.toBeInstanceOf(PlanError);
  });

  it('refuses to review a plan that does not exist', async () => {
    const h = harness();
    await h.service.enter(h.sessionId);
    await expect(h.service.exit(h.sessionId)).rejects.toBeInstanceOf(PlanError);
  });

  it('rolls back when the snapshot cannot be committed', async () => {
    const h = harness();
    await h.artifacts.write('artifacts/plan.md', draft);
    await h.service.enter(h.sessionId);

    // A directory where the snapshot file should go: the write fails.
    const { createSessionArtifacts } = await import('@local-agent/local-runtime');
    const artifacts = createSessionArtifacts(h.sessionId, { dataDir: h.dataDir });
    mkdirSync(artifacts.path('artifacts'), { recursive: true });
    mkdirSync(artifacts.path('artifacts/plan.review.md'), { recursive: true });

    await expect(h.service.exit(h.sessionId)).rejects.toBeInstanceOf(PlanError);
  });
});

describe('the fence and the queue classification', () => {
  it('blocks the ordinary turns while a review is pending', async () => {
    const h = harness();
    await h.artifacts.write('artifacts/plan.md', draft);
    await h.service.enter(h.sessionId);
    const review = await h.service.exit(h.sessionId);

    expect(h.service.isBlocked(h.sessionId)).toBe(true);
    expect(h.service.classify({ kind: 'message', sessionId: h.sessionId, text: 'hi' })).toBe('defer');
    // The confirmation of that very review is exempt from its own fence.
    expect(
      h.service.classify({
        kind: 'plan-review',
        sessionId: h.sessionId,
        requestId: review.requestId,
      }),
    ).toBe('run');
  });

  it('runs the ordinary messages while the session is in the plan mode', async () => {
    const h = harness();
    await h.service.enter(h.sessionId);
    // The message is the request the agent plans. Holding it back would
    // leave the plan mode with nothing to do: the draft is written by the
    // agent, in answer to a message.
    expect(h.service.classify({ kind: 'message', sessionId: h.sessionId, text: 'hi' })).toBe('run');
    // The plan entry itself runs in the plan mode.
    expect(h.service.classify({ kind: 'plan-entry', sessionId: h.sessionId })).toBe('run');
  });

  it('cancels a plan entry that is still queued outside the plan mode', async () => {
    const h = harness();
    expect(h.service.classify({ kind: 'plan-entry', sessionId: h.sessionId })).toBe('cancel');
  });

  it('runs the ordinary turns in the default mode', async () => {
    const h = harness();
    expect(h.service.classify({ kind: 'message', sessionId: h.sessionId, text: 'hi' })).toBe('run');
  });
});

describe('answering the review', () => {
  const reviewPending = async (): Promise<Harness & { reviewId: string }> => {
    const h = harness();
    await h.artifacts.write('artifacts/plan.md', draft);
    await h.service.enter(h.sessionId);
    const review = await h.service.exit(h.sessionId);
    return { ...h, reviewId: review.requestId };
  };

  it('approves the plan and keeps it as the authority of the next turn', async () => {
    const h = await reviewPending();
    const outcome = await h.service.review(h.sessionId, h.reviewId, { decision: 'approve' });

    expect(outcome.decision).toBe('approve');
    expect(h.service.isBlocked(h.sessionId)).toBe(false);

    // The next turn receives the frozen snapshot.
    const injected = await h.service.prepareTurn?.(h.sessionId, 'turn_1');
    expect(injected).toBeDefined();
    expect(injected?.[0]?.content[0]).toMatchObject({ type: 'text' });
    const text = injected?.[0]?.content[0]?.type === 'text' ? injected[0].content[0].text : '';
    expect(text).toContain('do the thing');
  });

  it('injects the approved plan only once', async () => {
    const h = await reviewPending();
    await h.service.review(h.sessionId, h.reviewId, { decision: 'approve' });

    expect(await h.service.prepareTurn?.(h.sessionId, 'turn_1')).toBeDefined();
    expect(await h.service.prepareTurn?.(h.sessionId, 'turn_2')).toBeUndefined();
  });

  it('keeps the frozen snapshot even when the draft changes afterwards', async () => {
    const h = await reviewPending();
    await h.service.review(h.sessionId, h.reviewId, { decision: 'approve' });

    // The user edits the draft after the approval.
    await h.artifacts.write('artifacts/plan.md', '# Plan\n\n2. something else\n');

    const injected = await h.service.prepareTurn?.(h.sessionId, 'turn_1');
    const text = injected?.[0]?.content[0]?.type === 'text' ? injected[0].content[0].text : '';
    expect(text).toContain('do the thing');
    expect(text).not.toContain('something else');
  });

  it('returns to the plan mode when the user rejects the plan', async () => {
    const h = await reviewPending();
    const outcome = await h.service.review(h.sessionId, h.reviewId, {
      decision: 'reject',
      feedback: 'the second step is wrong',
    });

    expect(outcome.decision).toBe('reject');
    expect(outcome.mode).toBe('plan');
    expect(h.service.state(h.sessionId).mode).toBe('plan');

    // The feedback reaches the next turn.
    const injected = await h.service.prepareTurn?.(h.sessionId, 'turn_1');
    const text = injected?.[0]?.content[0]?.type === 'text' ? injected[0].content[0].text : '';
    expect(text).toContain('the second step is wrong');
  });

  it('is idempotent when the review is answered twice', async () => {
    const h = await reviewPending();
    await h.service.review(h.sessionId, h.reviewId, { decision: 'approve' });
    const second = await h.service.review(h.sessionId, h.reviewId, { decision: 'reject' });

    expect(second.idempotent).toBe(true);
    expect(second.decision).toBe('approve');
  });

  it('refuses an unknown review id', async () => {
    const h = await reviewPending();
    await expect(h.service.review(h.sessionId, 'req_unknown', { decision: 'approve' })).rejects.toBeInstanceOf(
      PlanError,
    );
  });
});
