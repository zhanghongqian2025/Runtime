import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Dependency-direction rules (see docs/architecture.md §2.2).
 *
 * `no-restricted-imports` is used instead of eslint-plugin-import so the
 * workspace keeps a single lint dependency; the package.json edge check lives
 * in scripts/check-deps.mjs.
 */
const banned = (names, message) =>
  names.map((name) => ({ name, message }));

const coreMustNotUse = [
  '@local-agent/local-runtime',
  '@local-agent/local-runtime-v2',
  '@local-agent/agent-tools',
  '@local-agent/agent-extension',
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
      'prefer-const': 'error',
    },
  },
  {
    // protocol is the root of the dependency graph: it must not import siblings.
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@local-agent/*'], message: 'protocol must not depend on any workspace package.' },
        ],
      }],
    },
  },
  {
    // agent-core owns the pure loop: no host, no tool implementations.
    files: ['packages/agent-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: banned(coreMustNotUse, 'agent-core must not depend on host or implementation packages.'),
        patterns: [
          { group: ['@local-agent/local-runtime*'], message: 'agent-core must not depend on the host runtime.' },
        ],
      }],
    },
  },
  {
    // Protocol layer and bridge layer must not reach back into the loop core.
    files: ['packages/agent-core/src/tools/**/*.ts', 'packages/agent-core/src/event-bridge/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/pi-turn-runner/**', '../pi-turn-runner/*'], message: 'tools/event-bridge must not depend on pi-turn-runner.' },
        ],
      }],
    },
  },
  {
    // Lower layers must not import the layers above them.
    files: ['packages/agent-tools/src/**/*.ts', 'packages/agent-extension/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: banned(
          ['@local-agent/local-runtime', '@local-agent/local-runtime-v2'],
          'Implementation packages must not depend on the host runtime.',
        ),
        patterns: [
          { group: ['@local-agent/local-runtime*'], message: 'Implementation packages must not depend on the host runtime.' },
        ],
      }],
    },
  },
  {
    // The CLI is an HTTP client only.
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: banned(
          ['@local-agent/local-runtime', '@local-agent/local-runtime-v2', '@local-agent/agent-tools', '@local-agent/agent-extension'],
          'The CLI drives the runtime over HTTP; it must not import it in-process.',
        ),
        patterns: [
          { group: ['@local-agent/agent-core*'], message: 'The CLI talks to the runtime over HTTP; it must not import the core.' },
        ],
      }],
    },
  },
  {
    // Tool implementations depend on the tool protocol layer only.
    files: ['packages/agent-tools/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: banned(
          ['@local-agent/agent-core'],
          'Import the tool protocol layer through @local-agent/agent-core/tools.',
        ),
        patterns: [
          { group: ['@local-agent/agent-core/pi-turn-runner*', '@local-agent/agent-core/event-bridge*'], message: 'Tool implementations must not depend on the loop or the event bridge.' },
        ],
      }],
    },
  },
  {
    // Extensions may use the loop and the tool protocol, but not the host.
    files: ['packages/agent-extension/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@local-agent/local-runtime*'], message: 'Extensions must not depend on the host runtime.' },
        ],
      }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
