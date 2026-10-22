import type { AgentMessage, ContentBlock, ToolContentBlock } from '@local-agent/protocol';

/**
 * Context compaction.
 *
 * The parts that must be deterministic live here: the token estimate, the
 * budget arithmetic and the trimming. The runtime adds the summary step and
 * the checkpoint.
 *
 * See docs/contracts.md §8 and docs/decisions.md D-022.
 */

/** Fallback token estimate: four UTF-8 bytes per token. */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/** The text of a content block, used for the estimate. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.text;
    case 'image':
      return block.mediaType;
    case 'tool_use':
      return `${block.name}${JSON.stringify(block.input ?? {})}`;
    case 'tool_result':
      return block.content
        .map((entry: ToolContentBlock) => (entry.type === 'text' ? entry.text : '[image]'))
        .join('');
    case 'custom':
      return JSON.stringify(block.payload ?? '');
    default:
      return '';
  }
}

/** The estimated size of a message list. */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      total += estimateTokens(blockText(block));
    }
    // The role and the framing cost a little.
    total += 4;
  }
  return total;
}

export interface ContextBudget {
  /** How much of the window the answer may take. */
  readonly outputBudget: number;
  /** The token count at which a compaction becomes necessary. */
  readonly compactWatermark: number;
}

/**
 * Compute the budget from the model window.
 *
 * The watermark reserves the **whole** output budget: compressing at the
 * model's output limit would be far too late.
 */
export function computeContextBudget(
  model: { readonly contextWindowTokens: number; readonly maxOutputTokens: number },
  reserveTokens = 2048,
): ContextBudget {
  const outputBudget = Math.min(model.maxOutputTokens, Math.floor(model.contextWindowTokens * 0.25));
  const compactWatermark = Math.max(
    1024,
    model.contextWindowTokens - outputBudget - reserveTokens,
  );
  return { outputBudget, compactWatermark };
}

/** True when the history has grown past the watermark. */
export function shouldCompact(
  messages: readonly AgentMessage[],
  budget: ContextBudget,
): boolean {
  return estimateMessagesTokens(messages) > budget.compactWatermark;
}

export interface TrimOptions {
  /** Messages kept untouched at the head (system prompt, first request). */
  readonly keepHeadMessages: number;
  /** Messages kept untouched at the tail (the recent exchange). */
  readonly keepTailMessages: number;
  /** Bytes kept from the head of a tool result. */
  readonly keepToolHeadBytes: number;
  /** Bytes kept from the tail of a tool result. */
  readonly keepToolTailBytes: number;
  /** The token count the trimming aims for. */
  readonly targetTokens: number;
}

export const DEFAULT_TRIM_OPTIONS: TrimOptions = {
  keepHeadMessages: 2,
  keepTailMessages: 6,
  keepToolHeadBytes: 1024,
  keepToolTailBytes: 512,
  targetTokens: 0,
};

export interface TrimResult {
  readonly messages: AgentMessage[];
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** The share of the context that was saved, between 0 and 1. */
  readonly savedRatio: number;
  /** True when the trimming reached the target. */
  readonly reachedTarget: boolean;
}

/** Keep the head and the tail of a tool result and mark the gap. */
export function trimToolContent(
  content: readonly ToolContentBlock[],
  options: TrimOptions,
): { readonly content: ToolContentBlock[]; readonly changed: boolean } {
  const text = content
    .map((entry) => (entry.type === 'text' ? entry.text : '[image]'))
    .join('');
  const bytes = Buffer.byteLength(text, 'utf8');
  const budget = options.keepToolHeadBytes + options.keepToolTailBytes;

  if (bytes <= budget) return { content: [...content], changed: false };

  const buffer = Buffer.from(text, 'utf8');
  const head = buffer.subarray(0, options.keepToolHeadBytes).toString('utf8');
  const tail = buffer.subarray(buffer.length - options.keepToolTailBytes).toString('utf8');
  const omitted = bytes - options.keepToolHeadBytes - options.keepToolTailBytes;

  return {
    content: [
      { type: 'text', text: `${head}\n…[compacted ${omitted} bytes]…\n${tail}` },
    ],
    changed: true,
  };
}

