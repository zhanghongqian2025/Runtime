import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The web console.
 *
 * A single static page: no framework, no build step for the client, no
 * dependency. It talks to the same HTTP API as the CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Where the page lives, both in the sources and in the build output. */
function pagePath(): string | undefined {
  const candidates = [
    join(here, 'ui', 'index.html'),
    join(here, '..', '..', 'src', 'http', 'ui', 'index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

let cached: string | undefined;

/** The HTML of the console. */
export function consoleHtml(): string | undefined {
  if (cached !== undefined) return cached;
  const path = pagePath();
  if (path === undefined) return undefined;
  cached = readFileSync(path, 'utf8');
  return cached;
}
