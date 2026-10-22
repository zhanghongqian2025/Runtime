import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../config/types.js';
import { createLogger } from '../logging/logger.js';
import { createRuntimeServer, type RuntimeServer } from './server.js';

describe('runtime server', () => {
  let server: RuntimeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (): Promise<number> => {
    const config = loadRuntimeConfig({}, { readFile: false });
    const logger = createLogger({ level: 'error', sink: () => undefined });
    server = createRuntimeServer({
      config,
      logger,
      writeRuntimeFile: false,
      env: {},
      dataDir: mkdtempSync(join(tmpdir(), 'local-agent-server-')),
    });
    return server.listen();
  };

  it('answers /health', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      version: string;
      protocolVersion: string;
      pid: number;
    };
    expect(body.status).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(body.protocolVersion).toBeTruthy();
    expect(body.pid).toBe(process.pid);
  });

  it('answers /v1/version', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/version`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string; version: string };
    expect(body.name).toBe('local-agent-runtime');
  });

  it('answers /v1/config with the effective configuration', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { host: string; permissionMode: string; providers: unknown[] };
    expect(body.host).toBe('127.0.0.1');
    expect(body.permissionMode).toBe('ask');
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it('returns a structured error for an unknown path', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns 405 when the method does not match', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('binds to the loopback interface only', async () => {
    const port = await start();
    const address = server?.httpPort;
    expect(address).toBe(port);
  });
});
