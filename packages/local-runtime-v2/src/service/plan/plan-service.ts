import { readFileSync, readdirSync } from 'node:fs';
import { newId } from '@local-agent/protocol';
import type { AgentMessage } from '@local-agent/protocol';
import type { ToolBinder } from '@local-agent/agent-core/tools';
import {
  PLAN_FILE,
  PLAN_REVIEW_FILE,
  PLAN_REVIEW_META_FILE,
  freezePlan,
  planBackupName,
} from '@local-agent/agent-extension/plan-mode';
import type { EventDelivery } from '@local-agent/local-runtime';
import { createSessionArtifacts } from '@local-agent/local-runtime';
import type { SessionStore } from '@local-agent/local-runtime';
import type { Logger } from '@local-agent/local-runtime';
import type { QueueClassification, QueueItem, TurnPolicy } from '@local-agent/local-runtime';
import type { TurnSystem } from '@local-agent/local-runtime';
import { PlanError, type PlanModeResult, type PlanModeState, type PlanReviewDecision, type PlanReviewOutcome, type PlanReviewState } from './types.js';

/**
 * The plan service.
 *
 * It owns the plan lifecycle: entering the mode, freezing the draft for the
 * review, answering the review and the fence that blocks the ordinary turns
 * while a review is pending.
 *
 * The compensation rules are the point of the whole thing: entering and
 * leaving the mode spans several steps, and a failure in the middle must not
 * leave the session in a half state.
 *
 * See docs/contracts.md §9.
 */

export const PLAN_REVIEW_STATE_FILE = 'pending/plan-review.json';

export interface PlanServiceOptions {
  readonly sessions: SessionStore;
  readonly events: EventDelivery;
  readonly turns: TurnSystem;
  readonly dataDir: string;
  readonly logger: Logger;
  /** The binder used while the session is in the plan mode. */
  readonly planBinder?: ToolBinder;
  /**
   * Backs up the current draft.
   *
   * The seam exists so the compensation path can be exercised: the default
   * writes the real backup file.
   */
  readonly backupDraft?: (sessionId: string) => Promise<string | undefined>;
}

export interface PlanService extends TurnPolicy {
  enter(sessionId: string): Promise<PlanModeResult>;
  exit(sessionId: string): Promise<PlanReviewState>;
  review(sessionId: string, requestId: string, decision: PlanReviewDecision): Promise<PlanReviewOutcome>;
  state(sessionId: string): PlanModeState;
  /** True while a review is waiting for an answer. */
  isBlocked(sessionId: string): boolean;
}

/** The approved plan: its metadata and the frozen markdown. */
interface StoredApprovedPlan {
  readonly meta: PlanReviewState['meta'];
  readonly markdown: string;
}

/** The persisted plan state of a session. */
interface StoredPlanState {
  readonly review?: PlanReviewState | undefined;
  readonly approvedPlan?: StoredApprovedPlan | undefined;
  readonly feedback?: string | undefined;
}

