import type { IncomingMessage, ServerResponse } from 'node:http';

/** Structured error body returned to clients. Stacks never leave the process. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error: ApiErrorBody['error'] =
    details === undefined
      ? { code, message }
      : { code, message, details };
  sendJson(response, status, { error } satisfies ApiErrorBody);
}

/** Read a JSON request body. Used by the mutating endpoints. */
export async function readJsonBody(
  request: IncomingMessage,
  limitBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}
