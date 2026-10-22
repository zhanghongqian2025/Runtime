import { newId } from '@local-agent/protocol';
import type { TokenUsage } from '@local-agent/protocol';
import type { ToolBinder, ToolImpl } from '@local-agent/agent-core/tools';
import type {
  EventDelivery,
  Logger,
  QueueClassification,
  QueueItem,
  SessionStore,
  TurnSystem,
} from '@local-agent/local-runtime';
import { parseGoal } from './parse.js';
import type { GoalStore } from './store.js';
import {
  createGoalTools,
  toSnapshot,
  type CreateGoalInput,
  type UpdateGoalInput,
} from './tools.js';
import { GoalError, type GoalContinuation, type GoalState, type GoalVerification } from './types.js';
import { createGoalVerifier, type GoalVerifier } from './verifier.js';

/**
 * The goal service.
 *
 * It owns the goal state machine, the budget and the automatic continuation:
 * when a turn ends and the goal is not reached yet, the next round runs on
 * the **existing history** — no hidden prompt is ever synthesised.
 *
 * See docs/contracts.md §10.
 */

/** The backstop of the automatic continuation. */
export const MAX_GOAL_ROUNDS = 50;
/** How many rounds without progress pause the goal. */
export const MAX_ROUNDS_WITHOUT_PROGRESS = 2;

export interface GoalServiceOptions {
  readonly sessions: SessionStore;
  readonly events: EventDelivery;
  readonly turns: TurnSystem;
  readonly store: GoalStore;
  readonly logger: Logger;
  /** The tools of a normal session. */
  readonly tools: ToolBinder;
  /** The tools of a verification session. */
  readonly toolsForVerifier: (sessionId: string) => ToolBinder;
  readonly cwd: string;
  readonly providerId: string;
  readonly model: string;
}

export interface GoalService {
  /** The tools the model sees. */
  readonly tools: readonly ToolImpl[];
  readonly verifier: GoalVerifier;
  create(sessionId: string, input: CreateGoalInput): Promise<GoalState>;
  read(sessionId: string): GoalState | undefined;
  update(sessionId: string, input: UpdateGoalInput): Promise<GoalState>;
  /** Called when a turn ended: it decides what happens next. */
  afterTurn(
    sessionId: string,
    turnId: string,
    outcome: { readonly usage: TokenUsage; readonly status: 'completed' | 'failed' | 'aborted' },
  ): Promise<GoalContinuation>;
  /** True for the verification sessions. */
  isVerifierSession(sessionId: string): boolean;
  /** Registers a session as a verification session. */
  registerVerifierSession(sessionId: string): void;
  /** The queue classification: a goal never blocks the user. */
  classify(item: QueueItem): QueueClassification;
  /** The tools of a turn: the goal does not restrict them. */
  binderForTurn(sessionId: string, turnId: string): ToolBinder | undefined;
}

/** The transitions the goal state machine allows. */
const ALLOWED_TRANSITIONS: Readonly<Record<GoalState['status'], readonly GoalState['status'][]>> = {
  active: ['completed', 'blocked', 'paused', 'cleared'],
  paused: ['active', 'cleared'],
  blocked: ['active', 'cleared'],
  completed: ['cleared'],
  cleared: [],
};

