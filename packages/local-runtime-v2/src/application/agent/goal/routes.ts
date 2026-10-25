import { z } from 'zod';
import {
  readJsonBody,
  sendError,
  sendJson,
  type Router,
} from '@local-agent/local-runtime';
import { GoalError } from './types.js';
import type { GoalService } from './service.js';

/**
 * The goal endpoints.
 *
 * `GET` reads the goal, `POST` creates it or updates it.
 */

const GoalRequestSchema = z
  .object({
    /** The goal text. Its presence means "create the goal". */
    text: z.string().min(1).optional(),
    tokenBudget: z.number().int().positive().optional(),
    status: z.enum(['completed', 'blocked', 'paused', 'cleared', 'active']).optional(),
    reason: z.string().optional(),
    attemptedPaths: z.array(z.string().min(1)).optional(),
    requiredInputs: z.array(z.string().min(1)).optional(),
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
  })
  .strict();

export function registerGoalRoutes(router: Router, goal: GoalService): void {
  router.get('/v1/sessions/:sessionId/goal', ({ response, params }) => {
    const state = goal.read(params['sessionId'] ?? '');
    if (state === undefined) {
      sendError(response, 404, 'GOAL_NOT_FOUND', 'this session has no goal');
      return;
    }
    sendJson(response, 200, {
      goal: {
        id: state.id,
        text: state.text,
        status: state.status,
        objective: state.spec.objective,
        acceptanceCriteria: state.spec.acceptanceCriteria,
        constraints: state.spec.constraints,
        workBoundary: state.spec.workBoundary,
        stopConditions: state.spec.stopConditions,
        budget: state.budget,
        rounds: state.rounds,
        consecutiveNoProgress: state.consecutiveNoProgress,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        ...(state.blockedReport === undefined ? {} : { blockedReport: state.blockedReport }),
        ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason }),
      },
    });
  });

  router.post('/v1/sessions/:sessionId/goal', async ({ request, response, params }) => {
    const sessionId = params['sessionId'] ?? '';

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = GoalRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    try {
      if (parsed.data.text !== undefined) {
        const created = await goal.create(sessionId, {
          text: parsed.data.text,
          ...(parsed.data.tokenBudget === undefined
            ? {}
            : { tokenBudget: parsed.data.tokenBudget }),
        });
        sendJson(response, 201, { goal: { id: created.id, status: created.status } });
        return;
      }

      const updated = await goal.update(sessionId, parsed.data, { resume: true });
      sendJson(response, 200, { goal: { id: updated.id, status: updated.status } });
    } catch (error: unknown) {
      if (error instanceof GoalError) {
        const status =
          error.code === 'NO_GOAL' ? 404 : error.code === 'INCOMPLETE' ? 400 : 409;
        sendError(response, status, error.code, error.message);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', 'the goal could not be changed');
    }
  });
}
