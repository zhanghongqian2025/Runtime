import type { AgentMessage, ContentBlock } from '@local-agent/protocol';

/**
 * Provider-bound projection.
 *
 * The canonical history is never rewritten by a projection: the function
 * returns a temporary copy that is only used to build the provider request.
 *
 * See docs/contracts.md §8.1.
 */

export interface ProjectionOptions {
  readonly providerId: string;
  /** False strips thinking blocks from the request view. */
  readonly supportsThinking: boolean;
  /** False replaces image blocks with a text placeholder. */
  readonly supportsImages: boolean;
}

export const IMAGE_PLACEHOLDER = '[image omitted: this model does not accept image input]';

export function projectAgentMessagesForModel(
  messages: readonly AgentMessage[],
  options: ProjectionOptions,
): AgentMessage[] {
  // A tool result is only meaningful next to the tool call that produced it.
  const toolUseIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.toolCallId);
    }
  }

  const projected: AgentMessage[] = [];

  for (const message of messages) {
    const content: ContentBlock[] = [];

    for (const block of message.content) {
      if (block.type === 'tool_result' && !toolUseIds.has(block.toolCallId)) {
        continue;
      }
      if (block.type === 'thinking' && !options.supportsThinking) {
        continue;
      }
      if (block.type === 'image' && !options.supportsImages) {
        content.push({ type: 'text', text: IMAGE_PLACEHOLDER });
        continue;
      }
      content.push(block);
    }

    if (content.length === 0 && message.content.length > 0) {
      continue;
    }

    projected.push({ ...message, content });
  }

  return projected;
}
