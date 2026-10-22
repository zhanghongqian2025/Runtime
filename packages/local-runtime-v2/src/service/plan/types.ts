import type { PlanReviewMeta } from '@local-agent/agent-extension/plan-mode';

/**
 * The plan mode contracts.
 *
 * The plan mode lives in the application layer: the host runtime knows how
 * to store a session and how to run a turn, but the *policy* of planning
 * before acting belongs to the application.
 *
 * See docs/contracts.md §9.
 */

export type PlanReviewDecisionKind = 'approve' | 'reject';

export interface PlanReviewState {
  readonly requestId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly frozenAt: string;
  /** The frozen snapshot. It never changes once it is written. */
  readonly markdown: string;
  readonly meta: PlanReviewMeta;
  readonly state: 'pending' | 'approved' | 'rejected';
  /** The feedback the user left when it rejected the plan. */
  readonly feedback?: string;
}

export interface PlanModeState {
  readonly sessionId: string;
  readonly mode: 'default' | 'plan';
  /** The review that is waiting for an answer. */
  readonly review: PlanReviewState | undefined;
  /** The plan that was approved and not consumed yet. */
  readonly approvedPlan: PlanReviewMeta | undefined;
  /** The feedback of a rejected plan, waiting to be shown to the agent. */
  readonly feedback: string | undefined;
}

export interface PlanModeResult {
  readonly mode: 'default' | 'plan';
  /** True when the session was already in the target mode. */
  readonly idempotent: boolean;
  /** True when the admission had to be undone. */
  readonly compensated: boolean;
  /** The backup of the previous draft. */
  readonly backup?: string;
  readonly turnId?: string;
}

export interface PlanReviewDecision {
  readonly decision: PlanReviewDecisionKind;
  readonly feedback?: string;
}

export interface PlanReviewOutcome {
  readonly requestId: string;
  readonly decision: PlanReviewDecisionKind;
  readonly mode: 'default' | 'plan';
  /** True when the review was already answered. */
  readonly idempotent: boolean;
}

/** The reasons a plan operation can fail. */
export type PlanErrorCode =
  | 'NOT_FOUND'
  | 'ADMISSION_REJECTED'
  | 'NO_PLAN'
  | 'COMPENSATED'
  | 'CONFLICT';

export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}
