/**
 * The HTTP client of the CLI.
 *
 * It retries **once** when a request fails with a connection level error: the
 * runtime may have been restarted on the same port, and the pooled socket the
 * client picked is the one the old process closed. A single retry turns that
 * race into a transparent hiccup.
 */

/** The error codes that mean "the connection was broken, not the request". */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
]);

export interface HttpJsonResult {
  readonly status: number;
  readonly body: unknown;
}

/** True when the failure is a broken connection rather than a rejected request. */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidates = [error, (error as { cause?: unknown }).cause].filter(
    (entry): entry is Error => entry instanceof Error,
  );
  return candidates.some((entry) => {
    const code = (entry as NodeJS.ErrnoException).code;
    return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
  });
}

/** A fetch that survives a broken pooled connection. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error: unknown) {
      lastError = error;
      if (attempt === attempts || !isConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

export async function fetchJson(
  url: string,
  timeoutMs = 5000,
  init: RequestInit = {},
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithRetry(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
