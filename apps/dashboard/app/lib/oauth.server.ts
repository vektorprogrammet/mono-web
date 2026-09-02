import { randomUUID } from "node:crypto";
import { forwardSetCookieHeaders, requireAuth } from "./auth.server";
import { serverApiEndpoint } from "./api.server";

const MAX_OAUTH_QUERY_BYTES = 8 * 1024;
const NATIVE_API_RESOURCE = "urn:vektorprogrammet:native-api";
const NATIVE_API_RESOURCE_NAME = "Vektorprogrammet native API";
const OAUTH_ISSUER_PATH = "/api/auth";
const CONSENT_PATH = "/dashboard/oauth/consent";
const REQUEST_CORRELATION_HEADER = "x-vektorprogrammet-request-correlation";
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
} as const;

export type PendingOAuthRequest = {
  readonly raw: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly redirectOrigin: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope: "native-api" | "native-api offline_access";
  readonly resource: typeof NATIVE_API_RESOURCE;
};

export type PendingOAuthInspection =
  | { readonly _tag: "None" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Pending"; readonly pending: PendingOAuthRequest };

export type OAuthConsentView = {
  readonly clientName: string;
  readonly clientKind: "public" | "confidential";
  readonly redirectOrigin: string;
  readonly resourceName: typeof NATIVE_API_RESOURCE_NAME;
  readonly scopes: ReadonlyArray<"native-api" | "offline_access">;
};

export type OAuthConsentSubmission = {
  readonly location: string;
  readonly headers: Headers;
};

const one = (params: URLSearchParams, name: string): string | undefined => {
  const values = params.getAll(name);
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
};

const validRedirect = (value: string): URL | undefined => {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    return undefined;
  }
  if (
    redirect.toString() !== value ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.hash !== "" ||
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && redirect.hostname === "127.0.0.1" && redirect.port !== ""))
  ) {
    return undefined;
  }
  return redirect;
};

const queryBytesAreBounded = (value: string): boolean =>
  value.length > 0 && new TextEncoder().encode(value).byteLength <= MAX_OAUTH_QUERY_BYTES;

export function inspectPendingOAuthRequest(request: Request): PendingOAuthInspection {
  const url = new URL(request.url);
  const raw = url.search.slice(1);
  const params = url.searchParams;
  const hasOAuthMarker = params.has("sig") || params.has("ba_param") || params.has("client_id");
  if (!hasOAuthMarker) return { _tag: "None" };
  if (!queryBytesAreBounded(raw)) return { _tag: "Invalid" };

  const clientId = one(params, "client_id");
  const redirectUri = one(params, "redirect_uri");
  const state = one(params, "state");
  const codeChallenge = one(params, "code_challenge");
  const scope = one(params, "scope");
  const resource = one(params, "resource");
  const redirect = redirectUri === undefined ? undefined : validRedirect(redirectUri);
  if (
    clientId === undefined ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(clientId) ||
    redirect === undefined ||
    state === undefined ||
    !/^[A-Za-z0-9_-]{43,512}$/u.test(state) ||
    codeChallenge === undefined ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) ||
    one(params, "code_challenge_method") !== "S256" ||
    one(params, "response_type") !== "code" ||
    (scope !== "native-api" && scope !== "native-api offline_access") ||
    resource !== NATIVE_API_RESOURCE ||
    one(params, "sig") === undefined ||
    one(params, "exp") === undefined ||
    one(params, "ba_iat") === undefined ||
    params.getAll("ba_param").length === 0
  ) {
    return { _tag: "Invalid" };
  }
  return {
    _tag: "Pending",
    pending: {
      raw,
      clientId,
      redirectUri: redirect.toString(),
      redirectOrigin: redirect.origin,
      state,
      codeChallenge,
      scope,
      resource,
    },
  };
}

export const oauthNoStoreHeaders = (source?: Headers): Headers => {
  const headers = source === undefined ? new Headers() : new Headers(source);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  return headers;
};

export const oauthFailure = (status: number): Response =>
  Response.json(
    { error: "OAuth-forespørselen kunne ikke behandles. Start tilkoblingen på nytt." },
    { status, headers: oauthNoStoreHeaders() },
  );

export const hasTrustedActionOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(request.url).origin;
};

const backendHeaders = (request: Request, cookie: string, origin: string): Headers => {
  const headers = new Headers({
    Accept: "application/json",
    Cookie: cookie,
    Origin: origin,
  });
  headers.set(REQUEST_CORRELATION_HEADER, randomUUID());
  return headers;
};

type PublicClient = {
  readonly clientName: string;
  readonly clientKind: "DelegatedPublic" | "DelegatedConfidential";
};

const readPublicClient = async (
  request: Request,
  pending: PendingOAuthRequest,
  cookie: string,
): Promise<PublicClient> => {
  const endpoint = new URL(serverApiEndpoint("/api/auth/oauth2/public-client"));
  endpoint.searchParams.set("client_id", pending.clientId);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: backendHeaders(request, cookie, new URL(request.url).origin),
      signal: request.signal,
      redirect: "manual",
    });
  } catch {
    throw oauthFailure(502);
  }
  if (!response.ok) throw oauthFailure(response.status === 401 ? 401 : 400);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw oauthFailure(502);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !("client_id" in body) ||
    body.client_id !== pending.clientId ||
    !("client_name" in body) ||
    typeof body.client_name !== "string" ||
    body.client_name.length === 0 ||
    body.client_name.length > 160 ||
    !("client_kind" in body) ||
    (body.client_kind !== "DelegatedPublic" && body.client_kind !== "DelegatedConfidential")
  ) {
    throw oauthFailure(502);
  }
  return { clientName: body.client_name, clientKind: body.client_kind };
};

