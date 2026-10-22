import type { AgentMessage } from '@local-agent/protocol';
import { newId } from '@local-agent/protocol';
import {
  buildCompactionPrompt,
  computeContextBudget,
  estimateMessagesTokens,
  estimateTokens,
  trimHistory,
  type ContextBudget,
  type TrimOptions,
} from '@local-agent/agent-core/pi-turn-runner';
import type { Logger } from '../logging/logger.js';
import type { Journal } from './journal.js';
import type { SessionStore } from './types.js';

/**
 * Context compaction.
 *
 * The order matters: a checkpoint first, then the trimming, then the summary,
 * and only then the durable replace. A compaction that does not save enough
 * is **not** applied: the history stays as it was and the caller reports the
 * real ratio.
 *
 * See docs/contracts.md §8.
 */

/** A compaction has to save at least this share of the context to count. */
export const MIN_SAVED_RATIO = 0.7;

export interface CompactionModel {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export interface CompactionDependencies {
  readonly sessions: SessionStore;
  readonly logger: Logger;
  readonly model: CompactionModel;
  /** Asks the model for a summary. The auxiliary call never touches the history. */
  readonly summarize?: (content: string) => Promise<string | undefined>;
  readonly journal?: Journal;
  readonly trimOptions?: Partial<TrimOptions>;
}

export interface CompactionOutcome {
  /** True when the history was actually replaced. */
  readonly compacted: boolean;
  readonly checkpointId?: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** The share of the context that was saved, between 0 and 1. */
  readonly savedRatio: number;
  readonly messages?: readonly AgentMessage[];
  readonly reason?: string;
}

const DEFAULT_TRIM: TrimOptions = {
  keepHeadMessages: 2,
  keepTailMessages: 6,
  keepToolHeadBytes: 1024,
  keepToolTailBytes: 512,
  targetTokens: 0,
};

export function computeBudget(model: CompactionModel): ContextBudget {
  return computeContextBudget(model);
}

/**
 * Compact the history of a session when it grew past the watermark.
 */
export async function compactSession(
  sessionId: string,
  deps: CompactionDependencies,
): Promise<CompactionOutcome> {
  const history = deps.sessions.readHistory(sessionId);
  const budget = computeBudget(deps.model);
  const beforeTokens = estimateMessagesTokens(history);

  if (beforeTokens <= budget.compactWatermark) {
    return { compacted: false, beforeTokens, afterTokens: beforeTokens, savedRatio: 0 };
  }

  const checkpointId = `ckpt_${Date.now().toString(36)}`;
  deps.sessions.writeCheckpoint(sessionId, checkpointId, history);

  const transactionId = newId('request');
  deps.journal?.append({
    txId: transactionId,
    kind: 'compaction',
    state: 'begin',
    ts: new Date().toISOString(),
    before: { checkpointId },
  });

  const trimOptions: TrimOptions = { ...DEFAULT_TRIM, ...deps.trimOptions };
  let trimmed = trimHistory(history, {
    ...trimOptions,
    targetTokens: budget.compactWatermark,
  });

  // The summary replaces the part that was dropped, so the model keeps the
  // thread of the conversation.
  let summaryMessage: AgentMessage | undefined;
  if (deps.summarize !== undefined) {
    const dropped = droppedContent(history, trimmed.messages);
    if (dropped.length > 0) {
      const summary = await deps.summarize(dropped);
      if (summary !== undefined && summary.trim().length > 0) {
        summaryMessage = {
          id: newId('message'),
          role: 'assistant',
          content: [{ type: 'text', text: summary }],
          createdAt: new Date().toISOString(),
          meta: { providerId: deps.model.contextWindowTokens > 0 ? 'compaction' : undefined },
        };
      }
    }
  }

  const messages = summaryMessage
    ? [summaryMessage, ...trimmed.messages]
    : trimmed.messages;
  const afterTokens = estimateMessagesTokens(messages);
  const savedRatio = beforeTokens > 0 ? (beforeTokens - afterTokens) / beforeTokens : 0;

  if (savedRatio < MIN_SAVED_RATIO) {
    // Not enough was saved: try a more aggressive trim before giving up.
    const aggressive = trimHistory(history, {
      ...trimOptions,
      keepTailMessages: Math.max(2, Math.floor(trimOptions.keepTailMessages / 2)),
      keepToolHeadBytes: Math.floor(trimOptions.keepToolHeadBytes / 2),
      keepToolTailBytes: Math.floor(trimOptions.keepToolTailBytes / 2),
      targetTokens: Math.floor(budget.compactWatermark / 2),
    });

    const aggressiveMessages = summaryMessage
      ? [summaryMessage, ...aggressive.messages]
      : aggressive.messages;
    const aggressiveTokens = estimateMessagesTokens(aggressiveMessages);
    const aggressiveRatio =
      beforeTokens > 0 ? (beforeTokens - aggressiveTokens) / beforeTokens : 0;

    if (aggressiveRatio < MIN_SAVED_RATIO) {
      deps.journal?.markRolledBack(transactionId);
      return {
        compacted: false,
        checkpointId,
        beforeTokens,
        afterTokens: aggressiveTokens,
        savedRatio: aggressiveRatio,
        reason: `the compaction would only save ${Math.round(aggressiveRatio * 100)}% of the context`,
      };
    }

    trimmed = { ...aggressive, messages: aggressiveMessages };
  }

  deps.sessions.replaceHistory(sessionId, trimmed.messages);
  deps.journal?.append({
    txId: transactionId,
    kind: 'compaction',
    state: 'commit',
    ts: new Date().toISOString(),
  });

  deps.logger.info('history compacted', {
    sessionId,
    beforeTokens,
    afterTokens: estimateMessagesTokens(trimmed.messages),
    savedRatio: Number(((beforeTokens - estimateMessagesTokens(trimmed.messages)) / beforeTokens).toFixed(3)),
  });

  return {
    compacted: true,
    checkpointId,
    beforeTokens,
    afterTokens: estimateMessagesTokens(trimmed.messages),
    savedRatio: (beforeTokens - estimateMessagesTokens(trimmed.messages)) / beforeTokens,
    messages: trimmed.messages,
  };
}

/** The text of the messages that the trimming removed. */
function droppedContent(
  history: readonly AgentMessage[],
  kept: readonly AgentMessage[],
): string {
  const keptIds = new Set(kept.map((message) => message.id));
  const parts: string[] = [];
  for (const message of history) {
    if (keptIds.has(message.id)) continue;
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'tool_result') {
        parts.push(
          block.content.map((entry) => (entry.type === 'text' ? entry.text : '[image]')).join(''),
        );
      }
    }
  }
  const text = parts.join('\n');
  return estimateTokens(text) > 0 ? text : '';
}

export { buildCompactionPrompt };
