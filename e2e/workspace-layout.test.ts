import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repository invariants (docs/architecture.md §3).
 *
 * These are architectural rules, not behaviour tests: they fail when someone
 * breaks a convention that the design documents promise, long before a
 * behavioural test would notice.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

const PACKAGE_NAMES = [
  '@local-agent/protocol',
  '@local-agent/agent-core',
  '@local-agent/agent-tools',
  '@local-agent/agent-extension',
  '@local-agent/local-runtime',
  '@local-agent/local-runtime-v2',
  '@local-agent/cli',
] as const;

const readManifest = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));

const walkSourceFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSourceFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
};

const allSourceFiles = [
  ...walkSourceFiles(join(packagesDir, 'protocol', 'src')),
  ...walkSourceFiles(join(packagesDir, 'agent-core', 'src')),
  ...walkSourceFiles(join(packagesDir, 'agent-tools', 'src')),
  ...walkSourceFiles(join(packagesDir, 'agent-extension', 'src')),
  ...walkSourceFiles(join(packagesDir, 'local-runtime', 'src')),
  ...walkSourceFiles(join(packagesDir, 'local-runtime-v2', 'src')),
  ...walkSourceFiles(join(packagesDir, 'cli', 'src')),
];

describe('package layout', () => {
  it('declares every planned package', () => {
    const declared = readdirSync(packagesDir)
      .filter((entry) => existsSync(join(packagesDir, entry, 'package.json')))
      .map((entry) => (readManifest(entry) as { name: string }).name);
    expect(declared.sort()).toEqual([...PACKAGE_NAMES].sort());
  });

  it('keeps the MIT license and a package version on every manifest', () => {
    for (const dir of readdirSync(packagesDir)) {
      if (!existsSync(join(packagesDir, dir, 'package.json'))) continue;
      const manifest = readManifest(dir) as { name: string; version?: string; license?: string };
      expect(manifest.license, manifest.name).toBe('MIT');
      expect(manifest.version, manifest.name).toBeTruthy();
    }
  });

  it('exposes agent-core through the three planned subpath exports', () => {
    const manifest = readManifest('agent-core') as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './event-bridge',
      './pi-turn-runner',
      './tools',
    ]);
  });
});

describe('naming rules (docs/architecture.md §3)', () => {
  it('never declares a port-style interface', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (/\b(?:interface|type)\s+\w*Port\b/.test(content)) {
        offenders.push(relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no host-ports barrel and no types/ dumping ground', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles) {
      const rel = relative(repoRoot, file);
      if (/(^|\/)host-ports\.ts$/.test(rel)) offenders.push(rel);
      if (/(^|\/)types\//.test(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('type discipline', () => {
  it('contains no explicit any escape in workspace sources', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (/:\s*any\b/.test(content) || /\bas\s+any\b/.test(content) || /\bany\[\]/.test(content)) {
        offenders.push(relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
