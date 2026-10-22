import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventBody, ToolResult } from '@local-agent/protocol';
import type { ToolExecutionContext } from '@local-agent/agent-core/tools';
import { applyPatchTool } from './apply-patch.js';
import { askUserTool } from './ask-user.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { LOCAL_TOOLS } from './index.js';
import { readTool } from './read.js';
import { todoWriteTool } from './todo-write.js';
import { truncateText } from './truncate.js';
import { writeTool } from './write.js';

/**
 * The local tool set.
 *
 * Every tool gets its boundary cases: the success path, the diagnosable
 * failures and the cases where the tool must refuse to act.
 */

const workspace = (): string => mkdtempSync(join(tmpdir(), 'local-agent-tools-'));

const makeContext = (
  cwd: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => {
  const events: RuntimeEventBody[] = [];
  const context: ToolExecutionContext = {
    sessionId: 'sess_test',
    turnId: 'turn_test',
    toolCallId: 'tool_test',
    cwd,
    env: {},
    now: () => Date.now(),
    limits: { maxBytes: 32_768, maxLines: 2000 },
    requestPermission: async (request) => ({
      requestId: request.requestId,
      choice: 'deny',
      decidedBy: 'policy',
    }),
    onFileChanged: () => undefined,
    emitEvent: async (body) => {
      events.push(body);
    },
    askUser: async (request) => ({ requestId: request.requestId, answers: {} }),
    artifacts: {
      path: (name) => join(cwd, name),
      write: async (name, content) => {
        writeFileSync(join(cwd, name), content, 'utf8');
      },
      append: async (name, content) => {
        writeFileSync(join(cwd, name), content, { flag: 'a' });
      },
      read: async (name) => {
        try {
          return readFileSync(join(cwd, name), 'utf8');
        } catch {
          return undefined;
        }
      },
    },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    ...overrides,
  };
  return Object.assign(context, { __events: events });
};

const textOf = (result: ToolResult): string =>
  result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

const controller = (): AbortController => new AbortController();

describe('tool set', () => {
  it('exposes exactly the nine local tools', () => {
    expect(LOCAL_TOOLS.map((tool) => tool.definition.name)).toEqual([
      'read',
      'write',
      'edit',
      'apply_patch',
      'bash',
      'grep',
      'glob',
      'todo_write',
      'ask_user',
    ]);
  });

  it('gives every tool a name, a description and a schema', () => {
    for (const tool of LOCAL_TOOLS) {
      expect(tool.definition.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.definition.description.length).toBeGreaterThan(10);
      expect(tool.definition.schema).toBeDefined();
    }
  });
});

describe('read', () => {
  it('reads a file', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
    const result = await readTool.execute(makeContext(cwd), { path: 'a.txt' }, controller().signal, () => undefined);
    expect(result.ok).toBe(true);
    expect(textOf(result)).toBe('one\ntwo\nthree\n');
  });

  it('reads a line range', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    const result = await readTool.execute(
      makeContext(cwd),
      { path: 'a.txt', offset: 2, limit: 2 },
      controller().signal,
      () => undefined,
    );
    expect(textOf(result)).toBe('two\nthree');
  });

  it('reports a missing file instead of throwing', async () => {
    const cwd = workspace();
    const result = await readTool.execute(makeContext(cwd), { path: 'nope.txt' }, controller().signal, () => undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('file not found');
  });

  it('refuses a path outside the workspace', async () => {
    const cwd = workspace();
    const result = await readTool.execute(
      makeContext(cwd),
      { path: '../outside.txt' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('escapes the workspace');
  });

  it('trims a long file and reports the dropped bytes', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'big.txt'), `${'x'.repeat(5000)}\n`);
    const result = await readTool.execute(
      makeContext(cwd, { limits: { maxBytes: 1000, maxLines: 2000 } }),
      { path: 'big.txt' },
      controller().signal,
      () => undefined,
    );
    expect(result.truncated?.omittedBytes).toBeGreaterThan(0);
    expect(result.truncated?.strategy).toBe('head-tail');
    expect(textOf(result)).toContain('truncated');
  });
});

