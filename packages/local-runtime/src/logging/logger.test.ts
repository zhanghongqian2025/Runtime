import { describe, expect, it } from 'vitest';
import { createLogger, redactText, redactValue } from './logger.js';

describe('redaction', () => {
  it('masks credential-shaped text', () => {
    expect(redactText('key is sk-abcdefghijklmnopqrstuvwx')).toBe('key is ***');
    expect(redactText('token ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe('token ***');
    expect(redactText('id AKIAIOSFODNN7EXAMPLE')).toBe('id ***');
  });

  it('masks credentials nested in a value', () => {
    const redacted = redactValue({
      provider: { apiKey: 'sk-abcdefghijklmnopqrstuvwx' },
      list: ['Bearer abcdefghijklmnopqrstuvwxyz'],
    }) as { provider: { apiKey: string }; list: string[] };
    expect(redacted.provider.apiKey).toBe('***');
    expect(redacted.list[0]).toBe('***');
  });

  it('leaves harmless values alone', () => {
    expect(redactValue({ count: 3, ok: true, tag: 'read' })).toEqual({
      count: 3,
      ok: true,
      tag: 'read',
    });
  });
});

describe('logger', () => {
  it('writes one JSON object per line', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.info('runtime listening', { httpPort: 1234 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { level: string; msg: string; httpPort: number };
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('runtime listening');
    expect(parsed.httpPort).toBe(1234);
  });

  it('drops entries below the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line) });
    logger.debug('noise');
    logger.info('noise');
    logger.warn('signal');
    expect(lines).toHaveLength(1);
  });

  it('redacts credentials before they reach the sink', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.info('calling provider', { apiKey: 'sk-abcdefghijklmnopqrstuvwx' });
    expect(lines[0]).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(lines[0]).toContain('***');
  });

  it('collapses the home directory in paths', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      sink: (line) => lines.push(line),
      homeDir: '/Users/example',
    });
    logger.info('reading file', { path: '/Users/example/.ssh/id_rsa' });
    expect(lines[0]).toContain('~/.ssh/id_rsa');
    expect(lines[0]).not.toContain('/Users/example');
  });
});
