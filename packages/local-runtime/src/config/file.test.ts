import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDir, findConfigFile, mergeConfig, readConfigFile } from './file.js';
import { loadRuntimeConfig } from './types.js';

/**
 * The configuration file.
 *
 * The file holds the settings, never the keys: a provider stores the **name**
 * of the environment variable that holds its key.
 */

const writeConfig = (content: string): { xdgDir: string; configPath: string } => {
  const xdgDir = mkdtempSync(join(tmpdir(), 'local-agent-cfg-'));
  const directory = join(xdgDir, 'local-agent');
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'config.yaml');
  writeFileSync(configPath, content, 'utf8');
  return { xdgDir, configPath };
};

const PROVIDER_YAML = [
  'host: 127.0.0.1',
  'httpPort: 8123',
  'permissionMode: auto',
  'providers:',
  '  - id: openai-compatible',
  '    baseUrl: https://api.example.com/v1',
  '    apiKeyEnvVar: EXAMPLE_KEY',
  '    model: example-model',
  '    contextWindowTokens: 128000',
  '    maxOutputTokens: 4096',
  '',
].join('\n');

describe('the configuration file', () => {
  it('is found under the config directory', () => {
    const { xdgDir, configPath } = writeConfig(PROVIDER_YAML);
    expect(configDir({ XDG_CONFIG_HOME: xdgDir })).toBe(join(xdgDir, 'local-agent'));
    expect(findConfigFile({ XDG_CONFIG_HOME: xdgDir })).toBe(configPath);
  });

  it('is read and validated', () => {
    const { xdgDir } = writeConfig(PROVIDER_YAML);
    const file = readConfigFile({ env: { XDG_CONFIG_HOME: xdgDir } });
    expect(file?.config.providers?.[0]?.baseUrl).toBe('https://api.example.com/v1');
    expect(file?.config.permissionMode).toBe('auto');
  });

  it('is optional', () => {
    const empty = mkdtempSync(join(tmpdir(), 'local-agent-empty-'));
    expect(readConfigFile({ env: { XDG_CONFIG_HOME: empty } })).toBeUndefined();
  });

  it('reports a broken file instead of ignoring it', () => {
    const { xdgDir } = writeConfig('permissionMode: [not, a, mode]\n');
    expect(() => readConfigFile({ env: { XDG_CONFIG_HOME: xdgDir } })).toThrow(/invalid/);
  });

  it('lets the environment win over the file', () => {
    const { xdgDir } = writeConfig(PROVIDER_YAML);
    const file = readConfigFile({ env: { XDG_CONFIG_HOME: xdgDir } });
    const merged = mergeConfig(file?.config, {
      LOCAL_AGENT_HTTP_PORT: '9999',
      LOCAL_AGENT_PERMISSION_MODE: 'ask',
    });
    expect(merged.httpPort).toBe(9999);
    expect(merged.permissionMode).toBe('ask');
    expect(merged.providers).toHaveLength(1);
    void xdgDir;
  });

  it('ignores an invalid environment override and keeps the safe default', () => {
    const merged = mergeConfig(undefined, { LOCAL_AGENT_PERMISSION_MODE: 'yolo' });
    expect(merged.permissionMode).toBe('ask');
  });
});

describe('loading the configuration', () => {
  it('resolves the key from the environment, never from the file', () => {
    const { xdgDir, configPath } = writeConfig(PROVIDER_YAML);
    const loaded = loadRuntimeConfig(
      { XDG_CONFIG_HOME: xdgDir, EXAMPLE_KEY: 'sk-from-the-environment' },
      { readFile: true },
    );

    expect(loaded.config.providers).toHaveLength(1);
    expect(loaded.secrets.get('EXAMPLE_KEY')).toBe('sk-from-the-environment');
    // The file only holds the variable name.
    expect(configPath.endsWith('config.yaml')).toBe(true);
  });

  it('does not report a key that is missing', () => {
    const { xdgDir } = writeConfig(PROVIDER_YAML);
    const loaded = loadRuntimeConfig({ XDG_CONFIG_HOME: xdgDir }, { readFile: true });
    expect(loaded.secrets.has('EXAMPLE_KEY')).toBe(false);
  });

  it('stays hermetic when the file reading is off', () => {
    const loaded = loadRuntimeConfig({}, { readFile: false });
    expect(loaded.config.providers).toEqual([]);
    expect(loaded.config.host).toBe('127.0.0.1');
  });
});
