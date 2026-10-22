import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';
import { truncateText } from './truncate.js';

/**
 * `read` — read a file, optionally a line range.
 *
 * `offset` is the 1-based line number to start at, `limit` is the number of
 * lines to read. The result is trimmed with the shared size governance.
 */

export const ReadInputSchema = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ReadInput = z.infer<typeof ReadInputSchema>;

export const readTool: ToolImpl = {
  definition: {
    name: 'read',
    description:
      'Read a file from the workspace. Optionally read a line range with offset (1-based) and limit.',
    schema: ReadInputSchema,
    executionMode: 'sync',
    risk: 'low',
  },

  async execute(ctx, input) {
    const parsed = ReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('read', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let target;
    try {
      target = resolveWorkspacePath(ctx.cwd, parsed.data.path);
    } catch (error: unknown) {
      return failure('read', error instanceof Error ? error.message : 'invalid path');
    }

    let stats;
    try {
      stats = statSync(target.absolute);
    } catch {
      return failure('read', `file not found: ${target.relative}`);
    }

    if (stats.isDirectory()) {
      return failure('read', `${target.relative} is a directory, not a file`);
    }

    let raw: string;
    try {
      raw = readFileSync(target.absolute, 'utf8');
    } catch (error: unknown) {
      return failure(
        'read',
        `cannot read ${target.relative}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const allLines = raw.split('\n');
    const start = (parsed.data.offset ?? 1) - 1;
    const selected = parsed.data.limit === undefined
      ? allLines.slice(start)
      : allLines.slice(start, start + parsed.data.limit);

    if (selected.length === 0) {
      return textResult(`(no lines in ${target.relative} for the requested range)`);
    }

    const truncated = truncateText(selected.join('\n'), ctx.limits);
    return {
      ...textResult(truncated.text),
      ...(truncated.omittedBytes > 0
        ? {
            truncated: {
              omittedBytes: truncated.omittedBytes,
              strategy: truncated.strategy,
            },
          }
        : {}),
    };
  },
};
