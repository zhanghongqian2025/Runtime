/**
 * A small SSE reader for the client side.
 *
 * The CLI is a separate process that talks to the runtime over HTTP, so it
 * carries its own reader instead of importing the host package.
 */

export interface SseMessage {
  readonly event: string | undefined;
  readonly data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseMessage> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const message: SseMessage = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    return message;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);

        if (line === '') {
          const message = dispatch();
          if (message) yield message;
          continue;
        }
        if (line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
      }
    }
  } finally {
    // Cancelling closes the underlying connection. Releasing the lock alone
    // would keep the socket open and hang the process.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed; nothing to do.
    }
  }
}
