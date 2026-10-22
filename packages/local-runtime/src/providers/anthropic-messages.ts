import type {
  ProviderCallContext,
  ProviderRequest,
  ProviderStreamChunk,
  StreamFn,
} from '@local-agent/agent-core/pi-turn-runner';
import { ProviderError, classifyHttpFailure, classifyTransportFailure, isRetryableKind } from './errors.js';
import { toAnthropicPayload } from './messages.js';
import { readBytes, readSseData } from './sse.js';
import { applyAttemptTimeouts } from './timeout.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js';
import { computeRetryDelay } from './openai-compatible.js';
import type { ProviderAdapter, ProviderTimeouts } from './types.js';

/**
 * Anthropic Messages provider adapter.
 *
 * Same retry and timeout contract as the OpenAI-compatible adapter; only the
 * wire shape differs.
 */

export interface AnthropicMessagesOptions {
  readonly baseUrl: string;
  /** Resolved key. It lives in memory only. */
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly anthropicVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly timeouts?: ProviderTimeouts;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

interface AnthropicStreamEvent {
  readonly type?: string;
  readonly index?: number;
  readonly content_block?: {
    readonly type?: string;
    readonly text?: string;
    readonly id?: string;
    readonly name?: string;
    readonly input?: unknown;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly partial_json?: string;
  };
  readonly message?: { readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number } };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/** Parse the SSE payloads of an Anthropic Messages stream. */
export async function* parseAnthropicStream(
  data: AsyncIterable<string>,
): AsyncGenerator<ProviderStreamChunk> {
  const toolCalls = new Map<number, { id: string; name: string; json: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  // A completion without any content is an anomaly, not an empty answer. Some
  // providers answer a malformed request with an empty stream instead of an
  // error, and a silent no-op is worse than a loud failure.
  let produced = false;

  const assertProduced = (): void => {
    if (produced) return;
    throw new ProviderError(
      'empty-response',
      'the provider returned a completion without any content',
    );
  };

  for await (const payload of data) {
    let parsed: AnthropicStreamEvent;
    try {
      parsed = JSON.parse(payload) as AnthropicStreamEvent;
    } catch {
      continue;
    }

    switch (parsed.type) {
      case 'message_start': {
        const usage = parsed.message?.usage;
        inputTokens = usage?.input_tokens ?? 0;
        outputTokens = usage?.output_tokens ?? 0;
        break;
      }

      case 'content_block_start': {
        const block = parsed.content_block;
        if (block?.type === 'tool_use' && parsed.index !== undefined) {
          toolCalls.set(parsed.index, {
            id: block.id ?? '',
            name: block.name ?? '',
            json: '',
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = parsed.delta;
        if (delta?.type === 'text_delta' && delta.text !== undefined) {
          produced = true;
          yield { kind: 'text', text: delta.text };
        }
        if (delta?.type === 'thinking_delta' && delta.thinking !== undefined) {
          produced = true;
          yield { kind: 'thinking', text: delta.thinking };
        }
        if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const index = parsed.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: '', name: '', json: '' };
          existing.json += delta.partial_json;
          toolCalls.set(index, existing);
        }
        break;
      }

      case 'content_block_stop': {
        const index = parsed.index ?? 0;
        const existing = toolCalls.get(index);
        if (existing) {
          produced = true;
          yield {
            kind: 'tool_call',
            toolCallId: existing.id,
            name: existing.name,
            input: parseJsonOrEmpty(existing.json),
          };
          toolCalls.delete(index);
        }
        break;
      }

      case 'message_delta': {
        if (parsed.usage?.output_tokens !== undefined) {
          outputTokens = parsed.usage.output_tokens;
        }
        break;
      }

      case 'message_stop': {
        for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          if (call.name.length === 0) continue;
          produced = true;
          yield {
            kind: 'tool_call',
            toolCallId: call.id,
            name: call.name,
            input: parseJsonOrEmpty(call.json),
          };
        }
        toolCalls.clear();
        assertProduced();
        yield {
          kind: 'usage',
          usage: { inputTokens, outputTokens },
        };
        yield { kind: 'done' };
        return;
      }

      default:
        break;
    }
  }

  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (call.name.length === 0) continue;
    produced = true;
    yield {
      kind: 'tool_call',
      toolCallId: call.id,
      name: call.name,
      input: parseJsonOrEmpty(call.json),
    };
  }
  toolCalls.clear();
  assertProduced();
  yield { kind: 'usage', usage: { inputTokens, outputTokens } };
  yield { kind: 'done' };
}

function parseJsonOrEmpty(raw: string): unknown {
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

export function createAnthropicMessagesAdapter(options: AnthropicMessagesOptions): ProviderAdapter {
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/v1/messages`;

  const stream: StreamFn = (request: ProviderRequest, context: ProviderCallContext) => {
    return runWithRetry(request, context, policy, options);
  };

  async function* runWithRetry(
    request: ProviderRequest,
    context: ProviderCallContext,
    retryPolicy: RetryPolicy,
    adapterOptions: AnthropicMessagesOptions,
  ): AsyncGenerator<ProviderStreamChunk> {
    const startedAt = Date.now();
    let committed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;

      const attemptStream = async function* (): AsyncGenerator<ProviderStreamChunk> {
        const payload = toAnthropicPayload(request.messages);
        const thinking =
          request.thinking?.enabled === true
            ? {
                type: 'enabled',
                budget_tokens: Math.max(
                  1024,
                  Math.min(
                    request.thinking.budgetTokens ?? 4096,
                    Math.max(1024, request.maxOutputTokens - 1024),
                  ),
                ),
              }
            : undefined;

        const body = JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          messages: payload.messages,
          ...(payload.system !== undefined ? { system: payload.system } : {}),
          ...(thinking === undefined ? {} : { thinking }),
          stream: true,
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.schema,
                })),
              }
            : {}),
        });

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            // MiniMax accepts either convention; sending both is harmless and
            // covers gateways that only look at one of them.
            'x-api-key': adapterOptions.apiKey,
            authorization: `Bearer ${adapterOptions.apiKey}`,
            'anthropic-version': adapterOptions.anthropicVersion ?? '2023-06-01',
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

        yield* parseAnthropicStream(readSseData(readBytes(response.body)));
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

  return { id: 'anthropic-messages', stream };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
