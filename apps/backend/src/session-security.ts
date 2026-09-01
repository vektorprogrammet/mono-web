import { randomUUID } from "node:crypto";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { Schema } from "effect";

const Deployment = Schema.Literals(["local", "preview", "production"]);
export type IdentityDeployment = typeof Deployment.Type;

const ExactOrigin = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value);
          return (
            url.origin === value &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            (url.protocol === "http:" || url.protocol === "https:")
          );
        } catch {
          return false;
        }
      },
      { message: "an exact HTTP(S) origin without credentials, path, query, or fragment" },
    ),
  ),
);

const TrustedOriginsJson = Schema.fromJsonString(
  Schema.Array(ExactOrigin).pipe(
    Schema.check(
      Schema.makeFilter((origins) => origins.length > 0 && origins.length <= 16, {
        message: "between one and sixteen exact trusted origins",
      }),
    ),
  ),
);

export interface NativeSessionBoundaryPolicy {
  readonly deployment: IdentityDeployment;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly secureCookies: boolean;
}

const loopbackOrigin = (origin: string): boolean => {
  const hostname = new URL(origin).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
};

/**
 * Decodes the one native session-origin configuration authority. Local,
 * preview, and production compositions must all provide it explicitly.
 */
export const makeNativeSessionBoundaryPolicy = (
  env: Readonly<Record<string, string | undefined>>,
): NativeSessionBoundaryPolicy => {
  if (env.BETTER_AUTH_URL !== undefined || env.BETTER_AUTH_TRUSTED_ORIGINS !== undefined) {
    throw new Error(
      "BETTER_AUTH_URL and BETTER_AUTH_TRUSTED_ORIGINS are unsupported; use the native identity origin policy",
    );
  }
  const deployment = Schema.decodeUnknownSync(Deployment)(env.NATIVE_IDENTITY_DEPLOYMENT);
  const trustedOrigins = Schema.decodeUnknownSync(TrustedOriginsJson)(
    env.NATIVE_IDENTITY_TRUSTED_ORIGINS,
    { onExcessProperty: "error" },
  );
  if (new Set(trustedOrigins).size !== trustedOrigins.length) {
    throw new Error("NATIVE_IDENTITY_TRUSTED_ORIGINS must not contain duplicates");
  }
  if (deployment === "local") {
    if (
      trustedOrigins.length !== 1 ||
      !loopbackOrigin(trustedOrigins[0]!) ||
      new URL(trustedOrigins[0]!).protocol !== "http:"
    ) {
      throw new Error(
        "local native identity composition requires one explicit HTTP loopback origin",
      );
    }
    return { deployment, trustedOrigins, secureCookies: false };
  }
  if (trustedOrigins.some((origin) => new URL(origin).protocol !== "https:")) {
    throw new Error(`${deployment} native identity origins must use HTTPS`);
  }
  return { deployment, trustedOrigins, secureCookies: true };
};

const safeCorrelation = (value: string | null): string =>
  value !== null && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value) ? value : randomUUID();

const safeSourceIp = (request: Request): string | null => {
  const value = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  return value !== null && value.length <= 64 && /^[A-Fa-f0-9.:]+$/u.test(value) ? value : null;
};

const safeUserAgent = (value: string | null): string | null => {
  if (value === null) return null;
  const sanitized = value.replace(/\p{Cc}/gu, "").slice(0, 256);
  return sanitized.length === 0 ? null : sanitized;
};

const RequestCorrelationHeader = "x-vektorprogrammet-request-correlation";

/** Creates bounded, non-secret request evidence for audit persistence. */
export const identityRequestContext = (request: Request): IdentityRequestContext =>
  new IdentityRequestContext({
    requestCorrelation: safeCorrelation(request.headers.get(RequestCorrelationHeader)),
    sourceIp: safeSourceIp(request),
    userAgent: safeUserAgent(request.headers.get("user-agent")),
  });

/** Overwrites the private correlation carrier before dispatching a request. */
export const prepareIdentityBoundaryRequest = (
  request: Request,
): { readonly request: Request; readonly context: IdentityRequestContext } => {
  const headers = new Headers(request.headers);
  headers.set(RequestCorrelationHeader, randomUUID());
  const prepared = new Request(request, { headers });
  return { request: prepared, context: identityRequestContext(prepared) };
};

export type OriginDecision =
  | { readonly _tag: "Allowed"; readonly origin: string | null }
  | { readonly _tag: "Rejected" };

/** True only when a Cookie header carries Better Auth's local or secure session credential. */
export const hasBetterAuthSessionCredential = (cookieHeader: string | null): boolean =>
  cookieHeader !== null &&
  /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s][^;]*/u.test(cookieHeader);

const hasSessionCookie = (request: Request): boolean =>
  hasBetterAuthSessionCredential(request.headers.get("cookie"));

const isIdentityMutation = (request: Request): boolean => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return false;
  }
  const pathname = new URL(request.url).pathname;
  return (
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/session" ||
    pathname.startsWith("/api/sessions")
  );
};

/** Decides origin authority before credentialed or identity-mutating dispatch. */
export const decideTrustedOrigin = (
  policy: NativeSessionBoundaryPolicy,
  request: Request,
): OriginDecision => {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return policy.trustedOrigins.includes(origin)
      ? { _tag: "Allowed", origin }
      : { _tag: "Rejected" };
  }
  if (!hasSessionCookie(request) && !isIdentityMutation(request)) {
    return { _tag: "Allowed", origin: null };
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return request.headers.get("sec-fetch-site") === "cross-site"
      ? { _tag: "Rejected" }
      : { _tag: "Allowed", origin: null };
  }
  const sameOriginBrowserRequest =
    request.headers.get("sec-fetch-site") === "same-origin" &&
    policy.trustedOrigins.includes(new URL(request.url).origin);
  return sameOriginBrowserRequest ? { _tag: "Allowed", origin: null } : { _tag: "Rejected" };
};

export const trustedOriginRejectedResponse = (): Response =>
  new Response(JSON.stringify({ error: { tag: "TrustedOriginRejected" } }), {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
/**
 * Browser-controlled headers supported by the current native API contract.
 * Cookie and CORS-safelisted headers are intentionally absent because browsers
 * do not include them in Access-Control-Request-Headers.
 */
export const NativeBrowserRequestHeaders = [
  "Content-Type",
  "Idempotency-Key",
  "If-Match",
  "If-None-Match",
  "X-Recruitment-Invitation-Capability",
] as const;

const nativeBrowserRequestHeaderSet = new Set(
  NativeBrowserRequestHeaders.map((header) => header.toLowerCase()),
);

/** Rejects any requested non-safelisted browser header outside the native contract. */
export const allowsNativePreflightHeaders = (request: Request): boolean => {
  const value = request.headers.get("access-control-request-headers");
  if (value === null) return true;
  const requested = value.split(",").map((header) => header.trim().toLowerCase());
  return (
    requested.length > 0 &&
    requested.every((header) => header.length > 0 && nativeBrowserRequestHeaderSet.has(header))
  );
};

export const trustedPreflightResponse = (origin: string): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": NativeBrowserRequestHeaders.join(", "),
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin, Access-Control-Request-Headers",
    },
  });

/** Adds credentialed CORS only for the exact allowed origin. */
export const withTrustedOriginCors = (response: Response, origin: string | null): Response => {
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
