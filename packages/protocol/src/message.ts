import { z } from 'zod';

/**
 * Message contracts.
 *
 * The canonical history is a sequence of `AgentMessage`. Provider-bound views
 * are always derived from it by projection; the canonical form is never
 * rewritten by a projection (see docs/contracts.md §8.1).
 */

export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** Tool results carry text and image payloads. */
export const ToolContentTextSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

export const ToolContentImageSchema = z
  .object({
    type: z.literal('image'),
    mediaType: z.string().min(1),
    /** base64 encoded bytes. */
    data: z.string(),
  })
  .strict();

export const ToolContentBlockSchema = z.discriminatedUnion('type', [
  ToolContentTextSchema,
  ToolContentImageSchema,
]);
export type ToolContentBlock = z.infer<typeof ToolContentBlockSchema>;

export const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

export const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    text: z.string(),
    signature: z.string().optional(),
  })
  .strict();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .strict();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    content: z.array(ToolContentBlockSchema),
    isError: z.boolean(),
  })
  .strict();

export const ImageBlockSchema = z
  .object({
    type: z.literal('image'),
    mediaType: z.string().min(1),
    data: z.string(),
  })
  .strict();

/**
 * Typed custom messages are the only payload `appendMessage` accepts.
 *
 * The kind set is closed on purpose: an open-ended payload type would let a
 * caller smuggle arbitrary structures into the canonical history.
 */
export const CUSTOM_MESSAGE_KINDS = [
  'marker.tail',
  'marker.before-current-user',
  'after-commit',
] as const;
export const CustomMessageKindSchema = z.enum(CUSTOM_MESSAGE_KINDS);
export type CustomMessageKind = z.infer<typeof CustomMessageKindSchema>;

export const CustomBlockSchema = z
  .object({
    type: z.literal('custom'),
    kind: CustomMessageKindSchema,
    hidden: z.literal(true),
    payload: z.unknown(),
  })
  .strict();

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  CustomBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const AgentMessageMetaSchema = z
  .object({
    turnId: z.string().min(1).optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    usage: TokenUsageSchema.optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const AgentMessageSchema = z
  .object({
    id: z.string().min(1),
    role: MessageRoleSchema,
    content: z.array(ContentBlockSchema),
    createdAt: z.string().min(1),
    meta: AgentMessageMetaSchema.optional(),
  })
  .strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * Tool result shape.
 *
 * It lives in `protocol` because it crosses package boundaries: the tool layer
 * produces it, the event layer publishes it, and clients consume it.
 */
export const ToolResultSchema = z
  .object({
    ok: z.boolean(),
    content: z.array(ToolContentBlockSchema),
    isError: z.boolean(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    truncated: z
      .object({
        omittedBytes: z.number().int().nonnegative(),
        strategy: z.enum(['head-tail', 'head', 'none']),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Incremental output produced while a tool is still running. */
export const ToolUpdateSchema = z
  .object({
    chunk: z.string(),
    stream: z.enum(['stdout', 'stderr']),
  })
  .strict();
export type ToolUpdate = z.infer<typeof ToolUpdateSchema>;

/** A message whose only block is a hidden typed custom marker. */
export function isCustomMarkerMessage(message: AgentMessage): boolean {
  return (
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'custom' && block.hidden)
  );
}
