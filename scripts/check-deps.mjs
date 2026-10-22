#!/usr/bin/env node
/**
 * Dependency-direction check (docs/architecture.md §2.2).
 *
 * Reads every workspace package manifest and asserts that the declared
 * workspace dependency edges stay inside the allow-list, and that the graph
 * stays acyclic. package.json is the source of truth: a type-only import
 * creates no runtime edge, so lint alone cannot prove this.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Allowed workspace dependency edges: package -> allowed workspace packages. */
const ALLOWED = {
  '@local-agent/protocol': [],
  '@local-agent/agent-core': ['@local-agent/protocol'],
  '@local-agent/agent-tools': ['@local-agent/protocol', '@local-agent/agent-core'],
  '@local-agent/agent-extension': ['@local-agent/protocol', '@local-agent/agent-core'],
  '@local-agent/local-runtime': ['@local-agent/protocol', '@local-agent/agent-core', '@local-agent/agent-tools'],
  '@local-agent/local-runtime-v2': [
    '@local-agent/protocol',
    '@local-agent/agent-core',
    '@local-agent/agent-tools',
    '@local-agent/agent-extension',
    '@local-agent/local-runtime',
  ],
  '@local-agent/cli': ['@local-agent/protocol'],
};

const packagesDir = join(root, 'packages');
const manifests = readdirSync(packagesDir)
  .map((dir) => join(packagesDir, dir))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));

const failures = [];
const edges = [];

for (const manifest of manifests) {
  const name = manifest.name;
  const allowed = ALLOWED[name];
  if (!allowed) {
    failures.push(`unknown package "${name}" — add it to the allow-list in scripts/check-deps.mjs`);
    continue;
  }
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dep of Object.keys(declared)) {
    if (!dep.startsWith('@local-agent/')) continue;
    if (!allowed.includes(dep)) {
      failures.push(`${name} must not depend on ${dep} (allowed: ${allowed.join(', ') || 'none'})`);
    } else {
      edges.push([name, dep]);
    }
  }
}

// Cycle detection over the workspace edge set.
const adjacency = new Map();
for (const [from, to] of edges) {
  adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
}
const state = new Map();
const visit = (node, trail) => {
  const current = state.get(node);
  if (current === 'done') return;
  if (current === 'visiting') {
    failures.push(`dependency cycle detected: ${[...trail, node].join(' -> ')}`);
    return;
  }
  state.set(node, 'visiting');
  for (const next of adjacency.get(node) ?? []) visit(next, [...trail, node]);
  state.set(node, 'done');
};
for (const node of adjacency.keys()) visit(node, []);

if (failures.length > 0) {
  console.error('dependency check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`dependency check passed (${manifests.length} packages, ${edges.length} workspace edges)`);
