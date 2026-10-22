import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { resolveWorkspacePath } from './paths.js';
import { failure, textResult } from './result.js';

/**
 * `apply_patch` — apply a unified diff.
 *
 * The patch is applied hunk by hunk. When any hunk fails, **every** change
 * is rolled back: a partial patch is worse than no patch.
 *
 * See docs/decisions.md D-023.
 */

export const ApplyPatchInputSchema = z
  .object({
    patch: z.string().min(1),
  })
  .strict();
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export type PatchLineKind = 'context' | 'remove' | 'add';

export interface PatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
}

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

export interface PatchFile {
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** True when the hunk collected every line its header announced. */
function hunkIsComplete(hunk: { header: RegExpExecArray; lines: PatchLine[] }): boolean {
  const [, , oldCount, , newCount] = hunk.header;
  const oldLines = hunk.lines.filter((line) => line.kind !== 'add').length;
  const newLines = hunk.lines.filter((line) => line.kind !== 'remove').length;
  return oldLines >= (oldCount === undefined ? 1 : Number(oldCount))
    && newLines >= (newCount === undefined ? 1 : Number(newCount));
}

/** Parse a unified diff into its files and hunks. */
export function parseUnifiedDiff(patch: string): PatchFile[] {
  const lines = patch.split('\n');
  // A trailing newline is not a line of the patch.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const files: PatchFile[] = [];
  let current: { path: string; hunks: PatchHunk[] } | undefined;
  let hunk: { header: RegExpExecArray; lines: PatchLine[] } | undefined;

  const flushHunk = (): void => {
    if (!current || !hunk) return;
    const [, oldStart, oldCount, newStart, newCount] = hunk.header;
    current.hunks.push({
      oldStart: Number(oldStart),
      oldCount: oldCount === undefined ? 1 : Number(oldCount),
      newStart: Number(newStart),
      newCount: newCount === undefined ? 1 : Number(newCount),
      lines: hunk.lines,
    });
    hunk = undefined;
  };

  const flushFile = (): void => {
    flushHunk();
    if (current) files.push({ path: current.path, hunks: current.hunks });
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      flushFile();
      // The target path comes from the next `+++` line; a placeholder keeps
      // the parser going until it arrives.
      current = { path: '', hunks: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) throw new PatchParseError('a `+++` header without a `---` header');
      const target = line.slice(4).trim();
      current.path = target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      if (!current) throw new PatchParseError('a hunk without a file header');
      const header = HUNK_HEADER.exec(line);
      if (!header) throw new PatchParseError(`cannot parse the hunk header: ${line}`);
      hunk = { header, lines: [] };
      continue;
    }
    if (hunk) {
      // The hunk header says how many lines it carries; anything after that
      // belongs to the next hunk (or to nothing at all).
      if (hunkIsComplete(hunk)) {
        flushHunk();
        continue;
      }
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) hunk.lines.push({ kind: 'remove', text: line.slice(1) });
      else if (line.startsWith(' ')) hunk.lines.push({ kind: 'context', text: line.slice(1) });
      else if (line.length === 0) hunk.lines.push({ kind: 'context', text: '' });
      else throw new PatchParseError(`unexpected line in the patch: ${line}`);
    }
  }
  flushFile();

  const usable = files.filter((file) => file.hunks.length > 0);
  if (usable.length === 0) {
    throw new PatchParseError('the patch does not contain any hunk');
  }
  for (const file of usable) {
    if (file.path.length === 0) {
      throw new PatchParseError('a file header has no target path');
    }
  }
  return usable;
}

const sameLines = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((line, index) => line === right[index]);

/** Apply one hunk to the file lines, returning the new lines. */
export function applyHunk(
  lines: readonly string[],
  hunk: PatchHunk,
  filePath: string,
): string[] {
  const expected = hunk.lines
    .filter((line) => line.kind !== 'add')
    .map((line) => line.text);
  const replacement = hunk.lines
    .filter((line) => line.kind !== 'remove')
    .map((line) => line.text);

  const at = hunk.oldStart - 1;
  const actual = lines.slice(at, at + expected.length);
  if (sameLines(actual, expected)) {
    const next = [...lines];
    next.splice(at, expected.length, ...replacement);
    return next;
  }

  // The line numbers drifted: look for the context instead of failing.
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    const candidate = lines.slice(index, index + expected.length);
    if (sameLines(candidate, expected)) {
      const next = [...lines];
      next.splice(index, expected.length, ...replacement);
      return next;
    }
  }

  throw new PatchParseError(
    `the hunk at line ${hunk.oldStart} of ${filePath} does not match the file content`,
  );
}

export const applyPatchTool: ToolImpl = {
  definition: {
    name: 'apply_patch',
    description:
      'Apply a unified diff to the workspace. The whole patch is rolled back when any hunk does not apply.',
    schema: ApplyPatchInputSchema,
    executionMode: 'sync',
    risk: 'medium',
  },

  async execute(ctx, input) {
    const parsed = ApplyPatchInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('apply_patch', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    let files: PatchFile[];
    try {
      files = parseUnifiedDiff(parsed.data.patch);
    } catch (error: unknown) {
      return failure(
        'apply_patch',
        `cannot parse the patch: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const written: { path: string; previous: string }[] = [];

    try {
      for (const file of files) {
        const target = resolveWorkspacePath(ctx.cwd, file.path);
        const stats = statSync(target.absolute);
        if (!stats.isFile()) {
          throw new PatchParseError(`${file.path} is not a file`);
        }

        const previous = readFileSync(target.absolute, 'utf8');
        const endsWithNewline = previous.endsWith('\n');
        const lines = previous.split('\n');
        if (endsWithNewline) lines.pop();

        let next = lines;
        for (const hunk of file.hunks) {
          next = applyHunk(next, hunk, file.path);
        }

        const content = next.join('\n') + (endsWithNewline ? '\n' : '');
        writeFileSync(target.absolute, content, 'utf8');
        written.push({ path: target.relative, previous });

        await ctx.onFileChanged({
          path: target.relative,
          change: 'modified',
          bytes: Buffer.byteLength(content, 'utf8'),
        });
      }
    } catch (error: unknown) {
      // Roll back every change this call already made.
      for (const entry of written) {
        try {
          writeFileSync(resolveWorkspacePath(ctx.cwd, entry.path).absolute, entry.previous, 'utf8');
        } catch {
          // Nothing else can be done here; the error below names the file.
        }
      }
      return failure(
        'apply_patch',
        `${error instanceof Error ? error.message : 'unknown error'} (the patch was rolled back)`,
      );
    }

    return textResult(`applied the patch to ${written.length} file(s): ${written.map((entry) => entry.path).join(', ')}`);
  },
};
