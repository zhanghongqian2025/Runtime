import type { RiskLevel } from '@local-agent/protocol';
import type { PermissionDecision } from '@local-agent/agent-core/tools';
import { classifyCommand } from './commands.js';
import { isCredentialPath, isSystemPath } from './normalize.js';
import type { DecideOptions, NormalizedCall, SessionRule } from './types.js';

/**
 * The permission policy.
 *
 * A pure function: the same call, mode and rules always produce the same
 * outcome. It never executes anything and it never logs.
 *
 * See docs/contracts.md §5.2.
 */

/** The baseline risk of a tool, before the arguments are inspected. */
export const TOOL_RISK: Readonly<Record<string, RiskLevel>> = {
  read: 'low',
  grep: 'low',
  glob: 'low',
  write: 'medium',
  edit: 'medium',
  apply_patch: 'medium',
  bash: 'high',
  todo_write: 'none',
  ask_user: 'none',
};

export interface Hazard {
  readonly rule: string;
  readonly reason: string;
  readonly risk: RiskLevel;
}

/** The dangerous categories, whatever the mode. */
export function detectHazard(call: NormalizedCall): Hazard | undefined {
  if (call.outsideWorkspace === true) {
    return {
      rule: 'outside-workspace',
      reason: 'the call reaches outside the workspace',
      risk: 'critical',
    };
  }

  if (call.path !== undefined) {
    if (isCredentialPath(call.path)) {
      return {
        rule: 'credential-access',
        reason: 'the call touches a credential store',
        risk: 'critical',
      };
    }
    if (isSystemPath(call.path)) {
      return {
        rule: 'system-configuration',
        reason: 'the call touches a system or shell configuration file',
        risk: 'critical',
      };
    }
  }

  if (call.command !== undefined) {
    const verdict = classifyCommand(call.command);
    if (verdict.safety === 'dangerous') {
      return {
        rule: verdict.rule ?? 'dangerous-command',
        reason: verdict.reason,
        risk: 'critical',
      };
    }
  }

  return undefined;
}

/**
 * The risk of a call once its arguments are taken into account.
 *
 * A tool the host registered wins over the built-in table; a tool nobody
 * registered has **no** risk, which makes the decision a deny.
 */
export function riskOf(
  call: NormalizedCall,
  toolRisks?: ReadonlyMap<string, RiskLevel>,
): RiskLevel | undefined {
  const registered = toolRisks?.get(call.toolName);
  if (registered !== undefined) return registered;
  if (!(call.toolName in TOOL_RISK)) return undefined;
  return baseRiskOf(call);
}

/** The risk of a call, defaulting to the medium risk for an unknown tool. */
function baseRiskOf(call: NormalizedCall): RiskLevel {
  if (call.toolName === 'bash') {
    const verdict = classifyCommand(call.command ?? '');
    if (verdict.safety === 'dangerous') return 'critical';
    if (verdict.safety === 'safe') return 'low';
    return 'high';
  }
  return TOOL_RISK[call.toolName] ?? 'medium';
}

/** Find the session rule that covers the call. */
export function matchSessionRule(
  call: NormalizedCall,
  rules: readonly SessionRule[],
): SessionRule | undefined {
  return rules.find((rule) => {
    if (rule.toolName !== call.toolName) return false;
    if (rule.commandPrefix === undefined) return true;
    const command = (call.command ?? '').trim();
    return command === rule.commandPrefix || command.startsWith(`${rule.commandPrefix} `);
  });
}

/**
 * Decide what happens to a tool call.
 *
 * The order matters: a dangerous category is resolved first, then the
 * session rules, then the mode matrix.
 */
export function decidePermission(
  call: NormalizedCall,
  options: DecideOptions,
): PermissionDecision {
  const hazard = detectHazard(call);

  if (hazard) {
    // Even in full-access mode a dangerous category needs a human.
    if (options.mode === 'full-access') {
      return {
        outcome: 'ask',
        reason: `${hazard.reason}; this category always needs a human decision`,
        risk: hazard.risk,
        matchedRule: hazard.rule,
      };
    }
    return {
      outcome: 'deny',
      reason: `${hazard.reason}; the call was denied by the "${hazard.rule}" rule`,
      risk: hazard.risk,
      matchedRule: hazard.rule,
    };
  }

  const rule = matchSessionRule(call, options.sessionRules);
  if (rule) {
    return {
      outcome: 'allow',
      reason: `allowed by the session rule "${rule.description}"`,
      risk: riskOf(call, options.toolRisks) ?? 'medium',
      matchedRule: rule.description,
    };
  }

  const risk = riskOf(call, options.toolRisks);
  if (risk === undefined) {
    // A tool the policy does not know is never approved.
    return {
      outcome: 'deny',
      reason: `the tool "${call.toolName}" is not covered by the permission policy`,
      risk: 'critical',
    };
  }

  switch (options.mode) {
    case 'ask':
      if (risk === 'none') {
        return { outcome: 'allow', reason: 'the tool has no side effect', risk };
      }
      return {
        outcome: 'ask',
        reason: `the tool has a "${risk}" risk and the session is in ask mode`,
        risk,
      };

    case 'auto':
      if (risk === 'none' || risk === 'low') {
        return { outcome: 'allow', reason: `the tool has a "${risk}" risk`, risk };
      }
      if (risk === 'medium') {
        return {
          outcome: 'ask',
          reason: 'the tool changes the workspace and no session rule covers it',
          risk,
        };
      }
      return {
        outcome: 'deny',
        reason: `the tool has a "${risk}" risk and its safety cannot be proven`,
        risk,
      };

    case 'full-access':
      return {
        outcome: 'allow',
        reason: 'full access mode is enabled',
        risk,
      };

    default:
      return {
        outcome: 'deny',
        reason: 'the permission mode is not known',
        risk: 'critical',
      };
  }
}
