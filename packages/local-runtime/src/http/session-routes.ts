import type { RuntimeEvent } from '@local-agent/protocol';
import { z } from 'zod';
import type { EventDelivery } from '../events/types.js';
import type { Logger } from '../logging/logger.js';
import type { SessionStore } from '../sessions/types.js';
import type { TurnSystem } from '../turns/turn-system.js';
import { NoProviderConfigured, SessionNotFound } from '../turns/turn-system.js';
import type { Router } from './router.js';
import { readJsonBody, sendError, sendJson } from './respond.js';
import { CreateSessionRequestSchema, SendMessageRequestSchema } from './schemas.js';

/**
 * Session endpoints and the SSE event stream.
 *
 * The event stream is resumable: the client sends `after=<logOffset>` (or a
 * `Last-Event-ID` header) and receives exactly the events it missed.
 */

export interface SessionRouteDependencies {
  readonly sessions: SessionStore;
  readonly events: EventDelivery;
  readonly turns: TurnSystem;
  readonly logger: Logger;
  /** Working directory used for new sessions. */
  readonly defaultCwd: string;
  /** Provider and model used for new sessions. */
  readonly defaultProviderId: string;
  readonly defaultModel: string;
}

const parseAfter = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

export function registerSessionRoutes(router: Router, deps: SessionRouteDependencies): void {
  const { sessions, events, turns } = deps;

  router.post('/v1/sessions', async ({ request, response }) => {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = CreateSessionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const session = sessions.create({
      ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      cwd: parsed.data.cwd ?? deps.defaultCwd,
      providerId: parsed.data.providerId ?? deps.defaultProviderId,
      model: parsed.data.model ?? deps.defaultModel,
    });
    sendJson(response, 201, { session });
  });

  router.get('/v1/sessions', ({ response }) => {
    sendJson(response, 200, { sessions: sessions.list() });
  });

  router.get('/v1/sessions/:sessionId', ({ response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }
    // The log offset lets a client resume the event stream where the log
    // currently ends instead of replaying every past event.
    sendJson(response, 200, { session, logOffset: events.latestOffset(session.id) });
  });

  router.get('/v1/sessions/:sessionId/status', ({ response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }
    sendJson(response, 200, {
      status: session.status,
      interactionMode: session.interactionMode,
      messageCount: sessions.readHistory(session.id).length,
      latestEventOffset: events.latestOffset(session.id),
      pendingApprovals: turns.pendingApprovals(session.id),
      pendingQuestions: turns.pendingQuestions(session.id),
    });
  });

  router.get('/v1/sessions/:sessionId/history', ({ response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }
    sendJson(response, 200, { messages: sessions.readHistory(session.id) });
  });

  router.post('/v1/sessions/:sessionId/messages', async ({ request, response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = SendMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const result = await turns.submit(session.id, parsed.data.text);
      sendJson(response, 202, {
        turnId: result.turnId,
        queued: result.queued,
        deferred: result.deferred,
        cancelled: result.cancelled,
      });
    } catch (error: unknown) {
      if (error instanceof NoProviderConfigured) {
        sendError(response, 409, 'PROVIDER_NOT_CONFIGURED', error.message);
        return;
      }
      if (error instanceof SessionNotFound) {
        sendError(response, 404, 'NOT_FOUND', error.message);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', 'the turn could not be started');
    }
  });

  router.post('/v1/sessions/:sessionId/fork', async ({ request, response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = z
      .object({
        fromMessageId: z.string().min(1).optional(),
        fromTurnId: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(body ?? {});
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    const forked = sessions.fork(session.id, parsed.data);
    if (!forked) {
      sendError(response, 404, 'NOT_FOUND', 'the session could not be forked');
      return;
    }
    sendJson(response, 201, { session: forked });
  });

  router.post('/v1/sessions/:sessionId/rewind', async ({ request, response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = z
      .object({
        toMessageId: z.string().min(1).optional(),
        toTurnId: z.string().min(1).optional(),
        resend: z.string().min(1),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    const rewound = sessions.rewind(session.id, parsed.data);
    if (!rewound) {
      sendError(response, 404, 'NOT_FOUND', 'the session could not be rewound');
      return;
    }

    try {
      const submitted = await turns.submit(rewound.id, parsed.data.resend);
      sendJson(response, 202, { session: rewound, turnId: submitted.turnId });
    } catch {
      sendError(response, 500, 'INTERNAL_ERROR', 'the resent message could not be started');
    }
  });

  router.post('/v1/sessions/:sessionId/permissions/:requestId', async ({ request, response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = z
      .object({ choice: z.enum(['allow-once', 'allow-session', 'deny']) })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    const answered = turns.answerApproval(
      session.id,
      params['requestId'] ?? '',
      parsed.data.choice,
    );
    if (!answered) {
      sendError(response, 404, 'APPROVAL_NOT_FOUND', 'no approval is waiting for this id');
      return;
    }
    sendJson(response, 200, { answered: true, requestId: params['requestId'] });
  });

  router.post('/v1/sessions/:sessionId/questions/:requestId', async ({ request, response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendError(response, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    }

    const parsed = z.object({ answers: z.record(z.string(), z.string()) }).strict().safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST', 'the request body does not match the schema');
      return;
    }

    const answered = turns.answerQuestion(
      session.id,
      params['requestId'] ?? '',
      parsed.data.answers,
    );
    if (!answered) {
      sendError(response, 404, 'QUESTION_NOT_FOUND', 'no question is waiting for this id');
      return;
    }
    sendJson(response, 200, { answered: true, requestId: params['requestId'] });
  });

  router.get('/v1/sessions/:sessionId/events', ({ request, response, url, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }

    const lastEventId = request.headers['last-event-id'];
    const after = parseAfter(
      url.searchParams.get('after') ??
        (typeof lastEventId === 'string' ? lastEventId : undefined),
    );

    const oldest = events.oldestOffset(session.id);
    if (after > 0 && oldest > 0 && after < oldest - 1) {
      sendError(
        response,
        409,
        'EVENT_LOG_TRUNCATED',
        'the requested event offset is no longer in the buffer',
        { oldestOffset: oldest, latestOffset: events.latestOffset(session.id) },
      );
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // The stream may be closed at any moment. Handing the connection back
      // to the pool would let the next request land on a socket the server
      // already closed.
      connection: 'close',
    });
    // Send the headers right away. Without this the client cannot tell that
    // the stream is open until the first event arrives, and a client that
    // waits for the response to start reading would wait forever.
    response.flushHeaders();

    let lastSent = after;

    const send = (event: RuntimeEvent): void => {
      if (event.logOffset <= lastSent) return;
      lastSent = event.logOffset;
      response.write(`id: ${event.logOffset}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe before the replay so that no event is lost in between.
    const unsubscribe = events.subscribe(session.id, send);
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });

    for (const event of events.read(session.id, after)) {
      send(event);
    }
  });

  router.delete('/v1/sessions/:sessionId', ({ response, params }) => {
    const session = sessions.get(params['sessionId'] ?? '');
    if (!session) {
      sendError(response, 404, 'NOT_FOUND', 'no session matches this id');
      return;
    }
    sessions.delete(session.id);
    sendJson(response, 200, { deleted: true, sessionId: session.id });
  });
}
