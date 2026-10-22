import { z } from 'zod';
import { newId, type GoalStatus } from '@local-agent/protocol';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import type { EventDelivery } from '@local-agent/local-runtime';
import type { Logger } from '@local-agent/local-runtime';
import { missingAspects, parseGoal } from './parse.js';
import type { GoalState, GoalVerification } from './types.js';
import type { GoalStore } from './store.js';

/**
 * The goal tools.
 *
 * The model sees three of them: `create_goal`, `get_goal` and `update_goal`.
 * A fourth one, `goal_verdict`, belongs to the verifier session.
 *
 * The goal tools **refuse to work in a verifier session**: the verification
 * must not be able to rewrite the goal it is verifying.
 */

export interface GoalToolDependencies {
  readonly store: GoalStore;
  readonly events: EventDelivery;
  readonly logger: Logger;
  /** True for the sessions that may not create or change a goal. */
  readonly isVerifierSession: (sessionId: string) => boolean;
  /** Records the verdict of a verifier session. */
  readonly recordVerdict?: (sessionId: string, verdict: GoalVerification) => void;
  /** Creates the goal. Injected so the service owns the state machine. */
  readonly createGoal: (sessionId: string, input: CreateGoalInput) => Promise<GoalState>;
  /** Reads the goal. */
  readonly readGoal: (sessionId: string) => GoalState | undefined;
  /** Updates the goal. */
  readonly updateGoal: (sessionId: string, input: UpdateGoalInput) => Promise<GoalState>;
}

export interface CreateGoalInput {
  readonly text: string;
  readonly tokenBudget?: number | undefined;
}

export interface UpdateGoalInput {
  readonly status?: 'completed' | 'blocked' | 'paused' | 'cleared' | 'active' | undefined;
  readonly reason?: string | undefined;
  readonly evidence?: { kind: string; ref: string; detail?: string | undefined }[] | undefined;
  readonly attemptedPaths?: string[] | undefined;
  readonly requiredInputs?: string[] | undefined;
  readonly tokenBudget?: number | undefined;
}

export const CreateGoalInputSchema = z
  .object({
    text: z.string().min(1),
    tokenBudget: z.number().int().positive().optional(),
  })
  .strict();

export const UpdateGoalInputSchema = z
  .object({
    status: z.enum(['completed', 'blocked', 'paused', 'cleared', 'active']).optional(),
    reason: z.string().optional(),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['test', 'build', 'log', 'artifact', 'command']),
            ref: z.string().min(1),
            detail: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    attemptedPaths: z.array(z.string().min(1)).optional(),
    requiredInputs: z.array(z.string().min(1)).optional(),
    tokenBudget: z.number().int().positive().optional(),
  })
  .strict();

export const GoalVerdictInputSchema = z
  .object({
    achieved: z.boolean(),
    reason: z.string().min(1),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['test', 'build', 'log', 'artifact', 'command']),
            ref: z.string().min(1),
            detail: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    progressed: z.boolean().default(true),
    directionWrong: z.boolean().default(false),
  })
  .strict();

const errorResult = (message: string) => ({
  ok: false,
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});

const okResult = (text: string) => ({
  ok: true,
  isError: false,
  content: [{ type: 'text' as const, text }],
});

