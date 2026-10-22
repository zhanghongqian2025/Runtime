/**
 * Server-sent event parsing.
 *
 * Both provider families stream over SSE, so the byte-level parsing lives
 * here and the family-specific mapping lives in the adapters.
 */

export interface SseEvent {
  /** The `event:` field, when the server sent one. */
  readonly event: string | undefined;
  /** The joined `data:` payload. */
  readonly data: string;
}

/** Read a `fetch` response body as an async iterable of byte chunks. */
export async function* readBytes(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE byte stream into events.
 *
 * Comments (`:` lines) are ignored, `data:` fields are joined with newlines
 * and an event is dispatched on the blank line.
 */
export async function* readSseEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const event: SseEvent = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    return event;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);

      if (line === '') {
        const event = dispatch();
        if (event) yield event;
        continue;
      }
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }
  }

  const tail = dispatch();
  if (tail) yield tail;
}

/** Parse an SSE byte stream and yield only the `data:` payloads. */
export async function* readSseData(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  for await (const event of readSseEvents(body)) {
    yield event.data;
  }
}
