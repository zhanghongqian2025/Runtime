import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runHealth } from './health.js';

describe('health command', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  const startFakeRuntime = async (): Promise<number> => {
    server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as AddressInfo).port;
  };

  it('prints the health payload of a reachable runtime', async () => {
    const port = await startFakeRuntime();
    const lines: string[] = [];
    const result = await runHealth({
      flags: { host: '127.0.0.1', port: String(port) },
      env: {},
      write: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('"status": "ok"');
  });

  it('reports a missing runtime', async () => {
    const lines: string[] = [];
    const result = await runHealth({
      flags: {},
      env: { XDG_STATE_HOME: '/nonexistent-local-agent-state' },
      write: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(1);
    expect(lines.join('')).toContain('no runtime found');
  });

  it('reports an unreachable runtime', async () => {
    const result = await runHealth({
      flags: { host: '127.0.0.1', port: '1' },
      env: {},
      write: () => undefined,
    });
    expect(result.exitCode).toBe(1);
  });
});
