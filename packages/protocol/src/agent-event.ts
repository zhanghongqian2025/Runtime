import { z } from 'zod';
import { AgentMessageSchema, TokenUsageSchema, ToolResultSchema } from './message.js';

/**
 * AgentEvent — the loop's internal vocabulary.
 *
 * The core produces these; `event-bridge` converts them into the public
 * `RuntimeEvent` trunk. Keeping two vocabularies lets the loop stay
 * independent from the wire format (docs/contracts.md §2.1).
 */

export const AGENT_EVENT_TYPES = [
  'turn.started',
  'turn.completed',
  'turn.failed',
  'step.started',
  'step.completed',
  'llm.request.started',
  'llm.retry.scheduled',
  'message.completed',
  'text.delta',
  'thinking.delta',
  'tool.intent.created',
  'tool.intent.started',
  'tool.intent.progress',
  'tool.intent.completed',
  'tool.intent.blocked',
  'file.changed',
  'history.flushed',
  'compaction.started',
  'compaction.completed',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const AgentEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('turn.started'),
      turnId: z.string().min(1),
      sessionId: z.string().min(1),
      stepCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      turnId: z.string().min(1),
      stepCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.failed'),
      turnId: z.string().min(1),
      code: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('step.started'),
      turnId: z.string().min(1),
      stepIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('step.completed'),
      turnId: z.string().min(1),
      stepIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('llm.request.started'),
      turnId: z.string().min(1),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('llm.retry.scheduled'),
      turnId: z.string().min(1),
      attempt: z.number().int().positive(),
      delayMs: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('message.completed'),
      turnId: z.string().min(1),
      message: AgentMessageSchema,
      usage: TokenUsageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('text.delta'),
      turnId: z.string().min(1),
      messageId: z.string().min(1),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('thinking.delta'),
      turnId: z.string().min(1),
      messageId: z.string().min(1),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.intent.created'),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.intent.started'),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.intent.progress'),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      chunk: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.intent.completed'),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      result: ToolResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.intent.blocked'),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      blockedBy: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('file.changed'),
      turnId: z.string().min(1),
      path: z.string().min(1),
      change: z.enum(['created', 'modified', 'deleted']),
    })
    .strict(),
  z
    .object({
      type: z.literal('history.flushed'),
      turnId: z.string().min(1),
      messageCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('compaction.started'),
      turnId: z.string().min(1),
      reason: z.enum(['watermark', 'manual']),
      beforeTokens: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('compaction.completed'),
      turnId: z.string().min(1),
      beforeTokens: z.number().int().nonnegative(),
      afterTokens: z.number().int().nonnegative(),
      savedRatio: z.number().min(0).max(1),
      checkpointId: z.string().min(1),
    })
    .strict(),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
