import type { ToolDefinition } from '../tools/index.js';
import type { TurnHooks } from './hooks.js';

/**
 * The extension contract.
 *
 * An extension contributes hooks, tools and modes. It never owns the
 * environment: the host still provides the storage, the permissions and the
 * provider.
 *
 * See docs/architecture.md §7.
 */

export interface ExtensionMode {
  readonly name: string;
  readonly description: string;
  /** The mode the session takes when the extension is active. */
  readonly interactionMode: 'default' | 'plan';
}

export interface ExtensionManifest {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Hooks the extension contributes. */
  readonly hooks?: Partial<TurnHooks>;
  /** Tools the extension contributes. */
  readonly tools?: readonly ToolDefinition[];
  /** Modes the extension contributes. */
  readonly modes?: readonly ExtensionMode[];
}
