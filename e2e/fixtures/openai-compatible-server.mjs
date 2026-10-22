import { createServer } from 'node:http';

/**
 * A local OpenAI-compatible server.
 *
 * It speaks the real protocol over a real socket: chunked `text/event-stream`
 * responses, one `data:` frame at a time, with a delay between the frames.
 * That makes it possible to exercise the runtime's real HTTP path (fetch, SSE
 * parsing, tool-call assembly, retries, timeouts) without a cloud account
 * and without touching the network.
 *
 * It is a test fixture: it is not part of the runtime.
 */

/**
 * @typedef {object} Scenario
 * @property {number} [status] the HTTP status (200 by default)
 * @property {string} [body] the raw response body (an SSE body by default)
 * @property {Record<string, string>} [headers] extra response headers
 * @property {number} [delayBeforeMs] wait before the first byte
 * @property {number} [frameDelayMs] wait between the frames
 * @property {boolean} [dropAfterFrames] cut the connection in the middle
 */

/** Build an SSE body from `data:` payloads. */
export function buildSseBody(...payloads) {
  return payloads.map((payload) => `data: ${payload}\n\n`).join('');
}

/** A text delta frame. */
export function textFrame(text) {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

/** A tool call frame. */
export function toolCallFrame(index, id, name, args) {
  return JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
}

/** The usage frame some providers send last. */
export function usageFrame(promptTokens, completionTokens) {
  return JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

export const DONE_FRAME = '[DONE]';

/**
 * Start the server.
 *
 * @param {object} options
 * @param {Scenario[]} options.scenarios the responses, one per request; the
 *   last one repeats.
 * @param {number} [options.port] the port (0 picks a free one)
 */
export function startOpenAiCompatibleServer({ scenarios, port = 0 }) {
  /** @type {Scenario[]} */
  const received = [];
  let index = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
      received.push({ url: request.url, body });

      const scenario = scenarios[Math.min(index, scenarios.length - 1)] ?? {};
      index += 1;

      if (scenario.delayBeforeMs) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayBeforeMs));
      }

      const status = scenario.status ?? 200;
      const headers = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        ...(scenario.headers ?? {}),
      };

      response.writeHead(status, headers);

      if (status !== 200) {
        response.end(scenario.body ?? JSON.stringify({ error: { message: 'failed' } }));
        return;
      }

      const body200 = scenario.body ?? buildSseBody(textFrame('hello'), DONE_FRAME);
      const frames = body200.split('\n\n').filter((frame) => frame.length > 0);

      let sent = 0;
      for (const frame of frames) {
        if (scenario.frameDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, scenario.frameDelayMs));
        }
        response.write(`${frame}\n\n`);
        sent += 1;
        if (scenario.dropAfterFrames && sent >= scenario.dropAfterFrames) {
          response.destroy();
          return;
        }
      }
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address !== null ? address.port : port,
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
