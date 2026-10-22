/**
 * Shared version constants.
 *
 * They live in `protocol` so the runtime and the CLI cannot drift apart: the
 * CLI reports the same version the runtime serves on `/v1/version`.
 */

/** Runtime version reported by `/health` and `/v1/version`. */
export const RUNTIME_VERSION = '0.1.0';

/** Wire contract version; bump when the RuntimeEvent shapes change. */
export const PROTOCOL_VERSION = '1';

/** Human readable runtime name. */
export const RUNTIME_NAME = 'local-agent-runtime';
