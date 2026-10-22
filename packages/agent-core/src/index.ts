/**
 * @local-agent/agent-core
 *
 * Pure agent loop core. The public surface is published through three
 * subpath exports so a consumer can depend on the protocol layer without
 * pulling in the loop:
 *
 * - `@local-agent/agent-core/tools`
 * - `@local-agent/agent-core/event-bridge`
 * - `@local-agent/agent-core/pi-turn-runner`
 */
export * from './event-bridge/index.js';
export * from './pi-turn-runner/index.js';
export * from './tools/index.js';
