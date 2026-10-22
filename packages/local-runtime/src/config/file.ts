import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RuntimeConfigSchema, type RuntimeConfig } from './schema.js';

/**
 * The configuration file.
 *
 * The file holds the **settings**, never the keys: a provider stores the name
 * of the environment variable that holds its key, and the key itself is
 * resolved into memory at startup (docs/state-ownership.md F14, F15).
 *
 * Precedence: defaults < file < environment.
 */

export const CONFIG_FILE_NAMES = ['config.yaml', 'config.yml', 'config.json'] as const;

export interface ConfigFileOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the config directory. */
  readonly configDir?: string;
}

/** The directory that holds the configuration. */
export function configDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const base = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'local-agent');
}

/** The path of the configuration file, if it exists. */
export function findConfigFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const directory = configDir(env);
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const FileConfigSchema = RuntimeConfigSchema.partial();

/**
 * Read the configuration file.
 *
 * Returns `undefined` when the file is absent, and throws a readable error
 * when it exists but does not match the schema: a broken configuration must
 * not be silently ignored.
 */
export function readConfigFile(
  options: ConfigFileOptions = {},
): { readonly path: string; readonly config: Partial<RuntimeConfig> } | undefined {
  const env = options.env ?? process.env;
  const path =
    options.configDir === undefined
      ? findConfigFile(env)
      : CONFIG_FILE_NAMES.map((name) => join(options.configDir as string, name)).find(
          (candidate) => existsSync(candidate),
        );
  if (path === undefined) return undefined;

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (error: unknown) {
    throw new Error(
      `the configuration file ${path} could not be parsed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`the configuration file ${path} is invalid: ${issues}`);
  }

  return { path, config: result.data as Partial<RuntimeConfig> };
}

/** Merge the file configuration with the environment overrides. */
export function mergeConfig(
  fileConfig: Partial<RuntimeConfig> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): RuntimeConfig {
  const base = RuntimeConfigSchema.parse(fileConfig ?? {});

  const overrides: Partial<RuntimeConfig> = {};

  const host = env['LOCAL_AGENT_HOST'];
  if (host !== undefined && host.length > 0) overrides.host = host;

  const port = env['LOCAL_AGENT_HTTP_PORT'];
  if (port !== undefined && port.length > 0) {
    const parsed = Number.parseInt(port, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      overrides.httpPort = parsed;
    }
  }

  const mode = env['LOCAL_AGENT_PERMISSION_MODE'];
  if (mode !== undefined && mode.length > 0) {
    const parsedMode = z.enum(['ask', 'auto', 'full-access']).safeParse(mode);
    if (parsedMode.success) overrides.permissionMode = parsedMode.data;
  }

  return RuntimeConfigSchema.parse({ ...base, ...overrides });
}
