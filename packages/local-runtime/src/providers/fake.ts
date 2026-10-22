import type {
  ProviderCallContext,
  ProviderRequest,
  ProviderStreamChunk,
  StreamFn,
} from '@local-agent/agent-core/pi-turn-runner';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import { parseAnthropicStream } from './anthropic-messages.js';
import { parseOpenAiStream } from './openai-compatible.js';
import type { ProviderAdapter } from './types.js';

/**
 * Recorded-replay provider.
 *
 * The fixture holds the raw SSE body the provider would have sent, and it is
 * replayed through the **same parser** the real adapter uses. That keeps the
 * end-to-end test honest: it exercises the SSE parsing path, not a shortcut.
 *
 * Nothing here touches the network.
 */

export interface FakeProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export interface FakeProviderTurn {
  /** Raw SSE body text, exactly as the provider sent it. */
  readonly sse?: string;
  /** Pre-split `data:` payloads, used when the raw body is inconvenient. */
  readonly data?: readonly string[];
  /** Simulated failure instead of a stream. */
  readonly error?: FakeProviderError;
}

export interface FakeProviderOptions {
  readonly turns: readonly FakeProviderTurn[];
  /** Which parser to use for the replayed body. */
  readonly format?: 'openai-compatible' | 'anthropic-messages';
}

/**
 * Build a raw SSE body from payloads.
 *
 * A payload that already carries the `data:` prefix is left alone, so a
 * recorded frame can be pasted in verbatim.
 */
export function buildSse(...payloads: readonly string[]): string {
  return payloads
    .map((payload) => (payload.startsWith('data: ') ? payload : `data: ${payload}`))
    .map((payload) => `${payload}\n\n`)
    .join('');
}

/** Split a raw SSE body into its `data:` payloads. */
export function splitSse(body: string): string[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      return dataLines.join('\n');
    });
}

export function createFakeProvider(options: FakeProviderOptions): ProviderAdapter {
  let turnIndex = 0;

  const stream: StreamFn = (
    _request: ProviderRequest,
    _context: ProviderCallContext,
  ): AsyncIterable<ProviderStreamChunk> => {
    const turn = options.turns[turnIndex];
    turnIndex += 1;

    if (!turn) {
      throw new ProviderError('unknown', 'the fake provider has no recorded turn left');
    }

    if (turn.error) {
      throw new ProviderError(turn.error.kind, turn.error.message, {
        ...(turn.error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: turn.error.retryAfterMs }),
      });
    }

    const payloads = turn.data ?? splitSse(turn.sse ?? '');

    // The whole recorded body is parsed at once, exactly like a live stream:
    // splitting it per payload would flush tool calls too early.
    return (async function* (): AsyncGenerator<ProviderStreamChunk> {
      const lines = (async function* (): AsyncGenerator<string> {
        for (const payload of payloads) {
          yield payload;
        }
      })();
      if (options.format === 'anthropic-messages') {
        yield* parseAnthropicStream(lines);
        return;
      }
      yield* parseOpenAiStream(lines);
    })();
  };

  return { id: 'openai-compatible', stream };
}
