import { existsSync, readFileSync, statSync } from 'node:fs';
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

let cached: { readonly mtimeMs: number; readonly html: string } | undefined;

/**
 * The HTML of the console.
 *
 * The file is read once and then cached by its modification time: a running
 * runtime must pick up an edited page without a restart, and the page is
 * read often enough that re-reading it every time would be wasteful.
 */
export function consoleHtml(): string | undefined {
  const path = pagePath();
  if (path === undefined) return undefined;

  const mtimeMs = statSync(path).mtimeMs;
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.html;

  const html = readFileSync(path, 'utf8');
  cached = { mtimeMs, html };
  return html;
}
