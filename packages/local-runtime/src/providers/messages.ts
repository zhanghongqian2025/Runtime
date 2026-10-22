import type { AgentMessage } from '@local-agent/protocol';

/**
 * Projection of the canonical history into the OpenAI-compatible wire shape.
 *
 * The input is the *provider-bound* view: the projection step has already
 * removed orphan tool results and unsupported blocks, so this function only
 * maps what is left.
 */

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAiContentPart {
  readonly type: 'text' | 'image_url';
  readonly text?: string;
  readonly image_url?: { readonly url: string };
}

export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly OpenAiContentPart[] | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
  readonly tool_call_id?: string;
}

/** Concatenate the text blocks of a message. */
export function textOf(message: AgentMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function toOpenAiMessages(messages: readonly AgentMessage[]): OpenAiMessage[] {
  const output: OpenAiMessage[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        const content = block.content
          .map((entry) => (entry.type === 'text' ? entry.text : '[image]'))
          .join('');
        output.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: block.isError ? `ERROR: ${content}` : content,
        });
      }
      continue;
    }

    const parts: OpenAiContentPart[] = [];
    const toolCalls: OpenAiToolCall[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text });
          break;
        case 'image':
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.toolCallId,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        default:
          // thinking and custom blocks are handled by the projection step.
          break;
      }
    }

    if (message.role === 'assistant') {
      output.push({
        role: 'assistant',
        content: parts.length > 0 ? parts : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    output.push({ role: message.role, content: parts });
  }

  return output;
}

/* ------------------------------------------------------------------ *
 * Anthropic Messages
 * ------------------------------------------------------------------ */

export interface AnthropicContentPart {
  readonly type: 'text' | 'image' | 'tool_use' | 'tool_result';
  readonly text?: string;
  readonly source?: { readonly type: 'base64'; readonly media_type: string; readonly data: string };
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: string;
  readonly is_error?: boolean;
}

export interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly AnthropicContentPart[];
}

export interface AnthropicPayload {
  readonly system: string | undefined;
  readonly messages: readonly AnthropicMessage[];
}

/**
 * Projection of the canonical history into the Anthropic Messages shape.
 *
 * Anthropic carries the system prompt in a dedicated field and expects tool
 * results inside a user message, so both need reshaping.
 */
export function toAnthropicPayload(messages: readonly AgentMessage[]): AnthropicPayload {
  const systemParts: string[] = [];
  const output: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(textOf(message));
      continue;
    }

    if (message.role === 'tool') {
      const parts: AnthropicContentPart[] = [];
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        parts.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content
            .map((entry) => (entry.type === 'text' ? entry.text : '[image]'))
            .join(''),
          ...(block.isError ? { is_error: true } : {}),
        });
      }
      if (parts.length > 0) output.push({ role: 'user', content: parts });
      continue;
    }

    const parts: AnthropicContentPart[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text });
          break;
        case 'image':
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: block.mediaType, data: block.data },
          });
          break;
        case 'tool_use':
          parts.push({
            type: 'tool_use',
            id: block.toolCallId,
            name: block.name,
            input: block.input ?? {},
          });
          break;
        default:
          break;
      }
    }

    if (parts.length > 0) {
      output.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: parts });
    }
  }

  const system = systemParts.join('\n\n');
  return { system: system.length > 0 ? system : undefined, messages: output };
}
