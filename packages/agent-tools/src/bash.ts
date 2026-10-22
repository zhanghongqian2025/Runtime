import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '@local-agent/protocol';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { failure, textResult } from './result.js';
import { truncateText } from './truncate.js';

/**
 * `bash` — run a shell command.
 *
 * The command runs in a shell, so it is always a **high risk** operation; the
 * permission core decides whether it may run at all.
 *
 * A background task outlives the turn (D-021): it is detached, its output is
 * written to `artifacts/background/<taskId>.log` and the model reads that
 * file to follow the progress.
 */

export const BashInputSchema = z
  .object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    background: z.boolean().optional(),
  })
  .strict();
export type BashInput = z.infer<typeof BashInputSchema>;

export const DEFAULT_TIMEOUT_MS = 120_000;
export const BACKGROUND_LOG_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * The environment a command may see.
 *
 * The full process environment is **not** inherited: the model must not be
 * able to read the API keys of the runtime through `env`.
 */
export const COMMAND_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL'] as const;

export function buildCommandEnv(
  toolEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of COMMAND_ENV_KEYS) {
    const value = processEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(toolEnv)) {
    env[key] = value;
  }
  return env;
}

const taskId = (): string =>
  `task_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}${Date.now().toString(16)}`;

export const bashTool: ToolImpl = {
  definition: {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Supports a timeout and background execution; a background task keeps running after the turn and writes its output to a log file.',
    schema: BashInputSchema,
    executionMode: 'background',
    risk: 'high',
  },

  async execute(ctx, input, signal, onUpdate) {
    const parsed = BashInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure('bash', `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    const command = parsed.data.command;
    const env = buildCommandEnv(ctx.env);

    if (parsed.data.background === true) {
      const id = taskId();
      const logRelative = `artifacts/background/${id}.log`;
      let logPath: string;
      try {
        logPath = ctx.artifacts.path(logRelative);
        mkdirSync(dirname(logPath), { recursive: true });
      } catch (error: unknown) {
        return failure(
          'bash',
          `cannot prepare the background log: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      const descriptor = openSync(logPath, 'a');
      try {
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: ctx.cwd,
          env,
          detached: true,
          stdio: ['ignore', descriptor, descriptor],
        });
        child.unref();
        writeSync(
          descriptor,
          `${JSON.stringify({ taskId: id, pid: child.pid, command, startedAt: new Date(ctx.now()).toISOString() })}\n`,
        );
      } catch (error: unknown) {
        return failure(
          'bash',
          `cannot start the background task: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      } finally {
        closeSync(descriptor);
      }

      return textResult(
        `background task ${id} started (pid unknown after detach). Its output is written to ${logRelative}; read that file to follow the progress.`,
      );
    }

    const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd: ctx.cwd, env });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const cap = ctx.limits.maxBytes;

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = (): void => {
        child.kill('SIGTERM');
        finish(failure('bash', 'the command was aborted'));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      }, timeoutMs);
      timer.unref?.();

      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        onUpdate({ chunk: text, stream: 'stdout' });
        if (stdout.length + text.length <= cap) {
          stdout += text;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        onUpdate({ chunk: text, stream: 'stderr' });
        if (stderr.length + text.length <= cap) {
          stderr += text;
        }
      });

      child.on('error', (error: Error) => {
        finish(failure('bash', `cannot run the command: ${error.message}`));
      });

      child.on('close', (code, closeSignal) => {
        const body = [
          stdout.length > 0 ? stdout : undefined,
          stderr.length > 0 ? stderr : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join('\n');
        const truncated = truncateText(body, ctx.limits);

        if (timedOut) {
          finish(
            failure('bash', `the command timed out after ${timeoutMs}ms`),
          );
          return;
        }
        if (closeSignal !== null) {
          finish(failure('bash', `the command was terminated by ${closeSignal}`));
          return;
        }
        if (code !== 0) {
          finish({
            ok: false,
            isError: true,
            content: [
              {
                type: 'text',
                text: `the command exited with code ${code ?? 'unknown'}\n${truncated.text}`,
              },
            ],
            ...(truncated.omittedBytes > 0
              ? {
                  truncated: {
                    omittedBytes: truncated.omittedBytes,
                    strategy: truncated.strategy,
                  },
                }
              : {}),
          });
          return;
        }

        finish({
          ok: true,
          isError: false,
          content: [{ type: 'text', text: truncated.text || '(no output)' }],
          ...(truncated.omittedBytes > 0
            ? {
                truncated: {
                  omittedBytes: truncated.omittedBytes,
                  strategy: truncated.strategy,
                },
              }
            : {}),
        });
      });
    });
  },
};
