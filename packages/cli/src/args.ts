/**
 * A tiny argument parser.
 *
 * The CLI is a thin HTTP client, so it does not need a parser dependency.
 * Supported forms: `--flag`, `--flag=value`, `--flag value`.
 */

export interface ParsedArgs {
  /** The first non-flag argument, if any. */
  readonly command: string | undefined;
  readonly flags: Readonly<Record<string, string>>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
      continue;
    }

    flags[body] = 'true';
  }

  return {
    command: positionals[0],
    flags,
    positionals: positionals.slice(1),
  };
}

/** Read a flag as a positive integer, or `undefined` when it is absent/invalid. */
export function readIntegerFlag(
  flags: Readonly<Record<string, string>>,
  name: string,
): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}
