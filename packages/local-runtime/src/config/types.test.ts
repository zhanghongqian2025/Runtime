import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig, RuntimeConfigSchema, toConfigView } from './types.js';

describe('runtime configuration', () => {
  it('defaults to loopback, an ephemeral port and the safest mode', () => {
    const { config } = loadRuntimeConfig({}, { readFile: false });
    expect(config.host).toBe('127.0.0.1');
    expect(config.httpPort).toBe(0);
    expect(config.permissionMode).toBe('ask');
  });

  it('applies valid environment overrides', () => {
    const { config } = loadRuntimeConfig({
      LOCAL_AGENT_HOST: '127.0.0.1',
      LOCAL_AGENT_HTTP_PORT: '9000',
      LOCAL_AGENT_PERMISSION_MODE: 'auto',
    }, { readFile: false });
    expect(config.httpPort).toBe(9000);
    expect(config.permissionMode).toBe('auto');
  });

  it('falls back to the safe mode when the permission mode is invalid', () => {
    const { config } = loadRuntimeConfig({ LOCAL_AGENT_PERMISSION_MODE: 'yolo' }, { readFile: false });
    expect(config.permissionMode).toBe('ask');
  });

  it('ignores an out-of-range port', () => {
    const { config } = loadRuntimeConfig({ LOCAL_AGENT_HTTP_PORT: '99999' }, { readFile: false });
    expect(config.httpPort).toBe(0);
  });

  it('rejects unknown configuration keys', () => {
    const result = RuntimeConfigSchema.safeParse({ surprise: true });
    expect(result.success).toBe(false);
  });
});

describe('client-facing configuration view', () => {
  it('exposes the key variable name but never the key value', () => {
    const loaded = {
      config: RuntimeConfigSchema.parse({
        providers: [
          {
            id: 'openai-compatible',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnvVar: 'EXAMPLE_KEY',
            model: 'example-model',
            contextWindowTokens: 128000,
            maxOutputTokens: 4096,
          },
        ],
      }),
      secrets: new Map([['EXAMPLE_KEY', 'sk-must-not-leak']]),
    };

    const view = toConfigView(loaded);
    const provider = view.providers[0];
    expect(provider?.apiKeyEnvVar).toBe('EXAMPLE_KEY');
    expect(provider?.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-must-not-leak');
  });

  it('reports a missing key without failing', () => {
    const loaded = {
      config: RuntimeConfigSchema.parse({
        providers: [
          {
            id: 'anthropic-messages',
            baseUrl: 'https://api.example.com',
            apiKeyEnvVar: 'MISSING_KEY',
            model: 'example-model',
            contextWindowTokens: 128000,
            maxOutputTokens: 4096,
          },
        ],
      }),
      secrets: new Map<string, string>(),
    };
    expect(toConfigView(loaded).providers[0]?.apiKeyConfigured).toBe(false);
  });
});