export function createPlanService(options: PlanServiceOptions): PlanService {
  const artifactsFor = (sessionId: string) =>
    createSessionArtifacts(sessionId, { dataDir: options.dataDir });

  // The plan state is read on every classification, so it is read directly
  // from the file: it is small and always fresh.
  const readState = (sessionId: string): StoredPlanState => {
    try {
      const raw = readFileSync(
        artifactsFor(sessionId).path(PLAN_REVIEW_STATE_FILE),
        'utf8',
      );
      return JSON.parse(raw) as StoredPlanState;
    } catch {
      return {};
    }
  };

  const writeState = async (sessionId: string, state: StoredPlanState): Promise<void> => {
    await artifactsFor(sessionId).write(PLAN_REVIEW_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  };

  const readDraft = async (sessionId: string): Promise<string | undefined> =>
    artifactsFor(sessionId).read(PLAN_FILE);

  /** Back up the current draft. Returns the backup name. */
  const defaultBackupDraft = async (sessionId: string): Promise<string | undefined> => {
    const draft = await readDraft(sessionId);
    if (draft === undefined) return undefined;
    const name = planBackupName(new Date().toISOString());
    await artifactsFor(sessionId).write(name, draft);
    return name;
  };

  const backupDraft = options.backupDraft ?? defaultBackupDraft;

  /** Restore the draft from its newest backup. */
  const restoreDraft = async (sessionId: string): Promise<void> => {
    const artifacts = artifactsFor(sessionId);
    let newest: string | undefined;
    try {
      const backups = readdirSync(artifacts.path('artifacts'))
        .filter((entry) => entry.startsWith('plan.md.bak-'))
        .sort();
      newest = backups.at(-1);
    } catch {
      newest = undefined;
    }
    if (newest === undefined) return;
    const source = artifacts.path(`artifacts/${newest}`);
    await artifacts.write(PLAN_FILE, readFileSync(source, 'utf8'));
  };

  const service: PlanService = {
    async enter(sessionId: string): Promise<PlanModeResult> {
      const session = options.sessions.get(sessionId);
      if (!session) {
        throw new PlanError('NOT_FOUND', `no session matches ${sessionId}`);
      }

      // Already in the plan mode: entering again is a no-op.
      if (session.interactionMode === 'plan') {
        return { mode: 'plan', idempotent: true, compensated: false };
      }

      // 1. The admission: the mode switch.
      const updated = options.sessions.update(sessionId, { interactionMode: 'plan' });
      if (!updated) {
        await restoreDraft(sessionId);
        throw new PlanError('ADMISSION_REJECTED', 'the plan mode could not be entered');
      }

      // 2. Accept the plan entry turn.
      const entry = options.turns.acceptPlanEntry(sessionId);

      // 3. The draft commit: back up the previous draft.
      try {
        const backup = await backupDraft(sessionId);
        options.events.publishHost(sessionId, {
          type: 'plan.mode.changed',
          mode: 'plan',
          reason: 'the plan mode was entered',
        });
        return {
          mode: 'plan',
          idempotent: false,
          compensated: false,
          ...(backup === undefined ? {} : { backup }),
          turnId: entry.turnId,
        };
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        // Compensate: the mode, the draft and the accepted turn.
        options.sessions.update(sessionId, { interactionMode: 'default' });
        await restoreDraft(sessionId);
        options.turns.failTurn(
          sessionId,
          entry.turnId,
          `the plan mode was rolled back: the draft backup failed (${reason})`,
        );
        options.events.publishHost(sessionId, {
          type: 'plan.mode.changed',
          mode: 'default',
          reason: 'the plan mode was rolled back: the draft backup failed',
        });
        throw new PlanError(
          'COMPENSATED',
          `the plan mode was rolled back: the draft backup failed (${reason})`,
        );
      }
    },

    async exit(sessionId: string): Promise<PlanReviewState> {
      const session = options.sessions.get(sessionId);
      if (!session) {
        throw new PlanError('NOT_FOUND', `no session matches ${sessionId}`);
      }

      const stored = readState(sessionId);

      // Leaving the plan mode twice is idempotent.
      if (session.interactionMode !== 'plan') {
        if (stored.review !== undefined) return stored.review;
        throw new PlanError('CONFLICT', 'the session is not in the plan mode');
      }

      // 1. The admission: freeze the draft.
      const draft = await readDraft(sessionId);
      if (draft === undefined) {
        throw new PlanError('NO_PLAN', 'there is no plan draft to review');
      }

      const frozen = freezePlan(draft, {
        planId: newId('request'),
        frozenAt: new Date().toISOString(),
      });

      // 2. Accept the exit turn.
      const entry = options.turns.acceptPlanEntry(sessionId);

      // 3. The draft commit: write the snapshot and leave the mode.
      try {
        const artifacts = artifactsFor(sessionId);
        await artifacts.write(PLAN_REVIEW_FILE, frozen.markdown);
        await artifacts.write(
          PLAN_REVIEW_META_FILE,
          `${JSON.stringify(frozen.meta, null, 2)}\n`,
        );
        const updated = options.sessions.update(sessionId, { interactionMode: 'default' });
        if (!updated) {
          throw new Error('the session could not be updated');
        }
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        // Compensate: restore the draft and settle the accepted turn.
        await restoreDraft(sessionId);
        options.turns.failTurn(
          sessionId,
          entry.turnId,
          `the plan exit was rolled back: the snapshot could not be committed (${reason})`,
        );
        throw new PlanError(
          'COMPENSATED',
          `the plan exit was rolled back: the snapshot could not be committed (${reason})`,
        );
      }

      const review: PlanReviewState = {
        requestId: newId('request'),
        sessionId,
        planId: frozen.meta.planId,
        frozenAt: frozen.meta.frozenAt,
        markdown: frozen.markdown,
        meta: frozen.meta,
        state: 'pending',
      };

      await writeState(sessionId, { ...stored, review });

      options.events.publishHost(sessionId, {
        type: 'plan.review.requested',
        review: {
          requestId: review.requestId,
          planId: review.planId,
          frozenAt: review.frozenAt,
          markdown: review.markdown,
        },
      });

      return review;
    },

    async review(
      sessionId: string,
      requestId: string,
      decision: PlanReviewDecision,
    ): Promise<PlanReviewOutcome> {
      const session = options.sessions.get(sessionId);
      if (!session) {
        throw new PlanError('NOT_FOUND', `no session matches ${sessionId}`);
      }

      const stored = readState(sessionId);
      const review = stored.review;
      if (!review || review.requestId !== requestId) {
        throw new PlanError('NOT_FOUND', 'no review is waiting for this id');
      }

      // Answering twice is idempotent.
      if (review.state !== 'pending') {
        return {
          requestId: review.requestId,
          decision: review.state === 'approved' ? 'approve' : 'reject',
          mode: session.interactionMode,
          idempotent: true,
        };
      }

      if (decision.decision === 'approve') {
        const approved: PlanReviewState = { ...review, state: 'approved' };
        await writeState(sessionId, {
          ...stored,
          review: approved,
          approvedPlan: {
            meta: { ...approved.meta, consumed: false },
            markdown: approved.markdown,
          },
          feedback: undefined,
        });
        options.events.publishHost(sessionId, {
          type: 'plan.review.resolved',
          requestId: review.requestId,
          decision: 'approve',
        });
        // The fence is open: the deferred turns may run.
        options.turns.resumeDeferred(sessionId);
        return { requestId: review.requestId, decision: 'approve', mode: 'default', idempotent: false };
      }

      const rejected: PlanReviewState = {
        ...review,
        state: 'rejected',
        ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
      };
      await writeState(sessionId, {
        ...stored,
        review: rejected,
        feedback: decision.feedback,
      });
      options.events.publishHost(sessionId, {
        type: 'plan.review.resolved',
        requestId: review.requestId,
        decision: 'reject',
        ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
      });
      // The user stays in the plan mode: the draft is revised and reviewed
      // again.
      options.sessions.update(sessionId, { interactionMode: 'plan' });
      return { requestId: review.requestId, decision: 'reject', mode: 'plan', idempotent: false };
    },

    state(sessionId: string): PlanModeState {
      const session = options.sessions.get(sessionId);
      const stored = readState(sessionId);
      return {
        sessionId,
        mode: session?.interactionMode ?? 'default',
        review: stored.review,
        approvedPlan: stored.approvedPlan?.meta,
        feedback: stored.feedback,
      };
    },

    isBlocked(sessionId: string): boolean {
      const stored = readState(sessionId);
      return stored.review?.state === 'pending';
    },

    /**
     * The queue classification.
     *
     * - A pending review blocks the ordinary turns and the queued items.
     * - The confirmation of that very review is exempt from its own fence.
     * - In the plan mode the ordinary messages wait; the plan entry runs.
     * - A plan entry that is still queued when the mode is gone is dropped.
     */
    classify(item: QueueItem): QueueClassification {
      const stored = readState(item.sessionId);
      const session = options.sessions.get(item.sessionId);
      const mode = session?.interactionMode ?? 'default';

      if (stored.review?.state === 'pending') {
        if (item.requestId !== undefined && item.requestId === stored.review.requestId) {
          return 'run';
        }
        return 'defer';
      }

      if (item.kind === 'plan-entry') {
        return mode === 'plan' ? 'run' : 'cancel';
      }

      // In the plan mode an ordinary message **runs**: it is the request the
      // agent plans. Only a pending review fences the queue. Holding the
      // message back here would leave the plan mode with nothing to do: the
      // draft is written by the agent, in answer to a message.
      return 'run';
    },

    /**
     * The authoritative context of the next turn.
     *
     * The approved (frozen) plan is injected once, as a system message, so
     * the implementation follows the snapshot and not the draft.
     */
    async prepareTurn(
      sessionId: string,
      _turnId: string,
    ): Promise<readonly AgentMessage[] | undefined> {
      const stored = readState(sessionId);
      const parts: string[] = [];

      if (stored.approvedPlan !== undefined && stored.approvedPlan.meta.consumed === false) {
        parts.push(
          [
            'The plan the user approved. It is the authority for this turn:',
            'follow it even if the draft in the session has changed since.',
            '',
            stored.approvedPlan.markdown,
          ].join('\n'),
        );
        await writeState(sessionId, {
          ...stored,
          approvedPlan: {
            ...stored.approvedPlan,
            meta: { ...stored.approvedPlan.meta, consumed: true },
          },
        });
      }

      if (stored.feedback !== undefined && stored.feedback.length > 0) {
        parts.push(
          ['The user rejected the plan with this feedback:', stored.feedback].join('\n'),
        );
        await writeState(sessionId, { ...stored, feedback: undefined });
      }

      if (parts.length === 0) return undefined;

      return [
        {
          id: newId('message'),
          role: 'system',
          content: [{ type: 'text', text: parts.join('\n\n') }],
          createdAt: new Date().toISOString(),
        },
      ];
    },

    /**
     * The tools of a turn.
     *
     * In the plan mode the agent may look around, but it may not change
     * anything except the plan draft.
     */
    binderForTurn(sessionId: string, _turnId: string): ToolBinder | undefined {
      const session = options.sessions.get(sessionId);
      if (session?.interactionMode !== 'plan') return undefined;
      return options.planBinder;
    },
  };

  return service;
}
