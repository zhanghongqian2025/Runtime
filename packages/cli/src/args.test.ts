import { describe, expect, it } from 'vitest';
import { parseArgs, readIntegerFlag } from './args.js';

describe('argument parsing', () => {
  it('reads a command and its flags', () => {
    const parsed = parseArgs(['health', '--host', '127.0.0.1', '--port=8787']);
    expect(parsed.command).toBe('health');
    expect(parsed.flags['host']).toBe('127.0.0.1');
    expect(parsed.flags['port']).toBe('8787');
  });

  it('treats a trailing flag as a boolean', () => {
    const parsed = parseArgs(['--version']);
    expect(parsed.flags['version']).toBe('true');
    expect(parsed.command).toBeUndefined();
  });

  it('keeps extra positionals', () => {
    const parsed = parseArgs(['send', 'hello', 'world']);
    expect(parsed.command).toBe('send');
    expect(parsed.positionals).toEqual(['hello', 'world']);
  });

  it('reads integer flags safely', () => {
    expect(readIntegerFlag({ port: '80' }, 'port')).toBe(80);
    expect(readIntegerFlag({ port: 'abc' }, 'port')).toBeUndefined();
    expect(readIntegerFlag({}, 'port')).toBeUndefined();
  });
});
