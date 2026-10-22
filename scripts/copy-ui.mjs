#!/usr/bin/env node
/**
 * Copy the static web console into the build output.
 *
 * `tsc` only emits TypeScript, so the HTML has to be copied by hand.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'packages/local-runtime/src/http/ui/index.html');
const to = join(root, 'packages/local-runtime/dist/http/ui/index.html');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied the web console → ${to.replace(root + '/', '')}`);