export function createGoalTools(deps: GoalToolDependencies): readonly ToolImpl[] {
  const createGoalTool: ToolImpl = {
    definition: {
      name: 'create_goal',
      description:
        'Set the goal of the session: what must be true at the end, how it is verified, what must not regress, what may be changed and when to stop.',
      schema: CreateGoalInputSchema,
      executionMode: 'sync',
      risk: 'none',
    },
    async execute(ctx, input) {
      if (deps.isVerifierSession(ctx.sessionId)) {
        return errorResult(
          'create_goal failed: a verifier session may not create or change a goal',
        );
      }

      const parsed = CreateGoalInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          `create_goal failed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }

      let text = parsed.data.text;
      let spec = parseGoal(text);

      if (spec === undefined) {
        // The goal is not checkable yet: ask the user instead of guessing.
        const missing = missingAspects(undefined);
        const answer = await ctx.askUser({
          requestId: newId('request'),
          title: 'The goal needs to be completed',
          questions: missing.map((aspect) => ({
            id: aspect,
            question: `Please provide the ${aspect}`,
            type: 'text' as const,
          })),
        });

        const answers = Object.entries(answer.answers);
        const labelled = answers
          .map(([aspect, value]) => `${aspect.split('（')[0] ?? aspect}: ${value}`)
          .join('\n');
        text = `${text}\n${labelled}`;
        spec = parseGoal(text);

        if (spec === undefined) {
          return errorResult(
            `create_goal failed: the goal is still missing ${missingAspects(undefined).join('、')}`,
          );
        }
      }

      try {
        const goal = await deps.createGoal(ctx.sessionId, {
          text,
          ...(parsed.data.tokenBudget === undefined
            ? {}
            : { tokenBudget: parsed.data.tokenBudget }),
        });
        await ctx.emitEvent({ type: 'goal.updated', goal: toSnapshot(goal) });
        return okResult(
          `the goal is set: ${goal.spec.objective}. Verify it with: ${goal.spec.acceptanceCriteria.join('; ')}`,
        );
      } catch (error: unknown) {
        return errorResult(
          `create_goal failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
  };

  const getGoalTool: ToolImpl = {
    definition: {
      name: 'get_goal',
      description: 'Read the goal of the session: its status, its acceptance criteria and its budget.',
      schema: z.object({}).strict(),
      executionMode: 'sync',
      risk: 'none',
    },
    async execute(ctx) {
      const goal = deps.readGoal(ctx.sessionId);
      if (goal === undefined) {
        return errorResult('get_goal failed: this session has no goal');
      }
      return okResult(
        JSON.stringify(
          {
            status: goal.status,
            objective: goal.spec.objective,
            acceptanceCriteria: goal.spec.acceptanceCriteria,
            constraints: goal.spec.constraints,
            workBoundary: goal.spec.workBoundary,
            stopConditions: goal.spec.stopConditions,
            budget: goal.budget,
            rounds: goal.rounds,
          },
          null,
          2,
        ),
      );
    },
  };

  const updateGoalTool: ToolImpl = {
    definition: {
      name: 'update_goal',
      description:
        'Update the goal: submit a terminal state (completed, blocked, paused, cleared) or raise the token budget.',
      schema: UpdateGoalInputSchema,
      executionMode: 'sync',
      risk: 'none',
    },
    async execute(ctx, input) {
      if (deps.isVerifierSession(ctx.sessionId)) {
        return errorResult(
          'update_goal failed: a verifier session may not create or change a goal',
        );
      }

      const parsed = UpdateGoalInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          `update_goal failed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }

      try {
        const goal = await deps.updateGoal(ctx.sessionId, parsed.data);
        await ctx.emitEvent({ type: 'goal.updated', goal: toSnapshot(goal) });
        return okResult(`the goal is now ${goal.status}`);
      } catch (error: unknown) {
        return errorResult(
          `update_goal failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
  };

  const goalVerdictTool: ToolImpl = {
    definition: {
      name: 'goal_verdict',
      description:
        'Report whether the goal is achieved. Only used in a verification session.',
      schema: GoalVerdictInputSchema,
      executionMode: 'sync',
      risk: 'none',
    },
    async execute(ctx, input) {
      if (!deps.isVerifierSession(ctx.sessionId)) {
        return errorResult(
          'goal_verdict failed: this tool is only available in a verification session',
        );
      }

      const parsed = GoalVerdictInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          `goal_verdict failed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }

      deps.recordVerdict?.(ctx.sessionId, {
        achieved: parsed.data.achieved,
        reason: parsed.data.reason,
        evidence: parsed.data.evidence,
        progressed: parsed.data.progressed,
      });
      return okResult('the verdict was recorded');
    },
  };

  return [createGoalTool, getGoalTool, updateGoalTool, goalVerdictTool];
}

/** The wire shape of a goal. */
export function toSnapshot(goal: GoalState): {
  id: string;
  text: string;
  status: GoalStatus;
  acceptanceCriteria: string[];
  constraints: string[];
  workBoundary: string[];
  stopConditions: string[];
  budget: { tokensUsed: number; tokenLimit?: number | undefined };
  blockedReason?: string | undefined;
} {
  return {
    id: goal.id,
    text: goal.text,
    status: goal.status,
    acceptanceCriteria: [...goal.spec.acceptanceCriteria],
    constraints: [...goal.spec.constraints],
    workBoundary: [...goal.spec.workBoundary],
    stopConditions: [...goal.spec.stopConditions],
    budget: {
      tokensUsed: goal.budget.tokensUsed,
      ...(goal.budget.tokenLimit === undefined ? {} : { tokenLimit: goal.budget.tokenLimit }),
    },
    ...(goal.blockedReport === undefined ? {} : { blockedReason: goal.blockedReport.reason }),
  };
}