const loginDestination = (pending: PendingOAuthRequest): string => `/login?${pending.raw}`;

export async function loadOAuthConsent(
  request: Request,
): Promise<{ readonly pending: PendingOAuthRequest; readonly view: OAuthConsentView }> {
  const inspected = inspectPendingOAuthRequest(request);
  if (inspected._tag !== "Pending") throw oauthFailure(400);
  const cookie = await requireAuth(request, loginDestination(inspected.pending));
  const client = await readPublicClient(request, inspected.pending, cookie);
  return {
    pending: inspected.pending,
    view: {
      clientName: client.clientName,
      clientKind: client.clientKind === "DelegatedPublic" ? "public" : "confidential",
      redirectOrigin: inspected.pending.redirectOrigin,
      resourceName: NATIVE_API_RESOURCE_NAME,
      scopes: inspected.pending.scope.split(" ") as ReadonlyArray<"native-api" | "offline_access">,
    },
  };
}

const cookieFromSetCookie = (headers: Headers): string | undefined => {
  const pairs = headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
  return pairs.length > 0 && pairs.every((pair) => pair.includes("="))
    ? pairs.join("; ")
    : undefined;
};

export const sessionCookieFromResponse = (headers: Headers): string | undefined =>
  cookieFromSetCookie(headers);

const samePendingRequest = (left: PendingOAuthRequest, right: PendingOAuthRequest): boolean =>
  left.clientId === right.clientId &&
  left.redirectUri === right.redirectUri &&
  left.state === right.state &&
  left.codeChallenge === right.codeChallenge &&
  left.scope === right.scope &&
  left.resource === right.resource;

const callbackBaseMatches = (continuation: URL, pending: PendingOAuthRequest): boolean => {
  const providerParameters = ["code", "state", "iss", "error", "error_description"] as const;
  if (providerParameters.some((name) => continuation.searchParams.getAll(name).length > 1)) {
    return false;
  }
  const base = new URL(continuation);
  for (const name of providerParameters) base.searchParams.delete(name);
  return base.toString() === pending.redirectUri;
};

export async function guardOAuthContinuation(
  request: Request,
  pending: PendingOAuthRequest,
  continuationValue: string,
  cookie: string,
): Promise<string> {
  if (!queryBytesAreBounded(continuationValue)) throw oauthFailure(502);
  let continuation: URL;
  try {
    continuation = new URL(continuationValue);
  } catch {
    throw oauthFailure(502);
  }
  await readPublicClient(request, pending, cookie);

  const dashboardOrigin = new URL(request.url).origin;
  if (
    continuation.origin === dashboardOrigin &&
    continuation.pathname === CONSENT_PATH &&
    continuation.username === "" &&
    continuation.password === "" &&
    continuation.hash === ""
  ) {
    const next = inspectPendingOAuthRequest(new Request(continuation));
    if (next._tag !== "Pending" || !samePendingRequest(next.pending, pending)) {
      throw oauthFailure(502);
    }
    return continuation.toString();
  }

  const state = one(continuation.searchParams, "state");
  const issuer = one(continuation.searchParams, "iss");
  const code = one(continuation.searchParams, "code");
  const error = one(continuation.searchParams, "error");
  const validOutcome =
    (code !== undefined && /^[A-Za-z0-9_-]{32,512}$/u.test(code) && error === undefined) ||
    (code === undefined && error === "access_denied");
  if (
    !callbackBaseMatches(continuation, pending) ||
    state !== pending.state ||
    issuer !== serverApiEndpoint(OAUTH_ISSUER_PATH) ||
    !validOutcome
  ) {
    throw oauthFailure(502);
  }
  return continuation.toString();
}

export async function submitOAuthConsent(
  request: Request,
  accept: boolean,
): Promise<OAuthConsentSubmission> {
  const inspected = inspectPendingOAuthRequest(request);
  if (inspected._tag !== "Pending") throw oauthFailure(400);
  if (!hasTrustedActionOrigin(request)) throw oauthFailure(403);
  const cookie = await requireAuth(request, loginDestination(inspected.pending));
  const headers = backendHeaders(request, cookie, request.headers.get("Origin")!);
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(serverApiEndpoint("/api/auth/oauth2/consent"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        accept,
        ...(accept ? { scope: inspected.pending.scope } : {}),
        oauth_query: inspected.pending.raw,
      }),
      signal: request.signal,
      redirect: "manual",
    });
  } catch {
    throw oauthFailure(502);
  }
  if (!response.ok) throw oauthFailure(response.status === 400 ? 400 : 502);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw oauthFailure(502);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !("redirect" in body) ||
    body.redirect !== true ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw oauthFailure(502);
  }
  const responseHeaders = forwardSetCookieHeaders(response.headers);
  const continuationCookie = cookieFromSetCookie(response.headers) ?? cookie;
  const location = await guardOAuthContinuation(
    request,
    inspected.pending,
    body.url,
    continuationCookie,
  );
  return { location, headers: oauthNoStoreHeaders(responseHeaders) };
}
