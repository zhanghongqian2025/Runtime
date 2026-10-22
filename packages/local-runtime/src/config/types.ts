import { mergeConfig, readConfigFile } from './file.js';
import type { ProviderId, RuntimeConfig } from './schema.js';

export * from './schema.js';

/**
 * Runtime configuration.
 *
 * The config file and the environment never contain a secret value: a
 * provider stores the *name* of the environment variable that holds its key.
 * Keys are resolved into memory at startup and are never persisted, logged or
 * echoed (docs/state-ownership.md F14, F15).
 */

export interface LoadedRuntimeConfig {
  readonly config: RuntimeConfig;
  /** Resolved keys. Memory only: never persisted, logged or returned. */
  readonly secrets: ReadonlyMap<string, string>;
}

/**
 * Load the configuration: defaults, then the configuration file, then the
 * environment.
 *
 * An unparsable environment override falls back to the safe default instead
 * of failing the process: an invalid permission mode must never widen access.
 * A broken *file*, on the other hand, is a configuration error and is
 * reported.
 */
export interface LoadConfigOptions {
  /** Read the configuration file. The tests turn it off to stay hermetic. */
  readonly readFile?: boolean;
}

export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadConfigOptions = {},
): LoadedRuntimeConfig {
  const file = options.readFile === false ? undefined : readConfigFile({ env });
  const config = mergeConfig(file?.config, env);

  const secrets = new Map<string, string>();
  for (const provider of config.providers) {
    const value = env[provider.apiKeyEnvVar];
    if (value !== undefined && value.length > 0) {
      secrets.set(provider.apiKeyEnvVar, value);
    }
  }

  return { config, secrets };
}

/** A provider as it is safe to expose over HTTP. */
export interface ProviderConfigView {
  readonly id: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly apiKeyEnvVar: string;
  /** Whether a key is configured. The value itself is never exposed. */
  readonly apiKeyConfigured: boolean;
}

/** The configuration as it is safe to expose over HTTP. */
export interface RuntimeConfigView {
  readonly host: string;
  readonly httpPort: number;
  readonly permissionMode: string;
  readonly providers: readonly ProviderConfigView[];
  readonly events: { readonly retainCount: number };
  readonly tools: {
    readonly maxResultBytes: number;
    readonly maxCallBytes: number;
    readonly maxLines: number;
  };
}

/** Project the configuration into its redacted, client-facing view. */
export function toConfigView(loaded: LoadedRuntimeConfig): RuntimeConfigView {
  const { config, secrets } = loaded;
  return {
    host: config.host,
    httpPort: config.httpPort,
    permissionMode: config.permissionMode,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      contextWindowTokens: provider.contextWindowTokens,
      maxOutputTokens: provider.maxOutputTokens,
      apiKeyEnvVar: provider.apiKeyEnvVar,
      apiKeyConfigured: secrets.has(provider.apiKeyEnvVar),
    })),
    events: { retainCount: config.events.retainCount },
    tools: { ...config.tools },
  };
}
