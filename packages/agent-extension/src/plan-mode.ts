import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import type { ExtensionManifest } from '@local-agent/agent-core/pi-turn-runner';

/**
 * The plan mode extension.
 *
 * It owns the **conventions** of the plan document: where it lives, how the
 * draft is backed up, how the review snapshot is frozen and how the frozen
 * snapshot is marked as the authority of the implementation turn.
 *
 * The plan document belongs to the session, not to the workspace:
 * `artifacts/plan.md` under the session directory.
 *
 * See docs/contracts.md §9.
 */

/** The draft the agent writes while it plans. */
export const PLAN_FILE = 'artifacts/plan.md';
/** The frozen snapshot the user reviews and the implementation follows. */
export const PLAN_REVIEW_FILE = 'artifacts/plan.review.md';
/** The metadata of the frozen snapshot. */
export const PLAN_REVIEW_META_FILE = 'artifacts/plan.review.meta.json';
/** The prefix of the draft backups. */
export const PLAN_BACKUP_PREFIX = 'artifacts/plan.md.bak-';

export const PLAN_MODE = 'plan';
export const DEFAULT_MODE = 'default';

/** The metadata of a frozen snapshot. */
export interface PlanReviewMeta {
  /** Identifies the plan revision. */
  readonly planId: string;
  readonly frozenAt: string;
  /** The digest of the draft the snapshot was taken from. */
  readonly sourceDraftSha256: string;
  /** The digest of the frozen markdown. */
  readonly snapshotSha256: string;
  /** Whether the snapshot was already handed to an implementation turn. */
  readonly consumed: boolean;
}

/** The name of the backup file for a given moment. */
export function planBackupName(timestamp: string): string {
  const stamp = timestamp.replace(/[:.]/g, '-');
  return `${PLAN_BACKUP_PREFIX}${stamp}`;
}

/** The digest of a text. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Freeze a draft into a review snapshot.
 *
 * The snapshot is a **pure** copy of the draft: once it exists, editing the
 * draft does not change the snapshot, and the implementation turn follows the
 * snapshot, not the draft.
 */
export function freezePlan(
  draft: string,
  options: { readonly planId: string; readonly frozenAt: string },
): { readonly markdown: string; readonly meta: PlanReviewMeta } {
  const markdown = draft.endsWith('\n') ? draft : `${draft}\n`;
  return {
    markdown,
    meta: {
      planId: options.planId,
      frozenAt: options.frozenAt,
      sourceDraftSha256: digestOf(draft),
      snapshotSha256: digestOf(markdown),
      consumed: false,
    },
  };
}

/** The marker kind that carries the frozen plan into the implementation turn. */
export const FROZEN_PLAN_MARKER = 'after-commit';

export const planExtensionManifest: ExtensionManifest = {
  name: 'plan-mode',
  description:
    'Lets the agent plan before it acts: a draft plan in the session, a frozen snapshot the user reviews, and an implementation turn that follows the snapshot.',
  version: '0.1.0',
  modes: [
    {
      name: 'plan',
      description: 'The agent only plans; nothing is executed until the plan is approved.',
      interactionMode: 'plan',
    },
  ],
};

/**
 * `plan_write` — write the plan draft.
 *
 * The draft belongs to the session, never to the workspace. The tool can
 * only write the one file, so a plan turn cannot touch anything else.
 */

export const PlanWriteInputSchema = z
  .object({
    content: z.string(),
  })
  .strict();
export type PlanWriteInput = z.infer<typeof PlanWriteInputSchema>;

export const planWriteTool: ToolImpl = {
  definition: {
    name: 'plan_write',
    description:
      'Write the plan draft. The draft lives in the session, not in the workspace, and it is the document the user reviews before anything is implemented.',
    schema: PlanWriteInputSchema,
    executionMode: 'sync',
    risk: 'low',
  },

  async execute(ctx, input) {
    const parsed = PlanWriteInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        isError: true,
        content: [
          {
            type: 'text',
            text: `plan_write failed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          },
        ],
      };
    }

    try {
      await ctx.artifacts.write(PLAN_FILE, parsed.data.content);
    } catch (error: unknown) {
      return {
        ok: false,
        isError: true,
        content: [
          {
            type: 'text',
            text: `plan_write failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          },
        ],
      };
    }

    return {
      ok: true,
      isError: false,
      content: [{ type: 'text', text: `the plan draft was written (${PLAN_FILE})` }],
    };
  },
};
