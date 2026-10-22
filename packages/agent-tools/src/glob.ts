import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { globToRegExp } from './grep.js';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';
import { truncateText } from './truncate.js';
import { walkFiles } from './walk.js';

/**
 * `glob` — find files by name or path pattern.
 *
 * The pattern is matched against the path relative to the search root, so
 * `**\/*.ts` finds every TypeScript file below the root.
 */

export const GlobInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict();
export type GlobInput = z.infer<typeof GlobInputSchema>;

export const DEFAULT_MAX_RESULTS = 500;

export const globTool: ToolImpl = {
  definition: {
    name: 'glob',
    description:
      'Find files by name or path pattern, for example "**/*.ts" or "src/**/index.ts". The paths are relative to the search root.',
    schema: GlobInputSchema,
    executionMode: 'sync',
    risk: 'low',
  },

  async execute(ctx, input) {
    const parsed = GlobInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('glob', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let root;
    try {
      root = resolveWorkspacePath(ctx.cwd, parsed.data.path ?? '.');
    } catch (error: unknown) {
      return failure('glob', error instanceof Error ? error.message : 'invalid path');
    }

    const matcher = globToRegExp(parsed.data.pattern);
    const maxResults = parsed.data.maxResults ?? DEFAULT_MAX_RESULTS;

    const found: string[] = [];
    for (const file of walkFiles({ root: root.absolute })) {
      if (!matcher.test(file.relative)) continue;
      found.push(file.relative);
      if (found.length >= maxResults) break;
    }

    if (found.length === 0) {
      return textResult('no match');
    }

    found.sort();
    const truncated = truncateText(found.join('\n'), ctx.limits);
    return {
      ...textResult(truncated.text),
      ...(truncated.omittedBytes > 0
        ? { truncated: { omittedBytes: truncated.omittedBytes, strategy: truncated.strategy } }
        : {}),
      metadata: { matches: found.length },
    };
  },
};
