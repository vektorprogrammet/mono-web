/**
 * Route classification for the requests that journey recorders observe.
 *
 * A recorder asks whether a request path addresses a route, never whether the path contains a
 * substring. A path carries opaque values, such as a random session identifier or the content
 * hash in a built file name, and a substring test reads such a value as a route name at random.
 * `legacyRoutes` is the one list of legacy routes; a journey adds its own routes to it.
 */

/** The segments of a path; React Router's single-fetch request `<path>.data` addresses `<path>`. */
const routeSegments = (path: string): ReadonlyArray<string> =>
  path
    .replace(/\.data$/u, "")
    .split("/")
    .filter((segment) => segment !== "");

/**
 * Whether a request path addresses a route: the route's segments appear in the path whole and
 * consecutive, at any depth. `/mock/api` addresses `/mock/api/users` and `/app/mock/api/data.ts`
 * but not `/mock/apis`, so an opaque segment never matches a route segment by chance.
 */
export const addressesRoute = (pathname: string, route: string): boolean => {
  const path = routeSegments(pathname);
  const target = routeSegments(route);

  return path.some((_, start) =>
    target.every((segment, offset) => path[start + offset] === segment),
  );
};

/**
 * Whether a request path addresses any of the routes, each matched by whole path segments.
 *
 * @construct request-ledger
 */
export const addressesAnyRoute = (pathname: string, routes: ReadonlyArray<string>): boolean =>
  routes.some((route) => addressesRoute(pathname, route));

/**
 * Routes of the legacy system that no native journey addresses: the Symfony application's
 * control panel, sign-in, recovery, and front controllers (vektorprogrammet `app/config` and
 * `web/`), the removed API Platform server, the former dashboard mock API and fixtures, and the
 * unnamed legacy surfaces that the journeys already refused.
 */
export const legacyRoutes = [
  "/kontrollpanel",
  "/login_check",
  "/sso/login",
  "/resetpassord",
  "/resetsendt",
  "/app.php",
  "/app_dev.php",
  "/app_staging.php",
  "/api/login",
  "/api/me",
  "/api/admin",
  "/api/articles",
  "/api/interview-responses",
  "/mock/api",
  "/fixtures",
  "/symfony",
  "/legacy",
  "/graphql",
];
