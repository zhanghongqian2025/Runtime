/**
 * Provider error classification.
 *
 * The retry contract is deliberately explicit: a failure is retryable only
 * when it is one of a short list, and everything else fails closed. Guessing
 * wrong here either burns the user's quota or silently gives up on a
 * transient fault.
 *
 * See docs/contracts.md §7.3.
 */

export const PROVIDER_ERROR_KINDS = [
  'connection-timeout',
  'network',
  'rate-limit',
  'overloaded',
  'quota-exhausted',
  'auth',
  'aborted',
  'bad-request',
  'content-filter',
  'server-error',
  'empty-response',
  'unknown',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** The only kinds that may be retried. */
const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'connection-timeout',
  'network',
  'rate-limit',
  'overloaded',
]);
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

/** A provider failure with enough structure to decide what to do next. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  /** Parsed `Retry-After` hint, in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number | undefined;
      retryAfterMs?: number | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const QUOTA_MARKERS = [
  'insufficient_quota',
  'insufficient credit',
  'exceeded your current quota',
  'billing',
  'credits',
];

const CONTENT_FILTER_MARKERS = [
  'content_filter',
  'content filter',
  'safety',
  'responsible_ai',
];

const OVERLOAD_MARKERS = ['overloaded', 'overloaded_error', 'server is busy'];

const RATE_LIMIT_MARKERS = ['rate limit', 'rate_limit', 'tpm', 'rpm', 'tokens per minute'];

/** Parse a `Retry-After` header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | undefined, now: number = Date.now()): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

/** Classify a non-2xx HTTP response. */
export function classifyHttpFailure(
  status: number,
  body: string,
  retryAfterHeader?: string,
): ProviderError {
  const lowered = body.toLowerCase();

  if (status === 401 || status === 403) {
    return new ProviderError('auth', `provider authentication failed (HTTP ${status})`, {
      status,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    });
  }

  if (status === 429) {
    const isRateLimit = RATE_LIMIT_MARKERS.some((marker) => lowered.includes(marker));
    if (!isRateLimit && QUOTA_MARKERS.some((marker) => lowered.includes(marker))) {
      return new ProviderError('quota-exhausted', 'provider quota exhausted', {
        status,
        retryAfterMs: parseRetryAfter(retryAfterHeader),
      });
    }
    return new ProviderError('rate-limit', `provider rate limited the request (HTTP ${status})`, {
      status,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    });
  }

  if (status === 529) {
    return new ProviderError('overloaded', 'provider is overloaded (HTTP 529)', {
      status,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    });
  }

  if (status === 400 || status === 422) {
    return new ProviderError('bad-request', `provider rejected the request (HTTP ${status})`, {
      status,
    });
  }

  if (status >= 500) {
    return new ProviderError('server-error', `provider failed with HTTP ${status}`, { status });
  }

  return new ProviderError('unknown', `provider returned HTTP ${status}`, { status });
}

/** Classify a transport level failure. */
export function classifyTransportFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  // `fetch` wraps the socket error: a refused connection surfaces as a
  // TypeError whose `cause` carries the real code. Look at both.
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const candidates = [error, cause].filter(
    (entry): entry is Error => entry instanceof Error,
  );

  const name = candidates[0]?.name ?? '';
  const code = candidates
    .map((entry) => (entry as NodeJS.ErrnoException).code)
    .find((value): value is string => typeof value === 'string') ?? '';

  const causeName = candidates[1]?.name ?? '';
  if (name === 'AbortError' || causeName === 'AbortError' || code === 'ABORT_ERR') {
    return new ProviderError('aborted', 'the request was aborted', { cause: error });
  }

  if (
    name === 'TimeoutError' ||
    causeName === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED'
  ) {
    return new ProviderError('connection-timeout', 'the provider request timed out', { cause: error });
  }

  if (
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    return new ProviderError('network', `the provider connection failed (${code})`, { cause: error });
  }

  return new ProviderError('unknown', 'the provider request failed', { cause: error });
}

/**
 * Inspect a provider error body for quota and content-filter markers.
 *
 * Some providers answer HTTP 400 for a quota problem, so the body decides.
 */
export function classifyErrorBody(kind: ProviderErrorKind, body: string): ProviderErrorKind {
  const lowered = body.toLowerCase();
  if (QUOTA_MARKERS.some((marker) => lowered.includes(marker))) return 'quota-exhausted';
  if (CONTENT_FILTER_MARKERS.some((marker) => lowered.includes(marker))) return 'content-filter';
  if (OVERLOAD_MARKERS.some((marker) => lowered.includes(marker))) return 'overloaded';
  return kind;
}
