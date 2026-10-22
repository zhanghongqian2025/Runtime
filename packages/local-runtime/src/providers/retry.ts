import { ProviderError, isRetryableKind, type ProviderErrorKind } from './errors.js';

/**
 * The retry contract.
 *
 * - At most 5 retries after the first attempt.
 * - Exponential backoff with **equal jitter**: `delay = random(0, min(cap, base * 2^n))`.
 * - `Retry-After` is honoured but clamped to the per-attempt delay cap.
 * - The total elapsed budget bounds the whole episode.
 * - Only a short list of failures is retryable; everything else fails closed.
 *
 * See docs/contracts.md §7.4.
 */

export interface RetryPolicy {
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  /** Upper bound for a single delay. */
  readonly maxDelayMs: number;
  /** Upper bound for the whole episode. */
  readonly totalBudgetMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  totalBudgetMs: 20 * 60 * 1000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Equal-jitter backoff: random in `[0, min(cap, base * 2^attempt))`. */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(policy.maxDelayMs, exponential);
  return Math.floor(random() * capped);
}

export interface RetryOutcome<T> {
  readonly value: T;
  /** Physical attempts, including the first one. */
  readonly attempts: number;
  /** Total time spent waiting between attempts. */
  readonly waitedMs: number;
}

export interface RetryContext {
  /** Called before every attempt, so the caller can report the attempt number. */
  readonly onAttempt?: (attempt: number, error?: ProviderError) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/**
 * Run `attempt` with the retry contract applied.
 *
 * The attempt function receives the 1-based physical attempt number. A
 * non-retryable failure is rethrown untouched.
 */
export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  context: RetryContext = {},
): Promise<RetryOutcome<T>> {
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? policy.sleep ?? defaultSleep;
  const random = context.random ?? policy.random ?? Math.random;

  const startedAt = now();
  let waitedMs = 0;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      context.onAttempt?.(attemptNumber);
      const value = await attempt(attemptNumber);
      return { value, attempts: attemptNumber, waitedMs };
    } catch (error: unknown) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError('unknown', 'the provider request failed', { cause: error });

      const canRetry =
        isRetryableKind(providerError.kind) && attemptNumber <= policy.maxRetries;

      if (!canRetry) {
        throw providerError;
      }

      const elapsed = now() - startedAt;
      if (elapsed >= policy.totalBudgetMs) {
        throw providerError;
      }

      const jittered = backoffDelayMs(attemptNumber - 1, policy, random);
      const hinted = providerError.retryAfterMs ?? 0;
      const delay = Math.min(policy.maxDelayMs, Math.max(jittered, hinted));

      if (elapsed + delay > policy.totalBudgetMs) {
        throw providerError;
      }

      waitedMs += delay;
      await sleep(delay);
    }
  }
}

/** The kind of the last failure, for metrics. */
export function errorKindOf(error: unknown): ProviderErrorKind {
  return error instanceof ProviderError ? error.kind : 'unknown';
}
