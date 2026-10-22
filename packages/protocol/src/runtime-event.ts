import { z } from 'zod';
import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
} from './permission.js';
import {
  GoalSnapshotSchema,
  QuestionRequestSchema,
  QuestionResolutionSchema,
  TodoItemSchema,
} from './interaction.js';
import { AgentMessageSchema, ToolResultSchema } from './message.js';

/**
 * RuntimeEvent — the public event trunk.
 *
 * Every event carries the same envelope. Two sequence numbers live here:
 *
 * - `seq` is assigned by the core inside the turn (1-based, turn-scoped).
 * - `logOffset` is assigned by the host when the event is appended to the
 *   session event log (session-scoped) and is what an SSE client resumes on.
 *
 * See docs/contracts.md §2.4 and docs/decisions.md D-005.
 */

export const SESSION_STATUSES = [
  'running',
  'completed',
  'failed',
  'aborted',
  'awaiting_approval',
  'awaiting_input',
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const RuntimeErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

const envelope = {
  id: z.string().min(1),
  seq: z.number().int().positive(),
  logOffset: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  ts: z.string().min(1),
} as const;

/** Build one runtime event variant on top of the shared envelope. */
const event = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...envelope, ...shape }).strict();

export const RUNTIME_EVENT_TYPES = [
  'session.status',
  'message.delta',
  'message.completed',
  'thinking.delta',
  'step.started',
  'step.completed',
  'llm.request.started',
  'llm.retry.scheduled',
  'tool.call.started',
  'tool.call.progress',
  'tool.call.completed',
  'tool.call.blocked',
  'file.changed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'todo.updated',
  'context.compaction.started',
  'context.compaction.completed',
  'goal.updated',
  'plan.mode.changed',
  'plan.review.requested',
  'plan.review.resolved',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  event({
    type: z.literal('session.status'),
    status: SessionStatusSchema,
    reason: z.string().optional(),
    error: RuntimeErrorSchema.optional(),
  }),
  event({
    type: z.literal('message.delta'),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  event({
    type: z.literal('message.completed'),
    message: AgentMessageSchema,
  }),
  event({
    type: z.literal('thinking.delta'),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  event({
    type: z.literal('step.started'),
    stepIndex: z.number().int().nonnegative(),
  }),
  event({
    type: z.literal('step.completed'),
    stepIndex: z.number().int().nonnegative(),
  }),
  event({
    type: z.literal('llm.request.started'),
    attempt: z.number().int().positive(),
  }),
  event({
    type: z.literal('llm.retry.scheduled'),
    attempt: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }),
  event({
    type: z.literal('tool.call.started'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  event({
    type: z.literal('tool.call.progress'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    chunk: z.string(),
  }),
  event({
    type: z.literal('tool.call.completed'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    result: ToolResultSchema,
  }),
  event({
    type: z.literal('tool.call.blocked'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    blockedBy: z.string().min(1),
    reason: z.string().min(1),
  }),
  event({
    type: z.literal('file.changed'),
    path: z.string().min(1),
    change: z.enum(['created', 'modified', 'deleted']),
    bytes: z.number().int().nonnegative().optional(),
  }),
  event({
    type: z.literal('permission.requested'),
    approval: ApprovalRequestSchema,
  }),
  event({
    type: z.literal('permission.resolved'),
    resolution: ApprovalResolutionSchema,
  }),
  event({
    type: z.literal('question.requested'),
    question: QuestionRequestSchema,
  }),
  event({
    type: z.literal('question.resolved'),
    resolution: QuestionResolutionSchema,
  }),
  event({
    type: z.literal('todo.updated'),
    items: z.array(TodoItemSchema),
  }),
  event({
    type: z.literal('context.compaction.started'),
    reason: z.enum(['watermark', 'manual']),
    beforeTokens: z.number().int().nonnegative(),
  }),
  event({
    type: z.literal('context.compaction.completed'),
    beforeTokens: z.number().int().nonnegative(),
    afterTokens: z.number().int().nonnegative(),
    savedRatio: z.number().min(0).max(1),
    checkpointId: z.string().min(1),
  }),
  event({
    type: z.literal('goal.updated'),
    goal: GoalSnapshotSchema,
  }),
  event({
    type: z.literal('plan.mode.changed'),
    mode: z.enum(['default', 'plan']),
    reason: z.string().min(1),
  }),
  event({
    type: z.literal('plan.review.requested'),
    review: z.object({
      requestId: z.string().min(1),
      planId: z.string().min(1),
      frozenAt: z.string().min(1),
      markdown: z.string(),
    }).strict(),
  }),
  event({
    type: z.literal('plan.review.resolved'),
    requestId: z.string().min(1),
    decision: z.enum(['approve', 'reject']),
    feedback: z.string().optional(),
  }),
]);

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/** Distributive `Omit` so the draft type stays a union of variants. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A runtime event without the envelope.
 *
 * The core owns the envelope (it assigns the turn-scoped id and seq), so a
 * host-side producer — a tool, for instance — hands over the payload only.
 */
export type RuntimeEventBody = DistributiveOmit<
  RuntimeEvent,
  'id' | 'seq' | 'logOffset' | 'sessionId' | 'turnId' | 'ts'
>;

/**
 * A runtime event before the host assigns its session-log offset.
 *
 * The core never invents `logOffset`; the host does, when the event is
 * appended to `events.jsonl`.
 */
export type RuntimeEventDraft = DistributiveOmit<RuntimeEvent, 'logOffset'>;

/** Assign the session-scoped offset and validate the resulting wire event. */
export function assignLogOffset(draft: RuntimeEventDraft, logOffset: number): RuntimeEvent {
  return RuntimeEventSchema.parse({ ...draft, logOffset });
}
