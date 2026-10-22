import type { RiskLevel } from '@local-agent/protocol';

/**
 * Permission types.
 *
 * The policy is a **pure decision**: the same tool, the same normalized
 * arguments, the same mode and the same session rules always produce the
 * same outcome. Nothing here executes anything.
 */

/** A rule granted for the duration of a session. */
export interface SessionRule {
  readonly id: string;
  readonly description: string;
  readonly toolName: string;
  /** When set, the rule only covers commands that start with this prefix. */
  readonly commandPrefix?: string;
}

/** The normalized view of a tool call the decision is based on. */
export interface NormalizedCall {
  readonly toolName: string;
  /** The arguments, with paths made relative to the workspace. */
  readonly input: unknown;
  /** The shell command, for command tools. */
  readonly command?: string;
  /** The resolved path, for file tools. */
  readonly path?: string;
  /** True when the path leaves the workspace. */
  readonly outsideWorkspace?: boolean;
}

/** Options of a decision. */
export interface DecideOptions {
  readonly mode: 'ask' | 'auto' | 'full-access';
  readonly sessionRules: readonly SessionRule[];
  readonly cwd: string;
  /** 宿主注册的工具及其风险等级（目标工具等）；未注册的工具一律拒绝。 */
  readonly toolRisks?: ReadonlyMap<string, RiskLevel>;
}
