import { z } from 'zod';
import {
  readJsonBody,
  sendError,
  sendJson,
  type Router,
} from '@local-agent/local-runtime';
import { PlanError } from './types.js';
import type { PlanService } from './plan-service.js';

/**
 * The plan mode endpoints.
 *
 * They live in the application layer: the host runtime stores the session and
 * runs the turns, the plan service owns the policy.
 */

const ModeRequestSchema = z
  .object({
    interactionMode: z.enum(['default', 'plan']),
  })
  .strict();

const ReviewRequestSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(['approve', 'reject']),
    feedback: z.string().optional(),
  })
  .strict();

export function registerPlanRoutes(router: Router, plan: PlanService): void {
  router.get('/v1/sessions/:sessionId/plan', ({ response, params }) => {
    const state = plan.state(params['sessionId'] ?? '');
    sendJson(response, 200, {
      mode: state.mode,
      blocked: plan.isBlocked(params['sessionId'] ?? ''),
      review:
        state.review === undefined
          ? undefined
          : {
              requestId: state.review.requestId,
              planId: state.review.planId,
              frozenAt: state.review.frozenAt,
              state: state.review.state,
              markdown: state.review.markdown,
              ...(state.review.feedback === undefined ? {} : { feedback: state.review.feedback }),
            },
      approvedPlan: state.approvedPlan,
    });
  });

  router.post('/v1/sessions/:sessionId/mode', async ({ request, response, params }) => {
    const sessionId = params['sessionId'] ?? '';

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = ModeRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    try {
      if (parsed.data.interactionMode === 'plan') {
        const result = await plan.enter(sessionId);
        sendJson(response, 200, { mode: result.mode, idempotent: result.idempotent, backup: result.backup });
        return;
      }

      // Leaving the plan mode freezes the draft and asks for the review.
      const review = await plan.exit(sessionId);
      sendJson(response, 200, {
        mode: 'default',
        review: {
          requestId: review.requestId,
          planId: review.planId,
          frozenAt: review.frozenAt,
          markdown: review.markdown,
        },
      });
    } catch (error: unknown) {
      if (error instanceof PlanError) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'COMPENSATED' ? 409 : 400;
        sendError(response, status, error.code, error.message);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', 'the plan mode could not be changed');
    }
  });

  router.post('/v1/sessions/:sessionId/plan/review', async ({ request, response, params }) => {
    const sessionId = params['sessionId'] ?? '';

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = ReviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    try {
      const outcome = await plan.review(sessionId, parsed.data.requestId, {
        decision: parsed.data.decision,
        ...(parsed.data.feedback === undefined ? {} : { feedback: parsed.data.feedback }),
      });
      sendJson(response, 200, outcome);
    } catch (error: unknown) {
      if (error instanceof PlanError) {
        sendError(response, error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', 'the review could not be answered');
    }
  });
}
