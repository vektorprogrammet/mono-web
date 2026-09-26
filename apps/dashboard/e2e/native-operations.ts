/**
 * The native surface that a dashboard-to-backend recorder allows, derived from the HTTP contract.
 *
 * A request is native when it fills an operation's path template segment by segment, so a random
 * value in a path parameter never changes the answer. Use it to prove that a journey sends no
 * legacy, provider, recovery, or token request, rather than listing such routes by name.
 */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { OpenApi } from "effect/unstable/httpapi";

const httpMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const pathParameter = /\{[^{}]+\}/u;

/**
 * Whether a path segment fills a template segment. A parameter, as in `{sessionId}` or
 * `{receiptId}:approve`, holds the rest of one whole segment; the literal text around it must match.
 */
const fillsSegment = (template: string, segment: string): boolean => {
  const parameter = pathParameter.exec(template);

  if (parameter === null) return template === segment;

  const prefix = template.slice(0, parameter.index);
  const suffix = template.slice(parameter.index + parameter[0].length);

  return (
    segment.length > prefix.length + suffix.length &&
    segment.startsWith(prefix) &&
    segment.endsWith(suffix)
  );
};

/** Each operation of the native HTTP contract: its method and its path template's segments. */
const nativeOperations = Object.entries(OpenApi.fromApi(ExternalNativeApi).paths).flatMap(
  ([template, pathItem]) =>
    httpMethods.flatMap((method) =>
      pathItem[method] === undefined
        ? []
        : [{ method: method.toUpperCase(), segments: template.split("/") }],
    ),
);

/**
 * Whether a request is an operation of the native HTTP contract. A random value that fills a
 * path parameter, such as a session identifier, never changes the answer.
 */
export const isNativeOperation = (method: string, pathname: string): boolean => {
  const segments = pathname.split("/");

  return nativeOperations.some(
    (operation) =>
      operation.method === method &&
      operation.segments.length === segments.length &&
      operation.segments.every((template, index) => fillsSegment(template, segments[index] ?? "")),
  );
};

/** The identity engine's email-password routes, which native journeys call beside the contract. */
const identityEngineRequests = {
  "POST /api/auth/sign-in/email": true,
  "POST /api/auth/sign-up/email": true,
  "GET /api/auth/get-session": true,
} satisfies Readonly<Record<string, true>>;

/**
 * Whether a dashboard-to-backend request stays on the native surface: an operation of the
 * native HTTP contract or an email-password route of the identity engine.
 *
 * @remarks
 * The operations come from the OpenAPI document of `ExternalNativeApi`, each a method and a path
 * template. A request is one of them when `method`, in upper case, is the operation's and
 * `pathname` fills the template segment by segment: a parameter such as `{sessionId}` or
 * `{receiptId}:approve` holds the rest of one whole segment, and the literal text around it must
 * match, so a random value in a parameter never changes the answer. Beside the contract, only
 * `POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, and
 * `GET /api/auth/get-session` are native. Every other request, such as a legacy API call or a
 * provider, recovery, or token route, leaves the surface.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * proxy.records.filter(({ method, pathname }) => !isNativeRequest(method, pathname));
 * ```
 *
 * @avoid A recorder that lists the forbidden routes by name, or tests a path for a substring: a
 * new legacy or provider route passes the list, and an opaque value in a path matches a route
 * name by chance. Ask `isNativeRequest` whether the request stays on the native surface.
 *
 * @construct request-ledger
 */
export const isNativeRequest = (method: string, pathname: string): boolean =>
  isNativeOperation(method, pathname) ||
  Object.hasOwn(identityEngineRequests, `${method} ${pathname}`);
