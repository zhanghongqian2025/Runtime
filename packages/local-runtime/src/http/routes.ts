import { PROTOCOL_VERSION, RUNTIME_NAME, RUNTIME_VERSION } from '@local-agent/protocol';
import type { LoadedRuntimeConfig } from '../config/types.js';
import { toConfigView } from '../config/types.js';
import type { Router } from './router.js';
import { sendJson } from './respond.js';

/** Dependencies the runtime routes need. */
export interface RouteDependencies {
  readonly config: LoadedRuntimeConfig;
  readonly startedAt: number;
  readonly now: () => number;
}

export function registerRuntimeRoutes(router: Router, deps: RouteDependencies): void {
  const { config, startedAt, now } = deps;

  router.get('/health', ({ response }) => {
    sendJson(response, 200, {
      status: 'ok',
      name: RUNTIME_NAME,
      version: RUNTIME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Math.max(0, now() - startedAt),
      pid: process.pid,
    });
  });

  router.get('/v1/version', ({ response }) => {
    sendJson(response, 200, {
      name: RUNTIME_NAME,
      version: RUNTIME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  router.get('/v1/config', ({ response }) => {
    // The view carries the key *variable name* and a boolean, never a value.
    sendJson(response, 200, toConfigView(config));
  });
}
