import type { IncomingMessage, ServerResponse } from 'node:http';
import { match } from 'path-to-regexp';

/**
 * Base URL path for the tunnel registry HTTP API.
 */
export const TUNNEL_REGISTRY_API_BASE_PATH = '/remotexpc/tunnels';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

/**
 * Declarative route: method + path template + optional guard + handler.
 * First matching route wins (define specific paths before `:param` routes).
 */
export interface RouteRecord {
  readonly method: string;
  readonly path: string;
  /** Short label for logging or docs */
  readonly name?: string;
  readonly handler: RouteHandler;
  /** If present, must return true for this route to handle the request */
  readonly guard?: (params: Record<string, string>) => boolean;
}

/**
 * Pathname from {@link IncomingMessage.url} (path + query on the request line).
 */
export function getRequestPathname(req: IncomingMessage): string {
  return new URL(req.url || '/', 'http://localhost').pathname;
}

/**
 * Linear router: tries routes in order until method + path + guard match.
 * Path patterns are compiled with path-to-regexp once at dispatcher creation.
 *
 * Express-style path patterns via [path-to-regexp](https://github.com/pillarjs/path-to-regexp)
 * (`match` / `:param` syntax).
 */
export function createRouteDispatcher(
  routes: readonly RouteRecord[],
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const compiled = compileRoutes(routes);

  return async (req, res) => {
    const pathname = getRequestPathname(req);
    const m = (req.method || 'GET').toUpperCase();
    for (const { route, matcher } of compiled) {
      if (route.method !== m) {
        continue;
      }
      const result = matcher(pathname);
      if (result === false) {
        continue;
      }
      const params = normalizeMatchParams(result.params);
      if (route.guard && !route.guard(params)) {
        continue;
      }
      await route.handler(req, res, params);
      return true;
    }
    return false;
  };
}

type CompiledRoute = {
  route: RouteRecord;
  matcher: ReturnType<typeof match>;
};

function compileRoutes(routes: readonly RouteRecord[]): CompiledRoute[] {
  return routes.map((route) => ({
    route,
    matcher: match(route.path),
  }));
}

function normalizeMatchParams(
  params: Partial<Record<string, string | string[]>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join('/') : value;
  }
  return out;
}
