import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';

/**
 * `write` — write a whole file.
 *
 * The parent directory must exist: a tool that silently creates directories
 * hides typos. An existing file is replaced, and the change is reported to
 * the host so the event stream stays truthful.
 */

export const WriteInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type WriteInput = z.infer<typeof WriteInputSchema>;

export const writeTool: ToolImpl = {
  definition: {
    name: 'write',
    description: 'Write a file in the workspace, replacing it when it already exists.',
    schema: WriteInputSchema,
    executionMode: 'sync',
    risk: 'medium',
  },

  async execute(ctx, input) {
    const parsed = WriteInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('write', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let target;
    try {
      target = resolveWorkspacePath(ctx.cwd, parsed.data.path);
    } catch (error: unknown) {
      return failure('write', error instanceof Error ? error.message : 'invalid path');
    }

    const existed = existsSync(target.absolute);
    if (existed) {
      const stats = statSync(target.absolute);
      if (stats.isDirectory()) {
        return failure('write', `${target.relative} is a directory, not a file`);
      }
    }

    const parent = dirname(target.absolute);
    if (!existsSync(parent)) {
      return failure('write', `the directory ${parent} does not exist`);
    }

    try {
      writeFileSync(target.absolute, parsed.data.content, 'utf8');
    } catch (error: unknown) {
      return failure(
        'write',
        `cannot write ${target.relative}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await ctx.onFileChanged({
      path: target.relative,
      change: existed ? 'modified' : 'created',
      bytes: Buffer.byteLength(parsed.data.content, 'utf8'),
    });

    return textResult(
      `${existed ? 'updated' : 'created'} ${target.relative} (${Buffer.byteLength(parsed.data.content, 'utf8')} bytes)`,
    );
  },
};

/** Create a directory tree; used by tools that own a directory. */
export function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}