/**
 * Trim the history.
 *
 * The order of the work: trim the tool results of the middle region first
 * (the cheapest saving, and the least information lost), and only drop whole
 * rounds when that is not enough. The head and the tail are never touched,
 * and the parallel tool results of a round are always kept together so a
 * sub-task never loses its partner.
 */
export function trimHistory(
  messages: readonly AgentMessage[],
  options: TrimOptions = DEFAULT_TRIM_OPTIONS,
): TrimResult {
  const beforeTokens = estimateMessagesTokens(messages);
  if (messages.length === 0) {
    return { messages: [], beforeTokens: 0, afterTokens: 0, savedRatio: 0, reachedTarget: true };
  }

  // 1. Trim the tool results everywhere. The head and the tail keep their
  //    *messages*, but a huge tool result is trimmed there too: the raw
  //    output is the low-value part, the exchange around it is not.
  const trimmedAll = messages.map((message): AgentMessage => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        content.push(block);
        continue;
      }
      const result = trimToolContent(block.content, options);
      if (result.changed) changed = true;
      content.push({
        type: 'tool_result',
        toolCallId: block.toolCallId,
        content: result.content,
        isError: block.isError,
      });
    }
    return changed ? { ...message, content } : message;
  });

  const keepHead = Math.min(options.keepHeadMessages, trimmedAll.length);
  const keepTail = Math.min(
    options.keepTailMessages,
    Math.max(0, trimmedAll.length - keepHead),
  );

  const head = trimmedAll.slice(0, keepHead);
  const tail = keepTail > 0 ? trimmedAll.slice(trimmedAll.length - keepTail) : [];
  const trimmedMiddle = trimmedAll.slice(
    keepHead,
    keepTail > 0 ? trimmedAll.length - keepTail : trimmedAll.length,
  );

  const kept = [...head, ...trimmedMiddle, ...tail];
  const afterTrimTokens = estimateMessagesTokens(kept);

  if (options.targetTokens <= 0 || afterTrimTokens <= options.targetTokens) {
    return {
      messages: kept,
      beforeTokens,
      afterTokens: afterTrimTokens,
      savedRatio: ratio(beforeTokens, afterTrimTokens),
      reachedTarget: options.targetTokens <= 0 || afterTrimTokens <= options.targetTokens,
    };
  }

  // 2. Drop the oldest rounds of the middle region until the target is met.
  //    A round is an assistant message plus the tool results that answer it,
  //    so the parallel results of a round disappear together.
  const dropped: AgentMessage[] = [];
  const remaining = [...trimmedMiddle];
  let current = [...head, ...remaining, ...tail];

  while (estimateMessagesTokens(current) > options.targetTokens && remaining.length > 0) {
    const roundSize = roundLength(remaining);
    if (roundSize <= 0) break;
    const removed = remaining.splice(0, roundSize);
    dropped.push(...removed);
    current = [...head, ...remaining, ...tail];
  }

  const afterTokens = estimateMessagesTokens(current);
  return {
    messages: current,
    beforeTokens,
    afterTokens,
    savedRatio: ratio(beforeTokens, afterTokens),
    reachedTarget: afterTokens <= options.targetTokens,
  };
}

/** The number of messages of the first complete round. */
function roundLength(messages: readonly AgentMessage[]): number {
  const first = messages[0];
  if (!first) return 0;
  if (first.role !== 'assistant') return 1;
  const toolCallIds = new Set(
    first.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => block.toolCallId),
  );
  if (toolCallIds.size === 0) return 1;

  let length = 1;
  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) break;
    if (message.role !== 'tool') break;
    length += 1;
  }
  return length;
}

function ratio(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.max(0, Math.min(1, (before - after) / before));
}

/** The instruction used when the compaction asks the model for a summary. */
export function buildCompactionPrompt(content: string): string {
  return [
    'Summarize the following conversation excerpt.',
    'Keep: the user goals, the decisions that were made, the files that were changed,',
    'the open questions and the concrete next steps.',
    'Drop: raw command output, repeated content and anything already superseded.',
    'Answer with the summary only.',
    '',
    '--- excerpt ---',
    content,
    '--- end ---',
  ].join('\n');
}
