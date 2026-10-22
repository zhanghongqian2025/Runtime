import { describe, expect, it } from 'vitest';
import { parseAnthropicStream } from './anthropic-messages.js';
import { parseOpenAiStream } from './openai-compatible.js';
import { ProviderError } from './errors.js';

async function* lines(values: readonly string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

const collect = async (stream: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('provider streams', () => {
  it('reads text out of an Anthropic stream', async () => {
    const chunks = await collect(
      parseAnthropicStream(
        lines([
          JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } }),
          JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
          JSON.stringify({ type: 'message_stop' }),
        ]),
      ),
    );

    expect(chunks).toContainEqual({ kind: 'text', text: 'hi' });
    expect(chunks).toContainEqual({ kind: 'usage', usage: { inputTokens: 7, outputTokens: 0 } });
  });

  it('reads a tool call out of an Anthropic stream', async () => {
    // A response that only calls a tool carries no text. It is a valid
    // completion and must not be mistaken for an empty one.
    const chunks = await collect(
      parseAnthropicStream(
        lines([
          JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
          JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
          }),
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
          }),
          JSON.stringify({ type: 'content_block_stop', index: 0 }),
          JSON.stringify({ type: 'message_stop' }),
        ]),
      ),
    );

    expect(chunks).toContainEqual({
      kind: 'tool_call',
      toolCallId: 'call_1',
      name: 'read',
      input: { path: 'README.md' },
    });
  });

  it('fails an Anthropic completion that carries no content', async () => {
    // Some providers answer a malformed request with an empty stream instead
    // of an error. That has to surface as a failure, not as a silent no-op.
    await expect(
      collect(
        parseAnthropicStream(
          lines([
            JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
            JSON.stringify({ type: 'message_stop' }),
          ]),
        ),
      ),
    ).rejects.toThrow(ProviderError);

    const error = await collect(
      parseAnthropicStream(
        lines([
          JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
          JSON.stringify({ type: 'message_stop' }),
        ]),
      ),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('empty-response');
  });

  it('reads text out of an OpenAI-compatible stream', async () => {
    const chunks = await collect(
      parseOpenAiStream(
        lines([
          JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
          '[DONE]',
        ]),
      ),
    );

    expect(chunks).toContainEqual({ kind: 'text', text: 'hi' });
  });

  it('fails an OpenAI-compatible completion that carries no content', async () => {
    const error = await collect(parseOpenAiStream(lines(['[DONE]']))).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('empty-response');
  });
});
