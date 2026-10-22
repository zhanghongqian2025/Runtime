#!/usr/bin/env node
/**
 * Secret hygiene check.
 *
 * Scans tracked files for credential-shaped content and fails when a
 * secrets-bearing file is staged. Keys must never reach the repository, the
 * logs, or the terminal.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Credential shapes that must never appear in tracked files. */
const PATTERNS = [
  { name: 'openai-style key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'github token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'bearer token literal', regex: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
];

const FORBIDDEN_FILES = [/\.env$/, /^\.env\./, /^config\.ya?ml$/, /^config\.local\.ya?ml$/];

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(root);

const failures = [];

for (const file of files) {
  const rel = relative(root, file);
  for (const forbidden of FORBIDDEN_FILES) {
    if (forbidden.test(rel)) failures.push(`${rel} must not be committed (secrets-bearing file)`);
  }
  if (/\.(png|jpg|jpeg|gif|webp|ico|zip|tar|gz|woff2?|ttf)$/i.test(rel)) continue;
  const content = readFileSync(file, 'utf8');
  for (const { name, regex } of PATTERNS) {
    if (regex.test(content)) failures.push(`${rel} contains a possible ${name}`);
  }
}

if (failures.length > 0) {
  console.error('secret check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`secret check passed (${files.length} files scanned)`);
