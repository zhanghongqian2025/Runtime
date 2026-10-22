import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_NAME, RUNTIME_VERSION } from '@local-agent/protocol';
import type { ToolBinder, ToolImpl } from '@local-agent/agent-core/tools';
import { LOCAL_TOOLS } from '@local-agent/agent-tools';
import type { LoadedRuntimeConfig } from '../config/types.js';
import { createEventBus } from '../events/bus.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { createProviderFromConfig } from '../providers/index.js';
import type { ProviderAdapter } from '../providers/types.js';
import { createDiskSessionStore } from '../sessions/disk-store.js';
import { createFileEventLog } from '../sessions/event-log.js';
import { recoverSessions } from '../sessions/recovery.js';
import { createToolBinder } from '../tools/binder.js';
import { createTurnSystem } from '../turns/turn-system.js';
import { createRouter, type Router } from './router.js';
import { sendError } from './respond.js';
import { registerRuntimeRoutes } from './routes.js';
import { registerSessionRoutes } from './session-routes.js';
import { consoleHtml } from './ui.js';
import type { SessionStore } from '../sessions/types.js';
import type { EventDelivery } from '../events/types.js';
import type { TurnSystem } from '../turns/turn-system.js';
import type { TurnPolicy } from '../turns/policy.js';

/**
 * The local HTTP server.
 *
 * It binds to the loopback interface by default and serves the session and
 * event endpoints. The bound port is written to a runtime file so a client
 * can discover it without configuration (docs/contracts.md §6.1).
 */

export interface RuntimeServerOptions {
  readonly config: LoadedRuntimeConfig;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Write the runtime port file on listen. Disabled in unit tests. */
  readonly writeRuntimeFile?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected provider. The tests pass a recorded-replay one. */
  readonly provider?: ProviderAdapter;
  readonly tools?: ToolBinder;
  /** Working directory of new sessions. */
  readonly defaultCwd?: string;
  /** Where the sessions live. Defaults to the runtime state directory. */
  readonly dataDir?: string;
}

/** The services the application layer builds on. */
export interface RuntimeServices {
  readonly sessions: SessionStore;
  readonly events: EventDelivery;
  readonly turns: TurnSystem;
  /** The tools a session may use. */
  readonly tools: ToolBinder;
}

export interface RuntimeServer {
  /** The bound TCP port. Zero until `listen` resolves. */
  readonly httpPort: number;
  /** The services the application layer uses. */
  readonly services: RuntimeServices;
  /** Install the turn policy (the plan mode installs one). */
  setPolicy(policy: TurnPolicy | undefined): void;
  /** Register the routes of the application layer. Call before `listen`. */
  setExtraRoutes(register: (router: Router, services: RuntimeServices) => void): void;
  /** Add tools to the sessions. Call before `listen`. */
  setExtraTools(tools: readonly ToolImpl[]): void;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

/** Where the runtime keeps its state directory. */
export function runtimeStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, RUNTIME_NAME);
}

/** The file that advertises the running runtime. */
export function runtimeFilePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(runtimeStateDir(env), 'runtime.json');
}

