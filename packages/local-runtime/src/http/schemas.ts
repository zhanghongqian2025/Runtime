import { z } from 'zod';

/** Request bodies of the session endpoints. Unknown fields are rejected. */

export const CreateSessionRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    providerId: z.enum(['openai-compatible', 'anthropic-messages']).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SendMessageRequestSchema = z
  .object({
    text: z.string().min(1),
    /** Optional idempotency key: repeating it never runs the turn twice. */
    clientMessageId: z.string().min(1).optional(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