export function createGoalService(options: GoalServiceOptions): GoalService {
  const verifierSessions = new Set<string>();
  const verdicts = new Map<string, GoalVerification>();

  // The goal state does not carry its session id; the service keeps the
  // mapping so the event can be published on the right session.
  const sessionOfGoal = new Map<string, string>();

  const verifier = createGoalVerifier({
    sessions: options.sessions,
    turns: options.turns,
    logger: options.logger,
    toolsForVerifier: options.toolsForVerifier,
    registerVerifierSession: (sessionId) => {
      verifierSessions.add(sessionId);
    },
    takeVerdict: (sessionId) => {
      const verdict = verdicts.get(sessionId);
      verdicts.delete(sessionId);
      return verdict;
    },
    cwd: options.cwd,
    providerId: options.providerId,
    model: options.model,
  });

  const write = async (sessionId: string, goal: GoalState): Promise<GoalState> => {
    await options.store.write(sessionId, goal);
    sessionOfGoal.set(goal.id, sessionId);
    options.events.publishHost(sessionId, { type: 'goal.updated', goal: toSnapshot(goal) });
    return goal;
  };

  const create = async (sessionId: string, input: CreateGoalInput): Promise<GoalState> => {
    const spec = parseGoal(input.text);
    if (spec === undefined) {
      throw new GoalError(
        'INCOMPLETE',
        'the goal needs an objective and at least one acceptance criterion',
      );
    }

    const now = new Date().toISOString();
    const goal: GoalState = {
      id: newId('request'),
      text: input.text,
      spec,
      status: 'active',
      budget: {
        tokensUsed: 0,
        ...(input.tokenBudget === undefined ? {} : { tokenLimit: input.tokenBudget }),
      },
      rounds: 0,
      consecutiveNoProgress: 0,
      createdAt: now,
      updatedAt: now,
      verifiedRounds: 0,
    };

    return write(sessionId, goal);
  };

  const update = async (sessionId: string, input: UpdateGoalInput): Promise<GoalState> => {
    const goal = options.store.read(sessionId);
    if (goal === undefined) {
      throw new GoalError('NO_GOAL', 'this session has no goal');
    }

    const now = new Date().toISOString();
    let next: GoalState = goal;

    if (input.status !== undefined) {
      if (input.status === 'active') {
        if (!ALLOWED_TRANSITIONS[goal.status].includes('active')) {
          throw new GoalError(
            'INVALID_TRANSITION',
            `a ${goal.status} goal cannot become active again`,
          );
        }
      } else if (!ALLOWED_TRANSITIONS[goal.status].includes(input.status)) {
        throw new GoalError(
          'INVALID_TRANSITION',
          `a ${goal.status} goal cannot become ${input.status}`,
        );
      }

      next = { ...next, status: input.status, updatedAt: now };

      if (input.status === 'blocked') {
        next = {
          ...next,
          blockedReport: {
            attemptedPaths: input.attemptedPaths ?? [],
            evidence: (input.evidence ?? []).map((entry) => ({
              kind: entry.kind as 'test' | 'build' | 'log' | 'artifact' | 'command',
              ref: entry.ref,
              ...(entry.detail === undefined ? {} : { detail: entry.detail }),
            })),
            reason: input.reason ?? 'the goal was reported as blocked',
            requiredInputs: input.requiredInputs ?? [],
          },
        };
      }

      if (input.status === 'cleared') {
        next = { ...next, blockedReport: undefined };
      }
    }

    if (input.tokenBudget !== undefined) {
      next = {
        ...next,
        budget: { ...next.budget, tokenLimit: input.tokenBudget },
        updatedAt: now,
      };
    }

    return write(sessionId, next);
  };

  // The tools ask the service, so a verifier session registered later is
  // still refused. The holder breaks the construction cycle.
  const serviceHolder: { current?: GoalService } = {};

  const tools = createGoalTools({
    store: options.store,
    events: options.events,
    logger: options.logger,
    isVerifierSession: (sessionId) =>
      serviceHolder.current?.isVerifierSession(sessionId) ?? false,
    recordVerdict: (sessionId, verdict) => {
      verdicts.set(sessionId, verdict);
    },
    createGoal: create,
    readGoal: (sessionId) => options.store.read(sessionId),
    updateGoal: update,
  });

  const afterTurn = async (
    sessionId: string,
    _turnId: string,
    outcome: { readonly usage: TokenUsage; readonly status: 'completed' | 'failed' | 'aborted' },
  ): Promise<GoalContinuation> => {
    options.logger.info('goal: afterTurn', { sessionId, status: outcome.status });
    const goal = options.store.read(sessionId);
    if (goal === undefined) return { kind: 'idle' };
    if (goal.status !== 'active') return { kind: 'idle' };
    // A failed turn needs a human: the agent does not keep going on its own.
    if (outcome.status !== 'completed') return { kind: 'idle' };

    const rounds = goal.rounds + 1;
    const tokensUsed = goal.budget.tokensUsed + outcome.usage.inputTokens + outcome.usage.outputTokens;
    const budget = { ...goal.budget, tokensUsed };

    // 1. The budget stops the loop.
    if (budget.tokenLimit !== undefined && tokensUsed >= budget.tokenLimit) {
      await write(sessionId, {
        ...goal,
        rounds,
        budget,
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
      return {
        kind: 'paused',
        reason: `the token budget of ${budget.tokenLimit} is exhausted (${tokensUsed} used)`,
      };
    }

    // 2. The backstop of the automatic continuation.
    if (rounds > MAX_GOAL_ROUNDS) {
      await write(sessionId, {
        ...goal,
        rounds,
        budget,
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
      return { kind: 'paused', reason: `the goal exceeded ${MAX_GOAL_ROUNDS} rounds` };
    }

    // 3. The verification, in an independent sub-session.
    options.logger.debug('goal: verifying', { sessionId, rounds });
    const verdict = await verifier.verify(sessionId, goal.spec);
    options.logger.debug('goal: verdict', { sessionId, achieved: verdict.achieved });

    if (verdict.achieved) {
      await write(sessionId, {
        ...goal,
        rounds,
        budget,
        status: 'completed',
        verifiedRounds: goal.verifiedRounds + 1,
        consecutiveNoProgress: 0,
        updatedAt: new Date().toISOString(),
      });
      return { kind: 'completed' };
    }

    const consecutiveNoProgress = verdict.progressed ? 0 : goal.consecutiveNoProgress + 1;

    if (verdict.directionWrong) {
      await write(sessionId, {
        ...goal,
        rounds,
        budget,
        consecutiveNoProgress,
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
      return { kind: 'paused', reason: `the direction is wrong: ${verdict.reason}` };
    }

    if (consecutiveNoProgress >= MAX_ROUNDS_WITHOUT_PROGRESS) {
      await write(sessionId, {
        ...goal,
        rounds,
        budget,
        consecutiveNoProgress,
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
      return {
        kind: 'paused',
        reason: `no progress for ${consecutiveNoProgress} rounds in a row: ${verdict.reason}`,
      };
    }

    // 4. Continue on the existing history: no hidden prompt is synthesised.
    await write(sessionId, {
      ...goal,
      rounds,
      budget,
      consecutiveNoProgress,
      updatedAt: new Date().toISOString(),
    });
    options.turns.continueTurn(sessionId);
    return { kind: 'continue' };
  };

  const service: GoalService = {
    tools,
    verifier,
    create,
    read: (sessionId: string) => options.store.read(sessionId),
    update,
    afterTurn,
    isVerifierSession: (sessionId: string) => verifierSessions.has(sessionId),
    registerVerifierSession: (sessionId: string): void => {
      verifierSessions.add(sessionId);
    },
    classify: (): QueueClassification => 'run',
    binderForTurn: (): ToolBinder | undefined => undefined,
  };

  serviceHolder.current = service;
  return service;
}
