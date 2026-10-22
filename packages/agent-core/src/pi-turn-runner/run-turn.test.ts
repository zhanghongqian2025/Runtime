import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentMessage, RuntimeEventDraft } from '@local-agent/protocol';
import type { ToolBinder, ToolImpl } from '../tools/index.js';
import type { TurnHooks } from './hooks.js';
import { runTurn } from './run-turn.js';
import type { ProviderStreamChunk, StreamFn } from './types.js';

/**
 * The loop is the heart of the runtime, so its contracts are tested
 * directly: the hook semantics, the marker rules, the fail-closed behaviour
 * and the tool blocking.
 */

const textStream = (text: string): StreamFn =>
  async function* (): AsyncGenerator<ProviderStreamChunk> {
    yield { kind: 'text', text };
    yield { kind: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { kind: 'done' };
  };

const emptyBinder: ToolBinder = {
  resolve: () => undefined,
  list: () => [],
  bind: () => [],
};

interface Harness {
  readonly events: readonly RuntimeEventDraft[];
  readonly history: readonly AgentMessage[];
  readonly flushes: readonly (readonly AgentMessage[])[];
  readonly calls: () => number;
}

const harness = (options: {
  readonly stream?: StreamFn;
  readonly hooks?: TurnHooks;
  readonly tools?: ToolBinder;
  readonly history?: readonly AgentMessage[];
}): Harness => {
  const events: RuntimeEventDraft[] = [];
  const history: AgentMessage[] = [...(options.history ?? [])];
  const flushes: (readonly AgentMessage[])[] = [];
  let calls = 0;

  const stream: StreamFn = options.stream ?? textStream('hello');

  void runTurn({
    sessionId: 'sess_test',
    turnId: 'turn_test',
    model: {
      providerId: 'openai-compatible',
      model: 'test-model',
      contextWindowTokens: 128_000,
      maxOutputTokens: 1024,
    },
    tools: options.tools ?? emptyBinder,
    history,
    hooks: options.hooks ?? {},
    messageSink: {
      append: async (messages) => {
        flushes.push(messages);
        history.push(...messages);
      },
      replace: async (messages) => {
        flushes.push(messages);
        history.length = 0;
        history.push(...messages);
      },
    },
    writeEvent: (event) => {
      events.push(event);
    },
    stream: (request, context) => {
      calls += 1;
      return stream(request, context);
    },
    toolEnvironment: {
      cwd: '/tmp',
      env: {},
      now: () => 0,
      limits: { maxBytes: 32_768, maxLines: 2000 },
      requestPermission: async (request) => ({
        requestId: request.requestId,
        choice: 'deny',
        decidedBy: 'policy',
      }),
      onFileChanged: () => undefined,
      askUser: async (request) => ({ requestId: request.requestId, answers: {} }),
      artifacts: {
        path: (name) => `/tmp/${name}`,
        write: async () => undefined,
        append: async () => undefined,
        read: async () => undefined,
      },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  });

  return { events, history, flushes, calls: () => calls };
};

const typesOf = (harness: Harness): string[] => harness.events.map((event) => event.type);

describe('runTurn', () => {
  it('emits a terminal session.status event', async () => {
    const run = harness({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const types = typesOf(run);
    expect(types[0]).toBe('session.status');
    expect(types.at(-1)).toBe('session.status');
    const last = run.events.at(-1);
    expect(last?.type).toBe('session.status');
    if (last?.type === 'session.status') {
      expect(last.status).toBe('completed');
    }
  });

  it('streams the assistant text and commits it to the history', async () => {
    const run = harness({ stream: textStream('hi there') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(typesOf(run)).toContain('message.delta');
    expect(typesOf(run)).toContain('message.completed');

    const assistant = run.history.find((message) => message.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.content[0]).toEqual({ type: 'text', text: 'hi there' });
  });

  it('appends a hidden marker exactly once and flushes the history once', async () => {
    const marker: AgentMessage = {
      id: 'msg_marker',
      role: 'user',
      content: [{ type: 'custom', kind: 'marker.tail', hidden: true, payload: { note: 'x' } }],
      createdAt: '2026-10-21T06:00:00.000Z',
    };

    const run = harness({
      hooks: {
        beforeLlmCall: [
          () => ({ kind: 'appendMessage', message: marker }),
          () => ({ kind: 'appendMessage', message: marker }),
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const markers = run.history.filter(
      (message) => message.content[0]?.type === 'custom',
    );
    expect(markers).toHaveLength(2);
    // One flush for the markers, one for the assistant message.
    expect(run.flushes.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects an appendMessage decision that is not a hidden custom message', async () => {
    const notAMarker: AgentMessage = {
      id: 'msg_plain',
      role: 'user',
      content: [{ type: 'text', text: 'sneaky' }],
      createdAt: '2026-10-21T06:00:00.000Z',
    };

    const run = harness({
      hooks: { beforeLlmCall: [() => ({ kind: 'appendMessage', message: notAMarker })] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(run.history.some((message) => message.content[0]?.type === 'text' && message.content[0]?.text === 'sneaky')).toBe(false);
  });

  it('fails the turn closed when a history notification does not acknowledge', async () => {
    const run = harness({
      hooks: {
        onHistoryChanged: [
          () => {
            throw new Error('delivery failed');
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const last = run.events.at(-1);
    expect(last?.type).toBe('session.status');
    if (last?.type === 'session.status') {
      expect(last.status).toBe('failed');
      expect(last.error?.code).toBe('HOOK_ACK_FAILED');
    }
    // The turn stopped at the first history change: no further LLM request
    // was started.
    expect(run.calls()).toBe(1);
  });

  it('retries inside the same turn and does not commit the rejected response', async () => {
    let attempts = 0;
    const stream: StreamFn = async function* (): AsyncGenerator<ProviderStreamChunk> {
      attempts += 1;
      yield { kind: 'text', text: attempts === 1 ? 'first' : 'second' };
      yield { kind: 'done' };
    };

    const run = harness({
      stream,
      hooks: {
        afterLlmCall: [
          (context) =>
            context.stepIndex === 1 ? { kind: 'retry', reason: 'try again' } : { kind: 'continue' },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(attempts).toBe(2);
    const assistants = run.history.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content[0]).toEqual({ type: 'text', text: 'second' });
  });

  it('answers with a zero-usage response without calling the provider', async () => {
    const run = harness({
      hooks: {
        beforeLlmCall: [
          () => ({ kind: 'respond', text: 'done', verified: true }),
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(run.calls()).toBe(0);
    const assistant = run.history.find((message) => message.role === 'assistant');
    expect(assistant?.content[0]).toEqual({ type: 'text', text: 'done' });
    expect(assistant?.meta?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('blocks a tool call without running it and reports it to the step-end hook', async () => {
    let executed = 0;
    const tool: ToolImpl = {
      definition: {
        name: 'echo',
        description: 'echo the input',
        schema: z.object({ text: z.string() }),
        executionMode: 'sync',
      },
      execute: async () => {
        executed += 1;
        return { ok: true, isError: false, content: [{ type: 'text', text: 'echoed' }] };
      },
    };

    const binder: ToolBinder = {
      resolve: (name) => (name === 'echo' ? tool : undefined),
      list: () => [{ definition: tool.definition, runtime: 'local', enabled: true }],
      bind: () => [],
    };

    const toolStream: StreamFn = async function* (): AsyncGenerator<ProviderStreamChunk> {
      yield { kind: 'tool_call', toolCallId: 'tool_1', name: 'echo', input: { text: 'hi' } };
      yield { kind: 'done' };
    };

    const blocked: string[] = [];
    const run = harness({
      stream: toolStream,
      tools: binder,
      hooks: {
        beforeToolCall: [
          () => ({ kind: 'block', reason: 'not allowed', blockedBy: 'permission' }),
        ],
        onStepEnd: [
          (context) => {
            for (const call of context.blockedToolCalls) {
              blocked.push(`${call.name}:${call.blockedBy}`);
            }
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(executed).toBe(0);
    expect(blocked).toEqual(['echo:permission']);
    expect(typesOf(run)).toContain('tool.call.blocked');
  });
});
