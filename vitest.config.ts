import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace packages resolve to source during development; the published
    // surface is the built `dist` output declared in each package.json.
    alias: [
      { find: /^@local-agent\/agent-core\/tools$/, replacement: resolvePath('./packages/agent-core/src/tools/index.ts') },
      { find: /^@local-agent\/agent-core\/event-bridge$/, replacement: resolvePath('./packages/agent-core/src/event-bridge/index.ts') },
      { find: /^@local-agent\/agent-core\/pi-turn-runner$/, replacement: resolvePath('./packages/agent-core/src/pi-turn-runner/index.ts') },
      { find: /^@local-agent\/agent-core$/, replacement: resolvePath('./packages/agent-core/src/index.ts') },
      { find: /^@local-agent\/protocol$/, replacement: resolvePath('./packages/protocol/src/index.ts') },
      { find: /^@local-agent\/agent-tools$/, replacement: resolvePath('./packages/agent-tools/src/index.ts') },
      { find: /^@local-agent\/agent-extension$/, replacement: resolvePath('./packages/agent-extension/src/index.ts') },
      { find: /^@local-agent\/local-runtime$/, replacement: resolvePath('./packages/local-runtime/src/index.ts') },
      { find: /^@local-agent\/local-runtime-v2$/, replacement: resolvePath('./packages/local-runtime-v2/src/index.ts') },
      { find: /^@local-agent\/cli$/, replacement: resolvePath('./packages/cli/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/agent-core/src/**/*.test.ts', 'e2e/**/*.test.ts'],
    passWithNoTests: true,
  },
});
