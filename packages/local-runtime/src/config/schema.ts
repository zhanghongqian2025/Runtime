import { z } from 'zod';
import { PermissionModeSchema } from '@local-agent/protocol';

/**
 * The configuration schema.
 *
 * It lives in its own module so the file loader and the runtime types can
 * both use it without importing each other.
 */

export const PROVIDER_IDS = ['openai-compatible', 'anthropic-messages'] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderConfigSchema = z
  .object({
    id: ProviderIdSchema,
    baseUrl: z.string().min(1),
    /** Name of the environment variable that holds the key. Never the key. */
    apiKeyEnvVar: z.string().min(1),
    model: z.string().min(1),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
    thinking: z
      .object({
        enabled: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const EventsConfigSchema = z
  .object({
    /** Events kept in the session log before rotation. */
    retainCount: z.number().int().positive(),
  })
  .strict();

export const ToolsConfigSchema = z
  .object({
    maxResultBytes: z.number().int().positive(),
    maxCallBytes: z.number().int().positive(),
    maxLines: z.number().int().positive(),
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    /** Loopback by default: the runtime is never exposed to the network. */
    host: z.string().min(1).default('127.0.0.1'),
    /** 0 lets the operating system pick a free port. */
    httpPort: z.number().int().min(0).max(65535).default(0),
    permissionMode: PermissionModeSchema.default('ask'),
    providers: z.array(ProviderConfigSchema).default([]),
    events: EventsConfigSchema.default({ retainCount: 2000 }),
    tools: ToolsConfigSchema.default({
      maxResultBytes: 32768,
      maxCallBytes: 262144,
      maxLines: 2000,
    }),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Environment variables the runtime reads. */
export const RUNTIME_ENV_KEYS = {
  host: 'LOCAL_AGENT_HOST',
  httpPort: 'LOCAL_AGENT_HTTP_PORT',
  permissionMode: 'LOCAL_AGENT_PERMISSION_MODE',
} as const;

/** The effective configuration plus the in-memory key material. */
