import type { AgentMessage } from '@local-agent/protocol';

/**
 * Close tool calls that never produced a result.
 *
 * A turn that is interrupted — the process dies, the approval is never
 * answered, the user aborts — leaves an assistant message with a `tool_use`
 * block and no matching `tool_result`. Providers expect every tool call to be
 * answered, and some of them answer a malformed history with an empty
 * completion instead of an error. The session then looks alive but every
 * following request silently produces nothing.
 *
 * The dangling call is closed with an explicit error result, inserted right
 * after the message that asked for it, so the next request is well formed
 * again.
 */

/** The text of the synthetic result written for an unanswered tool call. */
export const INTERRUPTED_TOOL_RESULT_NOTE =
  'the tool call was interrupted before it returned a result';

export interface HistoryRepair {
  /** The history with every dangling tool call closed. */
  readonly messages: readonly AgentMessage[];
  /** The ids of the tool calls that had to be closed. */
  readonly repairedToolCallIds: readonly string[];
}

export function repairDanglingToolCalls(
  messages: readonly AgentMessage[],
  note: string = INTERRUPTED_TOOL_RESULT_NOTE,
): HistoryRepair {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') answered.add(block.toolCallId);
    }
  }

  const repairedToolCallIds: string[] = [];
  const output: AgentMessage[] = [];

  for (const message of messages) {
    output.push(message);
    if (message.role !== 'assistant') continue;

    const missing: string[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      if (answered.has(block.toolCallId)) continue;
      answered.add(block.toolCallId);
      missing.push(block.toolCallId);
    }
    if (missing.length === 0) continue;

    repairedToolCallIds.push(...missing);
    output.push({
      id: `msg_repaired_${missing.join('_')}`,
      role: 'tool',
      content: missing.map((toolCallId) => ({
        type: 'tool_result' as const,
        toolCallId,
        content: [{ type: 'text' as const, text: note }],
        isError: true,
      })),
      createdAt: message.createdAt,
    });
  }

  return { messages: output, repairedToolCallIds };
}
