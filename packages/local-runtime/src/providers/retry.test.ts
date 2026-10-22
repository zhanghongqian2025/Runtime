import { describe, expect, it } from 'vitest';
import {
  classifyHttpFailure,
  classifyTransportFailure,
  isRetryableKind,
  parseRetryAfter,
} from './errors.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible.js';
import type { ProviderCallContext, ProviderRequest } from '@local-agent/agent-core/pi-turn-runner';

const FAST_RETRY = {
  maxRetries: 5,
  baseDelayMs: 0,
  maxDelayMs: 0,
  totalBudgetMs: 60_000,
};

const request: ProviderRequest = {
  model: 'test-model',
  messages: [],
  tools: [],
  maxOutputTokens: 256,
  signal: new AbortController().signal,
};

const context: ProviderCallContext = {
  attempt: 1,
  logicalCallId: 'test',
  firstEventTimeoutMs: 300_000,
  idleTimeoutMs: 3_600_000,
  totalTimeoutMs: 1_200_000,
};

const consume = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const chunk of stream) {
    void chunk;
  }
};

describe('error classification', () => {
  it('retries only the documented kinds', () => {
    expect(isRetryableKind('connection-timeout')).toBe(true);
    expect(isRetryableKind('network')).toBe(true);
    expect(isRetryableKind('rate-limit')).toBe(true);
    expect(isRetryableKind('overloaded')).toBe(true);

    expect(isRetryableKind('quota-exhausted')).toBe(false);
    expect(isRetryableKind('auth')).toBe(false);
    expect(isRetryableKind('aborted')).toBe(false);
    expect(isRetryableKind('bad-request')).toBe(false);
    expect(isRetryableKind('content-filter')).toBe(false);
    expect(isRetryableKind('server-error')).toBe(false);
    expect(isRetryableKind('unknown')).toBe(false);
  });

  it('maps HTTP statuses onto the right kinds', () => {
    expect(classifyHttpFailure(401, '').kind).toBe('auth');
    expect(classifyHttpFailure(403, '').kind).toBe('auth');
    expect(classifyHttpFailure(429, 'rate limit exceeded').kind).toBe('rate-limit');
    expect(classifyHttpFailure(429, 'insufficient_quota').kind).toBe('quota-exhausted');
    expect(classifyHttpFailure(529, 'overloaded').kind).toBe('overloaded');
    expect(classifyHttpFailure(400, '').kind).toBe('bad-request');
    expect(classifyHttpFailure(500, '').kind).toBe('server-error');
    expect(classifyHttpFailure(503, '').kind).toBe('server-error');
  });

  it('parses Retry-After in seconds and as a date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    const now = Date.parse('2026-10-21T00:00:00.000Z');
    expect(parseRetryAfter('Wed, 21 Oct 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('nonsense')).toBeUndefined();
  });
});

describe('transport failures', () => {
  it('sees through the cause that fetch wraps the socket error in', () => {
    // `fetch` reports a refused connection as a TypeError whose cause holds
    // the real error code.
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    const wrapped = new TypeError('fetch failed', { cause });

    const decision = classifyTransportFailure(wrapped);
    expect(decision.kind).toBe('network');
    expect(isRetryableKind(decision.kind)).toBe(true);
  });

  it('recognises an aborted request through the cause', () => {
    const cause = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const wrapped = new TypeError('fetch failed', { cause });

    expect(classifyTransportFailure(wrapped).kind).toBe('aborted');
    expect(isRetryableKind('aborted')).toBe(false);
  });

  it('recognises a timeout through the cause', () => {
    const cause = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const wrapped = new TypeError('fetch failed', { cause });

    expect(classifyTransportFailure(wrapped).kind).toBe('connection-timeout');
  });
});

describe('retry contract', () => {
  const adapterWith = (fetchImpl: typeof fetch) =>
    createOpenAiCompatibleAdapter({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl,
      retryPolicy: FAST_RETRY,
    });

  it('retries a 429 and gives up after five retries', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('rate limit exceeded', { status: 429 });
    }) as unknown as typeof fetch;

    const adapter = adapterWith(fetchImpl);
    await expect(consume(adapter.stream(request, context))).rejects.toThrow();
    // One initial attempt plus at most five retries.
    expect(calls).toBe(6);
  });

  it('does not retry a 500', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    const adapter = adapterWith(fetchImpl);
    await expect(consume(adapter.stream(request, context))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not retry a 401', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const adapter = adapterWith(fetchImpl);
    await expect(consume(adapter.stream(request, context))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('retries a timeout', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const error = new Error('the provider request timed out');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;

    const adapter = adapterWith(fetchImpl);
    await expect(consume(adapter.stream(request, context))).rejects.toThrow();
    expect(calls).toBe(6);
  });

  it('stops retrying once visible output was committed', async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const fetchImpl = (async () => {
      calls += 1;
      let pulls = 0;
      // The stream breaks *after* the first visible chunk was delivered.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
              ),
            );
            return;
          }
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const adapter = adapterWith(fetchImpl);
    const chunks: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of adapter.stream(request, context)) chunks.push(chunk);
      })(),
    ).rejects.toThrow();
    expect(chunks.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });
});
