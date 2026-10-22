import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@local-agent/protocol';
import { repairDanglingToolCalls } from './history-repair.js';

const user = (text: string): AgentMessage => ({
  id: `m_${text}`,
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-10-22T00:00:00.000Z',
});

const toolCall = (toolCallId: string): AgentMessage => ({
  id: `m_call_${toolCallId}`,
  role: 'assistant',
  content: [{ type: 'tool_use', toolCallId, name: 'read', input: { path: 'a.md' } }],
  createdAt: '2026-10-22T00:00:01.000Z',
});

const toolResult = (toolCallId: string): AgentMessage => ({
  id: `m_result_${toolCallId}`,
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
  ],
  createdAt: '2026-10-22T00:00:02.000Z',
});

describe('history repair', () => {
  it('closes a tool call that never got a result', () => {
    const repair = repairDanglingToolCalls([user('read a.md'), toolCall('call_1')]);

    expect(repair.repairedToolCallIds).toEqual(['call_1']);
    expect(repair.messages).toHaveLength(3);

    const closing = repair.messages[2];
    expect(closing?.role).toBe('tool');
    const block = closing?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type !== 'tool_result') throw new Error('unreachable');
    expect(block.toolCallId).toBe('call_1');
    expect(block.isError).toBe(true);
  });

  it('inserts the closing result right after the message that asked for it', () => {
    const repair = repairDanglingToolCalls([
      user('read a.md'),
      toolCall('call_1'),
      user('and now something else'),
    ]);

    // The result has to follow the tool call, otherwise the provider view
    // stays malformed.
    expect(repair.messages[1]?.role).toBe('assistant');
    expect(repair.messages[2]?.role).toBe('tool');
    expect(repair.messages[3]?.role).toBe('user');
  });

  it('leaves an answered tool call alone', () => {
    const repair = repairDanglingToolCalls([user('read a.md'), toolCall('call_1'), toolResult('call_1')]);

    expect(repair.repairedToolCallIds).toHaveLength(0);
    expect(repair.messages).toHaveLength(3);
  });

  it('leaves a history without tool calls alone', () => {
    const repair = repairDanglingToolCalls([user('hello')]);

    expect(repair.repairedToolCallIds).toHaveLength(0);
    expect(repair.messages).toHaveLength(1);
  });

  it('closes every unanswered call of a message with several calls', () => {
    const multi: AgentMessage = {
      id: 'm_multi',
      role: 'assistant',
      content: [
        { type: 'tool_use', toolCallId: 'call_1', name: 'read', input: {} },
        { type: 'tool_use', toolCallId: 'call_2', name: 'read', input: {} },
      ],
      createdAt: '2026-10-22T00:00:01.000Z',
    };

    const repair = repairDanglingToolCalls([user('read two files'), multi, toolResult('call_1')]);

    expect(repair.repairedToolCallIds).toEqual(['call_2']);
    const closing = repair.messages[2];
    expect(closing?.content).toHaveLength(1);
  });
});