describe('write', () => {
  it('creates a file and reports the change', async () => {
    const cwd = workspace();
    const changes: string[] = [];
    const context = makeContext(cwd, {
      onFileChanged: (change) => {
        changes.push(`${change.change}:${change.path}`);
      },
    });
    const result = await writeTool.execute(context, { path: 'b.txt', content: 'hello' }, controller().signal, () => undefined);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('hello');
    expect(changes).toEqual(['created:b.txt']);
  });

  it('refuses to create a missing directory', async () => {
    const cwd = workspace();
    const result = await writeTool.execute(
      makeContext(cwd),
      { path: 'missing/b.txt', content: 'hello' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not exist');
  });
});

describe('edit', () => {
  it('replaces an exact string', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'hello world\n');
    const result = await editTool.execute(
      makeContext(cwd),
      { path: 'a.txt', oldString: 'world', newString: 'there' },
      controller().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('hello there\n');
  });

  it('reports how often the old string occurs', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'x\nx\n');
    const result = await editTool.execute(
      makeContext(cwd),
      { path: 'a.txt', oldString: 'x', newString: 'y' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('appears 2 times');
  });

  it('reports a string that does not occur', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'hello\n');
    const result = await editTool.execute(
      makeContext(cwd),
      { path: 'a.txt', oldString: 'goodbye', newString: 'x' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('was not found');
  });

  it('replaces every occurrence when asked to', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'x\nx\n');
    const result = await editTool.execute(
      makeContext(cwd),
      { path: 'a.txt', oldString: 'x', newString: 'y', replaceAll: true },
      controller().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('y\ny\n');
  });
});