export function createRuntimeServer(options: RuntimeServerOptions): RuntimeServer {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ homeDir: homedir() });
  const now = options.now ?? Date.now;
  const startedAt = now();
  const writeRuntimeFile = options.writeRuntimeFile ?? true;

  const dataDir = options.dataDir ?? runtimeStateDir(env);

  // Repair what a previous process may have left half written.
  const recovery = recoverSessions(dataDir);
  if (recovery.sessions > 0) {
    logger.info('recovered the sessions', {
      sessions: recovery.sessions,
      repairedFiles: recovery.repairedFiles,
      rolledBackTransactions: recovery.rolledBackTransactions,
      interruptedTurns: recovery.interruptedTurns,
      repairedToolCalls: recovery.repairedToolCalls,
    });
  }

  const sessions = createDiskSessionStore({ dataDir });
  const eventLog = createFileEventLog({
    dataDir,
    retainCount: options.config.config.events.retainCount,
  });
  const events = createEventBus({
    retainCount: options.config.config.events.retainCount,
    log: eventLog,
  });
  const provider = options.provider ?? createProviderFromConfig(options.config);
  const baseTools = options.tools ?? createToolBinder(LOCAL_TOOLS);
  let extraTools: readonly ToolImpl[] = [];
  const tools: ToolBinder = {
    resolve: (name) => baseTools.resolve(name) ?? extraTools.find((tool) => tool.definition.name === name),
    list: () => [...baseTools.list(), ...extraTools.map((tool) => ({ definition: tool.definition, runtime: 'local' as const, enabled: true }))],
    bind: (definitions) => [...baseTools.bind(definitions), ...extraTools.map((tool) => ({ definition: tool.definition, runtime: 'local' as const, enabled: true })).filter((entry) => definitions.some((definition) => definition.name === entry.definition.name))],
  };
  const firstProvider = options.config.config.providers[0];

  const turns = createTurnSystem({
    sessions,
    events,
    config: options.config,
    provider,
    tools,
    logger,
    dataDir,
  });

  const router: Router = createRouter();

  // The web console: a single static page, no framework.
  router.get('/', ({ response }) => {
    const html = consoleHtml();
    if (html === undefined) {
      sendError(response, 404, 'NOT_FOUND', 'the web console is not bundled in this build');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  });

  registerRuntimeRoutes(router, { config: options.config, startedAt, now });
  registerSessionRoutes(router, {
    sessions,
    events,
    turns,
    logger,
    defaultCwd: options.defaultCwd ?? process.cwd(),
    defaultProviderId: firstProvider?.id ?? 'openai-compatible',
    defaultModel: firstProvider?.model ?? 'unknown',
  });

  const services: RuntimeServices = { sessions, events, turns, tools };

  let server: Server | undefined;
  let boundPort = 0;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const match = router.match(request.method ?? 'GET', url.pathname);

    if (!match) {
      const code = router.hasPath(url.pathname) ? 405 : 404;
      sendError(
        response,
        code,
        code === 405 ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
        code === 405
          ? 'the endpoint exists but does not accept this method'
          : 'no endpoint matches this path',
      );
      return;
    }

    try {
      await match.handler({ request, response, url, params: match.params });
    } catch (error) {
      // The stack stays in the log; the client gets a structured error only.
      logger.error('request failed', {
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      if (!response.headersSent) {
        sendError(response, 500, 'INTERNAL_ERROR', 'the runtime failed to handle the request');
      } else {
        response.end();
      }
    }
  };

  return {
    services,
    setPolicy(policy: TurnPolicy | undefined): void {
      turns.setPolicy(policy);
    },
    setExtraRoutes(register: (router: Router, services: RuntimeServices) => void): void {
      register(router, services);
    },
    setExtraTools(tools: readonly ToolImpl[]): void {
      extraTools = tools;
    },
    get httpPort(): number {
      return boundPort;
    },
    async listen(port?: number): Promise<number> {
      if (server) return boundPort;
      server = createServer((request, response) => {
        void handleRequest(request, response);
      });

      // `port` overrides the configured port. Tests pass 0 to get a free
      // port from the operating system: a fixed port would make the suite
      // fail whenever the runtime happens to run locally.
      const wanted = port ?? options.config.config.httpPort;

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(wanted, options.config.config.host, () => {
          server?.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : wanted;

      if (writeRuntimeFile) {
        const filePath = runtimeFilePath(env);
        mkdirSync(runtimeStateDir(env), { recursive: true });
        writeFileSync(
          filePath,
          `${JSON.stringify({ pid: process.pid, httpPort: boundPort, startedAt: new Date().toISOString(), version: RUNTIME_VERSION }, null, 2)}\n`,
          'utf8',
        );
      }

      logger.info('runtime listening', { host: options.config.config.host, httpPort: boundPort });
      return boundPort;
    },
    async close(): Promise<void> {
      if (!server) return;
      const closing = server;
      server = undefined;
      // SSE streams keep their connections open on purpose; a shutdown must
      // not wait for them.
      closing.closeAllConnections();
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
      });
      boundPort = 0;
      if (writeRuntimeFile) {
        rmSync(runtimeFilePath(env), { force: true });
      }
    },
  };
}
