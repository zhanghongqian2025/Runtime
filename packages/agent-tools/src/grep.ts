import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';
import { truncateText } from './truncate.js';
import { walkFiles } from './walk.js';

/**
 * `grep` — search the workspace content.
 *
 * Two modes: `literal` (the default, no escaping needed) and `regex`. An
 * invalid regular expression is reported instead of being swallowed.
 */

export const GrepInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    mode: z.enum(['regex', 'literal']).default('literal'),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    maxMatches: z.number().int().positive().optional(),
  })
  .strict();
export type GrepInput = z.infer<typeof GrepInputSchema>;

export const DEFAULT_MAX_MATCHES = 200;

export const grepTool: ToolImpl = {
  definition: {
    name: 'grep',
    description:
      'Search the workspace content. Use literal mode for plain text and regex mode for patterns; the output is `path:line:content`.',
    schema: GrepInputSchema,
    executionMode: 'sync',
    risk: 'low',
  },

  async execute(ctx, input) {
    const parsed = GrepInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('grep', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let root;
    try {
      root = resolveWorkspacePath(ctx.cwd, parsed.data.path ?? '.');
    } catch (error: unknown) {
      return failure('grep', error instanceof Error ? error.message : 'invalid path');
    }

    let matcher: (line: string) => boolean;
    if (parsed.data.mode === 'regex') {
      try {
        const regex = new RegExp(parsed.data.pattern, parsed.data.ignoreCase === true ? 'i' : '');
        matcher = (line) => regex.test(line);
      } catch (error: unknown) {
        return failure(
          'grep',
          `invalid regular expression: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    } else {
      const needle = parsed.data.ignoreCase === true
        ? parsed.data.pattern.toLowerCase()
        : parsed.data.pattern;
      matcher = (line) => (parsed.data.ignoreCase === true ? line.toLowerCase() : line).includes(needle);
    }

    let globFilter: RegExp | undefined;
    if (parsed.data.glob !== undefined) {
      globFilter = globToRegExp(parsed.data.glob);
    }

    const maxMatches = parsed.data.maxMatches ?? DEFAULT_MAX_MATCHES;
    const matches: string[] = [];
    let truncated = false;

    for (const file of walkFiles({ root: root.absolute })) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      if (globFilter && !globFilter.test(file.relative)) continue;

      let content: string;
      try {
        content = readFileSync(file.absolute, 'utf8');
      } catch {
        continue;
      }
      // A file with null bytes is binary: reading it as text is noise.
      if (content.includes('\u0000')) continue;

      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (!matcher(line)) continue;
        matches.push(`${file.relative}:${index + 1}:${line}`);
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }

    if (matches.length === 0) {
      return textResult('no match');
    }

    const trimmed = truncateText(matches.join('\n'), ctx.limits);
    return {
      ...textResult(trimmed.text),
      ...(trimmed.omittedBytes > 0
        ? { truncated: { omittedBytes: trimmed.omittedBytes, strategy: trimmed.strategy } }
        : {}),
      metadata: { matches: matches.length, truncated },
    };
  },
};

/** Convert a glob pattern into a regular expression over relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '{') {
      source += '(';
      continue;
    }
    if (char === '}') {
      source += ')';
      continue;
    }
    if (char === ',') {
      source += '|';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
