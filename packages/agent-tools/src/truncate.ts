import type { ToolOutputLimits } from '@local-agent/agent-core/tools';

/**
 * Output size governance.
 *
 * A tool result must never blow up the context. Long output is trimmed with
 * a head/tail split and the number of dropped bytes is reported, so the model
 * can tell that something was cut.
 *
 * See docs/contracts.md §4.4.
 */

export type OutputLimits = ToolOutputLimits;

export interface TruncatedText {
  readonly text: string;
  readonly omittedBytes: number;
  readonly strategy: 'head-tail' | 'head' | 'none';
}

export const TRUNCATION_MARKER = 'truncated';

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Trim text to the limits, keeping the head and the tail. */
export function truncateText(text: string, limits: OutputLimits): TruncatedText {
  let working = text;
  let omittedBytes = 0;
  let strategy: TruncatedText['strategy'] = 'none';

  const lines = working.split('\n');
  if (lines.length > limits.maxLines) {
    const headCount = Math.max(1, Math.ceil(limits.maxLines * 0.6));
    const tailCount = Math.max(0, limits.maxLines - headCount);
    const dropped = lines.slice(headCount, lines.length - tailCount);
    const head = lines.slice(0, headCount);
    const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
    omittedBytes += byteLength(dropped.join('\n'));
    working = [...head, `…[${TRUNCATION_MARKER} ${dropped.length} lines]…`, ...tail].join('\n');
    strategy = 'head-tail';
  }

  if (byteLength(working) > limits.maxBytes) {
    const buffer = Buffer.from(working, 'utf8');
    const headBudget = Math.max(1, Math.floor(limits.maxBytes * 0.6));
    const tailBudget = Math.max(0, limits.maxBytes - headBudget);
    const droppedBytes = buffer.length - limits.maxBytes;
    const head = buffer.subarray(0, headBudget).toString('utf8');
    const tail = tailBudget > 0 ? buffer.subarray(buffer.length - tailBudget).toString('utf8') : '';
    omittedBytes += droppedBytes;
    working = `${head}\n…[${TRUNCATION_MARKER} ${droppedBytes} bytes]…\n${tail}`;
    strategy = 'head-tail';
  }

  return { text: working, omittedBytes, strategy };
}
