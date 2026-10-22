#!/usr/bin/env node
import { homedir } from 'node:os';
import { loadRuntimeConfig } from '@local-agent/local-runtime';
import { createLogger } from '@local-agent/local-runtime';
import { createApplication } from './app.js';

/**
 * The application entry point.
 *
 * This is the binary the user runs: the host runtime plus the application
 * layer (the plan mode today, the goal mode from M6).
 */
async function main(): Promise<void> {
  const logger = createLogger({ homeDir: homedir() });
  const loaded = loadRuntimeConfig();
  const application = createApplication({ config: loaded, logger });

  const port = await application.listen();
  process.stdout.write(
    `local-agent-runtime listening on http://${loaded.config.host}:${port}\n`,
  );

  const shutdown = (): void => {
    void application.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `failed to start runtime: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
