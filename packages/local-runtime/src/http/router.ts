import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A very small router.
 *
 * The runtime exposes about twenty endpoints, so a framework would add more
 * moving parts than it removes (docs/decisions.md D-006). Paths support one
 * kind of parameter: `:name`.
 */

export interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Readonly<Record<string, string>>;
}

export interface Router {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  match(method: string, pathname: string): RouteMatch | undefined;
  /** True when the path exists under a different method. */
  hasPath(pathname: string): boolean;
}

interface CompiledRoute {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

const splitPath = (path: string): string[] =>
  path.split('/').filter((segment) => segment.length > 0);

const matchSegments = (
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined => {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const patternSegment = pattern[index] as string;
    const actualSegment = actual[index] as string;
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(actualSegment);
      continue;
    }
    if (patternSegment !== actualSegment) return undefined;
  }
  return params;
};

export function createRouter(): Router {
  const routes: CompiledRoute[] = [];

  const add = (method: string, path: string, handler: RouteHandler): void => {
    routes.push({ method, segments: splitPath(path), handler });
  };

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    delete: (path, handler) => add('DELETE', path, handler),
    match(method, pathname) {
      const actual = splitPath(pathname);
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchSegments(route.segments, actual);
        if (params) return { handler: route.handler, params };
      }
      return undefined;
    },
    hasPath(pathname) {
      const actual = splitPath(pathname);
      return routes.some((route) => matchSegments(route.segments, actual) !== undefined);
    },
  };
}
