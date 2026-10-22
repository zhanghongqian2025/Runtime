import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';

/**
 * `edit` — replace an exact string in a file.
 *
 * The replacement must be unambiguous: when `oldString` occurs more than once
 * the call is refused with the number of occurrences, and when it occurs
 * never the call is refused with a suggestion. The edit never fails
 * silently.
 */

export const EditInputSchema = z
  .object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict();
export type EditInput = z.infer<typeof EditInputSchema>;

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

export const editTool: ToolImpl = {
  definition: {
    name: 'edit',
    description:
      'Replace an exact string in a file. The old string must appear exactly once unless replaceAll is set.',
    schema: EditInputSchema,
    executionMode: 'sync',
    risk: 'medium',
  },

  async execute(ctx, input) {
    const parsed = EditInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('edit', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let target;
    try {
      target = resolveWorkspacePath(ctx.cwd, parsed.data.path);
    } catch (error: unknown) {
      return failure('edit', error instanceof Error ? error.message : 'invalid path');
    }

    let stats;
    try {
      stats = statSync(target.absolute);
    } catch {
      return failure('edit', `file not found: ${target.relative}`);
    }
    if (stats.isDirectory()) {
      return failure('edit', `${target.relative} is a directory, not a file`);
    }

    let content: string;
    try {
      content = readFileSync(target.absolute, 'utf8');
    } catch (error: unknown) {
      return failure(
        'edit',
        `cannot read ${target.relative}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const occurrences = countOccurrences(content, parsed.data.oldString);

    if (occurrences === 0) {
      const preview = parsed.data.oldString.slice(0, 40);
      return failure(
        'edit',
        `oldString was not found in ${target.relative}. It starts with ${JSON.stringify(preview)} — check the whitespace and the surrounding lines.`,
      );
    }

    if (occurrences > 1 && parsed.data.replaceAll !== true) {
      return failure(
        'edit',
        `oldString appears ${occurrences} times in ${target.relative}. Provide more surrounding context, or set replaceAll to true.`,
      );
    }

    const next = parsed.data.replaceAll === true
      ? content.split(parsed.data.oldString).join(parsed.data.newString)
      : content.replace(parsed.data.oldString, parsed.data.newString);

    try {
      writeFileSync(target.absolute, next, 'utf8');
    } catch (error: unknown) {
      return failure(
        'edit',
        `cannot write ${target.relative}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await ctx.onFileChanged({
      path: target.relative,
      change: 'modified',
      bytes: Buffer.byteLength(next, 'utf8'),
    });

    const replaced = parsed.data.replaceAll === true ? occurrences : 1;
    return textResult(`replaced ${replaced} occurrence(s) in ${target.relative}`);
  },
};
