/**
 * @local-agent/protocol
 *
 * Authoritative message and event contracts. This package owns the zod
 * schemas and the inferred types that cross package boundaries; everything
 * else in the workspace depends on it and never the other way round.
 */
export * from './agent-event.js';
export * from './ids.js';
export * from './interaction.js';
export * from './message.js';
export * from './permission.js';
export * from './runtime-event.js';
export * from './version.js';
