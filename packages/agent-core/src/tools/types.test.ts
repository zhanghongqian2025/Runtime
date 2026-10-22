import { describe, expect, it } from 'vitest';
import { isValidToolName, TOOL_NAME_PATTERN } from './types.js';

describe('tool names', () => {
  it('accepts the model-visible tool names of this runtime', () => {
    for (const name of [
      'read',
      'write',
      'edit',
      'apply_patch',
      'bash',
      'grep',
      'glob',
      'todo_write',
      'ask_user',
    ]) {
      expect(isValidToolName(name), name).toBe(true);
    }
  });

  it('rejects names that would confuse the model or the wire format', () => {
    expect(isValidToolName('Read')).toBe(false);
    expect(isValidToolName('read-file')).toBe(false);
    expect(isValidToolName('1read')).toBe(false);
    expect(isValidToolName('')).toBe(false);
    expect(isValidToolName(undefined)).toBe(false);
  });

  it('bounds the name length', () => {
    expect(TOOL_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(TOOL_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});
