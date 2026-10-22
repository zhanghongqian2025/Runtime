/**
 * Structured logging with redaction.
 *
 * Logs must never contain key material, full user content or user
 * identifiers (docs/architecture.md §8). Every value that reaches a sink
 * passes through `redactValue` first.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Credential shapes that must never be written to a log or an event. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
];

export const REDACTED = '***';

/** Mask credential-shaped text. */
export function redactText(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/** Collapse the home directory into `~` so absolute paths stay readable. */
export function collapseHomePath(text: string, homeDir: string): string {
  if (homeDir.length === 0) return text;
  return text.split(homeDir).join('~');
}

/** Recursively redact a value before it is logged. */
export function redactValue(value: unknown, homeDir = ''): unknown {
  if (typeof value === 'string') {
    const collapsed = homeDir.length > 0 ? collapseHomePath(value, homeDir) : value;
    return redactText(collapsed);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, homeDir));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(entry, homeDir);
    }
    return output;
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: (line: string) => void;
  readonly homeDir?: string;
}

/** Create a logger that writes one JSON object per line. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const homeDir = options.homeDir ?? '';

  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const payload: Record<string, unknown> = {
      level: entryLevel,
      msg: redactText(message),
      ts: new Date().toISOString(),
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        payload[key] = redactValue(value, homeDir);
      }
    }
    sink(JSON.stringify(payload));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
