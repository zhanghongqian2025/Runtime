import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@local-agent/protocol';
import { HOOK_CATEGORY, isAppendMessageAllowed, isRespondAllowed } from './hooks.js';

const marker: AgentMessage = {
  id: 'msg_marker',
  role: 'user',
  content: [{ type: 'custom', kind: 'marker.tail', hidden: true, payload: { note: 'x' } }],
  createdAt: '2026-10-21T06:00:00.000Z',
};

const plain: AgentMessage = {
  id: 'msg_plain',
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  createdAt: '2026-10-21T06:00:00.000Z',
};

describe('hook categories', () => {
  it('keeps decision pipelines, fan-out and boundary hooks apart', () => {
    expect(HOOK_CATEGORY.beforeLlmCall).toBe('decision-pipeline');
    expect(HOOK_CATEGORY.afterLlmCall).toBe('decision-pipeline');
    expect(HOOK_CATEGORY.beforeToolCall).toBe('decision-pipeline');
    expect(HOOK_CATEGORY.afterToolCall).toBe('decision-pipeline');
    expect(HOOK_CATEGORY.onHistoryChanged).toBe('notification-fan-out');
    expect(HOOK_CATEGORY.onStepEnd).toBe('boundary');
  });
});

describe('appendMessage decision', () => {
  it('accepts a hidden typed custom message', () => {
    expect(isAppendMessageAllowed(marker)).toBe(true);
  });

  it('rejects a message that is not a hidden custom marker', () => {
    expect(isAppendMessageAllowed(plain)).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(isAppendMessageAllowed({ ...marker, content: [] })).toBe(false);
  });
});

describe('respond decision', () => {
  it('accepts a verified non-empty text before the provider call', () => {
    expect(
      isRespondAllowed({ kind: 'respond', text: 'done', verified: true }, { providerCalled: false }),
    ).toBe(true);
  });

  it('rejects empty or blank text', () => {
    expect(
      isRespondAllowed({ kind: 'respond', text: '   ', verified: true }, { providerCalled: false }),
    ).toBe(false);
  });

  it('rejects a respond once the provider has been called', () => {
    expect(
      isRespondAllowed({ kind: 'respond', text: 'done', verified: true }, { providerCalled: true }),
    ).toBe(false);
  });
});
