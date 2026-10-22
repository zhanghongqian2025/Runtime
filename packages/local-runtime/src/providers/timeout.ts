import type { ProviderCallContext, ProviderStreamChunk } from '@local-agent/agent-core/pi-turn-runner';
import { ProviderError } from './errors.js';

/**
 * Per-attempt timeouts.
 *
 * Every physical attempt gets a first-event timeout and an idle timeout. A
 * timeout ends the attempt as a **retryable** `LLM request timed out`, so the
 * retry decision sees a normal transient failure. A user abort is passed
 * through untouched.
 *
 * See docs/contracts.md §7.4.
 */

export const TIMEOUT_MESSAGE = 'LLM request timed out';

class TimeoutSignal extends Error {
  constructor() {
    super(TIMEOUT_MESSAGE);
    this.name = 'TimeoutError';
  }
}

const raceWithDeadline = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) {
    throw new ProviderError('aborted', 'the request was aborted');
  }

  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal()), timeoutMs);
    timer.unref?.();
  });

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const listener = (): void => {
      reject(new ProviderError('aborted', 'the request was aborted'));
    };
    signal.addEventListener('abort', listener, { once: true });
    removeAbortListener = (): void => signal.removeEventListener('abort', listener);
  });

  try {
    return await Promise.race([work, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
};

/**
 * Apply the first-event, idle and total timeouts to a chunk stream.
 */
export async function* applyAttemptTimeouts(
  source: AsyncIterable<ProviderStreamChunk>,
  context: ProviderCallContext,
  signal: AbortSignal,
  now: () => number = Date.now,
): AsyncGenerator<ProviderStreamChunk> {
  const iterator = source[Symbol.asyncIterator]();
  const deadline = now() + context.totalTimeoutMs;
  let receivedFirst = false;

  try {
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new ProviderError('connection-timeout', TIMEOUT_MESSAGE);
      }

      const budget = receivedFirst ? context.idleTimeoutMs : context.firstEventTimeoutMs;
      const timeoutMs = Math.min(budget, remaining);

      let result: IteratorResult<ProviderStreamChunk>;
      try {
        result = await raceWithDeadline(iterator.next(), timeoutMs, signal);
      } catch (error: unknown) {
        if (error instanceof TimeoutSignal) {
          throw new ProviderError('connection-timeout', TIMEOUT_MESSAGE, { cause: error });
        }
        throw error;
      }

      if (result.done === true) return;
      receivedFirst = true;
      yield result.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}
