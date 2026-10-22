import { z } from 'zod';

/**
 * Permission shapes.
 *
 * The *policy* lives in the host runtime; the *shapes* live here because the
 * approval card travels from the permission core to the event stream and on
 * to clients.
 */

export const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical'] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PERMISSION_OUTCOMES = ['allow', 'deny', 'ask'] as const;
export const PermissionOutcomeSchema = z.enum(PERMISSION_OUTCOMES);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

export const PERMISSION_MODES = ['ask', 'auto', 'full-access'] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const APPROVAL_CHOICES = ['allow-once', 'allow-session', 'deny'] as const;
export const ApprovalChoiceSchema = z.enum(APPROVAL_CHOICES);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const ApprovalOptionSchema = z
  .object({
    id: ApprovalChoiceSchema,
    label: z.string().min(1),
    default: z.boolean().optional(),
  })
  .strict();
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

/** The approval card shown to the user before a gated tool call runs. */
export const ApprovalRequestSchema = z
  .object({
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
    risk: RiskLevelSchema,
    matchedRule: z.string().optional(),
    reason: z.string().min(1),
    options: z.array(ApprovalOptionSchema),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResolutionSchema = z
  .object({
    requestId: z.string().min(1),
    choice: ApprovalChoiceSchema,
    decidedBy: z.enum(['user', 'timeout', 'policy']),
  })
  .strict();
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;
