/**
 * Command safety.
 *
 * A command is only auto-approved when its safety is **provable from the
 * literal text**: a known command, no shell metacharacter, and no dangerous
 * pattern. Everything else is unsafe, and the dangerous ones are denied.
 *
 * See docs/contracts.md §5.3 and docs/decisions.md D-008.
 */

export type CommandSafety = 'safe' | 'unsafe' | 'dangerous';

export interface CommandVerdict {
  readonly safety: CommandSafety;
  readonly reason: string;
  /** The rule that matched, for the approval card. */
  readonly rule?: string;
  /** The command prefix, when a white-listed command was recognised. */
  readonly prefix?: string;
}

/** Shell metacharacters: their presence makes a command unprovable. */
export const SHELL_METACHARACTERS = [';', '|', '&', '$', '`', '>', '<', '(', ')', '{', '}', '\n', '\r', '`'];

/** Commands that are safe to run without asking. */
export const SAFE_COMMANDS: readonly string[] = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'printf',
  'wc',
  'head',
  'tail',
  'grep',
  'find',
  'sort',
  'uniq',
  'diff',
  'file',
  'stat',
  'du',
  'df',
  'date',
  'whoami',
  'which',
  'basename',
  'dirname',
  'true',
  'false',
  'node --version',
  'pnpm --version',
  'npm --version',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
];

/** Patterns that are never safe, whatever the mode. */
export interface DangerousPattern {
  readonly rule: string;
  readonly reason: string;
  readonly pattern: RegExp;
}

export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  {
    rule: 'delete-root',
    reason: 'the command deletes the filesystem root',
    pattern: /\brm\b[^\n]*\s-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b[^\n]*\s(?:\/|~|\/\*)(?:\s|$)/,
  },
  {
    rule: 'pipe-to-shell',
    reason: 'the command pipes a download straight into a shell',
    pattern: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|da|)sh\b|\b(?:curl|wget)\b[^\n]*\|\s*python\d?\b/,
  },
  {
    rule: 'privilege-escalation',
    reason: 'the command escalates privileges',
    pattern: /(?:^|[\s;&|])sudo\b|\bdoas\b|\bsu\s+-\b/,
  },
  {
    rule: 'remote-push',
    reason: 'the command pushes to a remote repository',
    pattern: /\bgit\b[^\n]*\bpush\b/,
  },
  {
    rule: 'package-publish',
    reason: 'the command publishes a package',
    pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/,
  },
  {
    rule: 'world-writable',
    reason: 'the command makes a path world writable',
    pattern: /\bchmod\b[^\n]*\b777\b/,
  },
  {
    rule: 'raw-disk-write',
    reason: 'the command writes to a raw device',
    pattern: /\bdd\b[^\n]*\bof=\/dev\//,
  },
  {
    rule: 'filesystem-format',
    reason: 'the command formats a filesystem',
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b|\bfdisk\b|\bdiskutil\b[^\n]*erase/,
  },
  {
    rule: 'fork-bomb',
    reason: 'the command is a fork bomb',
    pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/,
  },
  {
    rule: 'host-shutdown',
    reason: 'the command shuts the host down',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/,
  },
  {
    rule: 'system-kill',
    reason: 'the command kills every process',
    pattern: /\bkill\b[^\n]*\s-9\s+-1\b/,
  },
  {
    rule: 'history-rewrite',
    reason: 'the command rewrites the shell history',
    pattern: /\bhistory\s+-c\b|\b(?:>|>>)\s*[^\n]*\.(?:bash|zsh)_history\b/,
  },
];

/** Commands that reach the network. */
const NETWORK_COMMANDS = ['curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp', 'sftp', 'scp', 'rsync'];

const hasMetacharacter = (command: string): boolean =>
  SHELL_METACHARACTERS.some((character) => command.includes(character));

/** The longest white-listed prefix the command starts with. */
export function safePrefixOf(command: string): string | undefined {
  const trimmed = command.trim();
  const candidates = SAFE_COMMANDS.filter((entry) => {
    if (entry.includes(' ')) return trimmed === entry || trimmed.startsWith(`${entry} `);
    return trimmed === entry || trimmed.startsWith(`${entry} `);
  });
  if (candidates.length === 0) return undefined;
  return candidates.sort((left, right) => right.length - left.length)[0];
}

const isNetworkCommand = (command: string): boolean => {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return NETWORK_COMMANDS.includes(base);
};

/** Classify a command. Pure and deterministic. */
export function classifyCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { safety: 'unsafe', reason: 'the command is empty', rule: 'empty-command' };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.pattern.test(trimmed)) {
      return { safety: 'dangerous', reason: pattern.reason, rule: pattern.rule };
    }
  }

  if (isNetworkCommand(trimmed)) {
    return {
      safety: 'unsafe',
      reason: 'the command reaches the network',
      rule: 'network-egress',
    };
  }

  if (hasMetacharacter(trimmed)) {
    return {
      safety: 'unsafe',
      reason: 'the command contains shell metacharacters, so its effect is not provable',
      rule: 'shell-metacharacters',
    };
  }

  const prefix = safePrefixOf(trimmed);
  if (prefix === undefined) {
    return {
      safety: 'unsafe',
      reason: 'the command is not on the list of commands that can be proven safe',
      rule: 'unknown-command',
    };
  }

  return {
    safety: 'safe',
    reason: `the command is a read-only "${prefix}" command`,
    prefix,
  };
}
