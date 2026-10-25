import type { GoalStatus } from '@local-agent/protocol';

/**
 * The goal mode contracts.
 *
 * A goal is a **verifiable end state**: it says what "done" means, what must
 * not regress, what the agent may touch, and when it must stop. Without
 * those, the agent would be guessing.
 *
 * See docs/contracts.md §10.
 */

/** The parsed structure of a goal. */
export interface GoalSpec {
  /** What must be true at the end. */
  readonly objective: string;
  /** How the completion is checked. */
  readonly acceptanceCriteria: readonly string[];
  /** What must not regress while working. */
  readonly constraints: readonly string[];
  /** What the agent may use or change. */
  readonly workBoundary: readonly string[];
  /** When the agent must stop and report. */
  readonly stopConditions: readonly string[];
}

/** A piece of evidence that supports a verdict. */
export interface EvidenceRef {
  readonly kind: 'test' | 'build' | 'log' | 'artifact' | 'command';
  /** The path, the command or the location of the evidence. */
  readonly ref: string;
  readonly detail?: string | undefined;
}

/** The structured report of a blocked goal. */
export interface GoalBlockReport {
  /** The paths that were already tried. */
  readonly attemptedPaths: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  /** Why the work is blocked. */
  readonly reason: string;
  /** What is needed to continue. */
  readonly requiredInputs: readonly string[];
}

/** The budget of a goal. */
export interface GoalBudget {
  /** The token ceiling. Undefined means no ceiling. */
  readonly tokenLimit?: number;
  readonly tokensUsed: number;
}

/** The persisted state of a goal. */
export interface GoalState {
  readonly id: string;
  /** The text the user wrote. */
  readonly text: string;
  readonly spec: GoalSpec;
  readonly status: GoalStatus;
  readonly budget: GoalBudget;
  /** How many rounds were verified since the goal was created. */
  readonly rounds: number;
  /** How many rounds in a row produced no progress. */
  readonly consecutiveNoProgress: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The rounds the verifier judged as progress. */
  readonly verifiedRounds: number;
  /** The report of a blocked goal. */
  readonly blockedReport?: GoalBlockReport | undefined;
  /**
   * Why the goal paused.
   *
   * The automatic pauses (the budget, the round limit, no progress, a wrong
   * direction) are decisions the runtime takes on its own. Without this the
   * user would only see "paused" and would have to guess what to change.
   */
  readonly pauseReason?: string | undefined;
}

/** What the goal service does after a turn ends. */
export type GoalContinuation =
  /** The goal is not reached yet: run another round. */
  | { readonly kind: 'continue' }
  /** The goal is reached. */
  | { readonly kind: 'completed' }
  /** The goal is paused: the budget, the progress or the direction says so. */
  | { readonly kind: 'paused'; readonly reason: string }
  /** The goal is blocked: the agent cannot continue without help. */
  | { readonly kind: 'blocked'; readonly report: GoalBlockReport }
  /** There is no goal: nothing to do. */
  | { readonly kind: 'idle' };

/** The verdict of the verifier. */
export interface GoalVerification {
  readonly achieved: boolean;
  readonly reason: string;
  readonly evidence: readonly EvidenceRef[];
  /** True when the round produced progress. */
  readonly progressed: boolean;
  /** True when the approach itself is wrong. */
  readonly directionWrong?: boolean;
}

/** The errors the goal service can raise. */
export type GoalErrorCode =
  | 'NOT_FOUND'
  | 'NO_GOAL'
  | 'INCOMPLETE'
  | 'INVALID_TRANSITION'
  | 'VERIFIER_FORBIDDEN';

export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalError';
  }
}
