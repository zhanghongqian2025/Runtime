import type { ToolResult } from '@local-agent/protocol';

/** Helpers that build a well-formed tool result. */

export function textResult(text: string): ToolResult {
  return { ok: true, isError: false, content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolResult {
  return { ok: false, isError: true, content: [{ type: 'text', text: message }] };
}

/** Build the result of a failed call, keeping the reason diagnosable. */
export function failure(tool: string, reason: string): ToolResult {
  return errorResult(`${tool} failed: ${reason}`);
}