describe('apply_patch', () => {
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '',
  ].join('\n');

  it('applies a unified diff', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
    const result = await applyPatchTool.execute(
      makeContext(cwd),
      { patch },
      controller().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('rolls the whole patch back when a hunk does not apply', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
    const badPatch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-TWO',
      '+TWO!',
      ' three',
      '',
    ].join('\n');
    const result = await applyPatchTool.execute(
      makeContext(cwd),
      { patch: badPatch },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('rolled back');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('reports a patch that cannot be parsed', async () => {
    const cwd = workspace();
    const result = await applyPatchTool.execute(
      makeContext(cwd),
      { patch: 'this is not a diff' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot parse the patch');
  });
});

describe('bash', () => {
  it('runs a command and returns its output', async () => {
    const cwd = workspace();
    const result = await bashTool.execute(
      makeContext(cwd),
      { command: 'echo hello' },
      controller().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('hello');
  });

  it('reports a non-zero exit code', async () => {
    const cwd = workspace();
    const result = await bashTool.execute(
      makeContext(cwd),
      { command: 'echo bad >&2; exit 3' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exited with code 3');
  });

  it('stops a command that runs past its timeout', async () => {
    const cwd = workspace();
    const result = await bashTool.execute(
      makeContext(cwd),
      { command: 'sleep 5', timeoutMs: 200 },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('timed out');
  });

  it('stops a command when the turn is aborted', async () => {
    const cwd = workspace();
    const abort = controller();
    const pending = bashTool.execute(
      makeContext(cwd),
      { command: 'sleep 5' },
      abort.signal,
      () => undefined,
    );
    setTimeout(() => abort.abort(), 50);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('aborted');
  });

  it('keeps a background task running and logs its output', async () => {
    const cwd = workspace();
    const result = await bashTool.execute(
      makeContext(cwd),
      { command: 'sleep 0.2; echo done > out.txt', background: true },
      controller().signal,
      () => undefined,
    );
    expect(result.ok).toBe(true);
    const logPath = textOf(result).match(/artifacts\/background\/(\S+)\.log/)?.[1];
    expect(logPath).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 700));
    const log = readFileSync(join(cwd, 'artifacts', 'background', `${logPath}.log`), 'utf8');
    expect(log).toContain('"pid"');
    // The task kept running after the call returned.
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8').trim()).toBe('done');
  });
});

describe('grep', () => {
  it('finds a literal match', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'alpha\nbeta\n');
    const result = await grepTool.execute(
      makeContext(cwd),
      { pattern: 'beta' },
      controller().signal,
      () => undefined,
    );
    expect(textOf(result)).toBe('a.txt:2:beta');
  });

  it('finds a regular expression match', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.txt'), 'a1\nb2\n');
    const result = await grepTool.execute(
      makeContext(cwd),
      { pattern: '[a-b][0-9]', mode: 'regex' },
      controller().signal,
      () => undefined,
    );
    expect(textOf(result)).toContain('a.txt:1:a1');
    expect(textOf(result)).toContain('a.txt:2:b2');
  });

  it('reports an invalid regular expression', async () => {
    const cwd = workspace();
    const result = await grepTool.execute(
      makeContext(cwd),
      { pattern: '([', mode: 'regex' },
      controller().signal,
      () => undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid regular expression');
  });
});

describe('glob', () => {
  it('finds files by pattern', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.ts'), '');
    writeFileSync(join(cwd, 'b.txt'), '');
    const result = await globTool.execute(
      makeContext(cwd),
      { pattern: '**/*.ts' },
      controller().signal,
      () => undefined,
    );
    expect(textOf(result)).toBe('a.ts');
  });

  it('reports no match', async () => {
    const cwd = workspace();
    const result = await globTool.execute(
      makeContext(cwd),
      { pattern: '*.rs' },
      controller().signal,
      () => undefined,
    );
    expect(textOf(result)).toBe('no match');
  });
});

describe('todo_write', () => {
  it('writes the task list and publishes it', async () => {
    const cwd = workspace();
    const context = makeContext(cwd);
    const events = (context as unknown as { __events: RuntimeEventBody[] }).__events;

    const result = await todoWriteTool.execute(
      context,
      {
        items: [
          { id: '1', content: 'write the code', status: 'in_progress' },
          { id: '2', content: 'test it', status: 'pending' },
        ],
      },
      controller().signal,
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, 'todo.json'))).toBe(true);
    expect(events.some((event) => event.type === 'todo.updated')).toBe(true);
  });
});

describe('ask_user', () => {
  it('publishes the question, waits and publishes the answer', async () => {
    const cwd = workspace();
    const context = makeContext(cwd, {
      askUser: async (request) => ({ requestId: request.requestId, answers: { choice: 'yes' } }),
    });
    const events = (context as unknown as { __events: RuntimeEventBody[] }).__events;

    const result = await askUserTool.execute(
      context,
      {
        title: 'Which one?',
        questions: [
          { id: 'q1', question: 'Pick a', type: 'single', options: [{ id: 'a', label: 'A' }] },
        ],
      },
      controller().signal,
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('choice: yes');
    expect(events.map((event) => event.type)).toEqual(['question.requested', 'question.resolved']);
  });
});

describe('truncation', () => {
  it('keeps the head and the tail and reports the dropped bytes', () => {
    const text = `HEAD${'x'.repeat(500)}TAIL`;
    const truncated = truncateText(text, { maxBytes: 100, maxLines: 2000 });
    expect(truncated.strategy).toBe('head-tail');
    expect(truncated.omittedBytes).toBeGreaterThan(0);
    expect(truncated.text).toContain('truncated');
    expect(truncated.text.startsWith('HEAD')).toBe(true);
    expect(truncated.text.endsWith('TAIL')).toBe(true);
  });

  it('leaves a short text alone', () => {
    const truncated = truncateText('short', { maxBytes: 100, maxLines: 2000 });
    expect(truncated.text).toBe('short');
    expect(truncated.omittedBytes).toBe(0);
    expect(truncated.strategy).toBe('none');
  });
});
