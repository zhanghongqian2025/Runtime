import type { LoadedRuntimeConfig } from '../config/types.js';
import { createAnthropicMessagesAdapter } from './anthropic-messages.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter } from './types.js';

/**
 * Provider adapters.
 *
 * Every adapter implements the `StreamFn` contract the loop consumes. The
 * provider's own retry is always disabled so the framework budget and the
 * SDK budget cannot stack up.
 */
export * from './anthropic-messages.js';
export * from './errors.js';
export * from './fake.js';
export * from './messages.js';
export * from './openai-compatible.js';
export * from './retry.js';
export * from './sse.js';
export * from './timeout.js';
export * from './types.js';

/**
 * Build the adapter described by the runtime configuration.
 *
 * Returns `undefined` when no provider is configured or when the key is
 * missing: the runtime still starts, but a turn cannot run.
 */
export function createProviderFromConfig(
  loaded: LoadedRuntimeConfig,
): ProviderAdapter | undefined {
  const provider = loaded.config.providers[0];
  if (!provider) return undefined;

  const apiKey = loaded.secrets.get(provider.apiKeyEnvVar);
  if (!apiKey) return undefined;

  if (provider.id === 'openai-compatible') {
    return createOpenAiCompatibleAdapter({
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.model,
      maxOutputTokens: provider.maxOutputTokens,
    });
  }

  return createAnthropicMessagesAdapter({
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.model,
    maxOutputTokens: provider.maxOutputTokens,
  });
}
