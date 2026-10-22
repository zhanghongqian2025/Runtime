import { describe, expect, it } from 'vitest';
import {
  AgentMessageSchema,
  CustomMessageKindSchema,
  isCustomMarkerMessage,
  ToolResultSchema,
} from './message.js';

const baseMessage = {
  id: 'msg_1',
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  createdAt: '2026-10-21T06:00:00.000Z',
} as const;

describe('AgentMessage', () => {
  it('accepts a minimal message', () => {
    expect(AgentMessageSchema.safeParse(baseMessage).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    const result = AgentMessageSchema.safeParse({ ...baseMessage, extra: true });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(AgentMessageSchema.safeParse({ ...baseMessage, role: 'robot' }).success).toBe(false);
  });

  it('rejects a content block with an unknown type', () => {
    const result = AgentMessageSchema.safeParse({
      ...baseMessage,
      content: [{ type: 'video', url: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('typed custom messages', () => {
  it('closes the kind set', () => {
    expect(CustomMessageKindSchema.safeParse('marker.tail').success).toBe(true);
    expect(CustomMessageKindSchema.safeParse('marker.before-current-user').success).toBe(true);
    expect(CustomMessageKindSchema.safeParse('after-commit').success).toBe(true);
    expect(CustomMessageKindSchema.safeParse('marker.anywhere').success).toBe(false);
  });

  it('requires hidden markers', () => {
    const result = AgentMessageSchema.safeParse({
      ...baseMessage,
      content: [{ type: 'custom', kind: 'marker.tail', hidden: false, payload: null }],
    });
    expect(result.success).toBe(false);
  });

  it('detects marker messages', () => {
    const marker = AgentMessageSchema.parse({
      ...baseMessage,
      content: [{ type: 'custom', kind: 'marker.tail', hidden: true, payload: { note: 'x' } }],
    });
    expect(isCustomMarkerMessage(marker)).toBe(true);
    expect(isCustomMarkerMessage(AgentMessageSchema.parse(baseMessage))).toBe(false);
  });
});

describe('ToolResult', () => {
  it('records truncation metadata', () => {
    const result = ToolResultSchema.parse({
      ok: true,
      content: [{ type: 'text', text: 'output' }],
      isError: false,
      truncated: { omittedBytes: 120, strategy: 'head-tail' },
    });
    expect(result.truncated?.omittedBytes).toBe(120);
    expect(result.truncated?.strategy).toBe('head-tail');
  });

  it('rejects unknown fields', () => {
    const result = ToolResultSchema.safeParse({
      ok: true,
      content: [],
      isError: false,
      surprise: 1,
    });
    expect(result.success).toBe(false);
  });
});
