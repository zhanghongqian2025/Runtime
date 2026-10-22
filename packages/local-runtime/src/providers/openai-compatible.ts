import type {
  ProviderCallContext,
  ProviderRequest,
  ProviderStreamChunk,
  StreamFn,
} from '@local-agent/agent-core/pi-turn-runner';
import { ProviderError, classifyHttpFailure, classifyTransportFailure, isRetryableKind } from './errors.js';
import { toOpenAiMessages } from './messages.js';
import { readBytes, readSseData } from './sse.js';
import { applyAttemptTimeouts } from './timeout.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js';
import type { ProviderAdapter, ProviderTimeouts } from './types.js';

/**
 * OpenAI-compatible provider adapter.
 *
 * It speaks the `/chat/completions` streaming shape used by OpenAI and most
 * compatible gateways. The provider's own retry is disabled: this adapter
 * owns the retry budget so the two budgets cannot stack up
 * (docs/contracts.md §7.4).
 */

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  /** Resolved key. It lives in memory only. */
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly timeouts?: ProviderTimeouts;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

interface OpenAiToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OpenAiStreamChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string;
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly OpenAiToolCallDelta[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** Parse the SSE payloads of an OpenAI-compatible stream. */
export async function* parseOpenAiStream(
  data: AsyncIterable<string>,
): AsyncGenerator<ProviderStreamChunk> {
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  function* flushToolCalls(): Generator<ProviderStreamChunk> {
    const ordered = [...toolCalls.entries()].sort((left, right) => left[0] - right[0]);
    for (const [, call] of ordered) {
      if (call.name.length === 0) continue;
      yield {
        kind: 'tool_call',
        toolCallId: call.id,
        name: call.name,
        input: parseToolArguments(call.args),
      };
    }
    toolCalls.clear();
  }

  for await (const payload of data) {
    if (payload === '[DONE]') {
      yield* flushToolCalls();
      yield { kind: 'done' };
      return;
    }

    if (payload.trim().length === 0) continue;

    let parsed: OpenAiStreamChunk;
    try {
      parsed = JSON.parse(payload) as OpenAiStreamChunk;
    } catch (error: unknown) {
      // A malformed frame is an upstream problem, not noise to skip.
      throw new ProviderError('unknown', 'the provider sent a malformed stream frame', {
        cause: error,
      });
    }

    const choice = parsed.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content !== undefined && delta.content.length > 0) {
      yield { kind: 'text', text: delta.content };
    }
    if (delta?.reasoning_content !== undefined && delta.reasoning_content.length > 0) {
      yield { kind: 'thinking', text: delta.reasoning_content };
    }

    for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
      const index = call.index ?? position;
      const existing = toolCalls.get(index) ?? { id: '', name: '', args: '' };
      if (call.id !== undefined) existing.id = call.id;
      if (call.function?.name !== undefined) existing.name += call.function.name;
      if (call.function?.arguments !== undefined) existing.args += call.function.arguments;
      toolCalls.set(index, existing);
    }

    if (parsed.usage !== undefined) {
      yield {
        kind: 'usage',
        usage: {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
        },
      };
    }
  }

  yield* flushToolCalls();
  yield { kind: 'done' };
}

/** Tool arguments are a JSON string; an unparsable one becomes an empty object. */
export function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
}

const isVisibleChunk = (chunk: ProviderStreamChunk): boolean =>
  chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'tool_call';

export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const stream: StreamFn = (request: ProviderRequest, context: ProviderCallContext) => {
    const self = { request, context };
    return runWithRetry(self, policy, options);
  };

  async function* runWithRetry(
    { request, context }: { request: ProviderRequest; context: ProviderCallContext },
    retryPolicy: RetryPolicy,
    adapterOptions: OpenAiCompatibleOptions,
  ): AsyncGenerator<ProviderStreamChunk> {
    const startedAt = Date.now();
    let committed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;

      const attemptStream = async function* (): AsyncGenerator<ProviderStreamChunk> {
        const body = JSON.stringify({
          model: request.model,
          messages: toOpenAiMessages(request.messages),
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.schema,
                  },
                })),
              }
            : {}),
        });

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${adapterOptions.apiKey}`,
            ...(adapterOptions.extraHeaders ?? {}),
          },
          body,
          signal: request.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          throw classifyHttpFailure(
            response.status,
            text,
            response.headers.get('retry-after') ?? undefined,
          );
        }

        yield* parseOpenAiStream(readSseData(readBytes(response.body)));
      };

      try {
        const timed = applyAttemptTimeouts(attemptStream(), context, request.signal);
        for await (const chunk of timed) {
          if (isVisibleChunk(chunk)) committed = true;
          yield chunk;
        }
        return;
      } catch (error: unknown) {
        const providerError =
          error instanceof ProviderError ? error : classifyTransportFailure(error);

        // Output was already committed: the failure is surfaced as-is and the
        // call is never executed twice.
        if (committed) throw providerError;

        const canRetry =
          isRetryableKind(providerError.kind) && attempt <= retryPolicy.maxRetries;
        if (!canRetry) throw providerError;

        const elapsed = Date.now() - startedAt;
        if (elapsed >= retryPolicy.totalBudgetMs) throw providerError;

        const delay = computeRetryDelay(attempt, retryPolicy, providerError.retryAfterMs);
        if (elapsed + delay > retryPolicy.totalBudgetMs) throw providerError;

        await sleep(delay);
      }
    }
  }

  return { id: 'openai-compatible', stream };
}

/** Equal-jitter backoff, clamped by the `Retry-After` hint and the cap. */
export function computeRetryDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const jittered = Math.floor(random() * capped);
  return Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
