import type { DEFAULT_PROVIDER_TIMEOUTS, StreamFn } from '@local-agent/agent-core/pi-turn-runner';

/**
 * Provider adapter contracts.
 *
 * The adapter is the host side of the `StreamFn` contract that the loop
 * consumes (docs/decisions.md D-003). The loop never learns which provider
 * it is talking to.
 */

export type ProviderTimeouts = typeof DEFAULT_PROVIDER_TIMEOUTS;

export interface ProviderAdapter {
  readonly id: 'openai-compatible' | 'anthropic-messages';
  /** The stream function the loop calls. */
  readonly stream: StreamFn;
}
