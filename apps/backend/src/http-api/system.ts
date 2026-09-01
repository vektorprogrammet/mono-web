import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { databaseHealth } from "@vektorprogrammet/domain/database";
import {
  Identity,
  IdentityEngineError,
  IdentityOwnedSessionNotFound,
  IdentitySessionExpired,
  IdentitySessionNotFound,
  type IdentitySession,
  type IdentityShape,
  type IdentitySessionMutationSuccess,
} from "@vektorprogrammet/domain/identity";
import { NativeApi } from "@vektorprogrammet/http-api";
import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { BackendRun } from "../router.js";
import { identityRequestContext } from "../session-security.js";
import { toHttpApiResponse } from "./transport.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const identityErrorResponse = (cause: unknown): Response => {
  if (cause instanceof IdentityOwnedSessionNotFound) {
    return jsonResponse({ error: { tag: "SessionNotFound" } }, 404);
  }
  if (
    cause instanceof UnauthenticatedActor ||
    cause instanceof IdentitySessionNotFound ||
    cause instanceof IdentitySessionExpired
  ) {
    return jsonResponse({ error: { tag: "UnauthenticatedActor" } }, 401);
  }
  return jsonResponse({ error: { tag: "IdentityEngineError" } }, 503);
};

const projection = (session: IdentitySession) => ({
  sessionId: session.sessionId,
  createdAt: DateTime.toDateUtc(session.createdAt).toISOString(),
  updatedAt: DateTime.toDateUtc(session.updatedAt).toISOString(),
  expiresAt: DateTime.toDateUtc(session.expiresAt).toISOString(),
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  current: session.current,
});

const mutationResponse = (result: IdentitySessionMutationSuccess): Response => {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const value of result.setCookies) headers.append("set-cookie", value);
  return new Response(null, { status: 204, headers });
};

const identityPromise = <A>(
  run: BackendRun,
  operation: (identity: IdentityShape) => Promise<A>,
): Promise<A> =>
  run(
    Identity.use((identity) =>
      Effect.tryPromise({
        try: () => operation(identity),
        catch: (cause) =>
          cause instanceof IdentityEngineError ||
          cause instanceof IdentitySessionNotFound ||
          cause instanceof IdentitySessionExpired ||
          cause instanceof IdentityOwnedSessionNotFound
            ? cause
            : new IdentityEngineError({
                operation: "nativeSessionResource",
                message: cause instanceof Error ? cause.message : "identity provider failure",
              }),
      }),
    ),
  );

/** Native HttpApi implementations for health and the six frozen session resources. */
export const SystemApiHandlers = (run: BackendRun, _options: { readonly now?: () => string }) =>
  HttpApiBuilder.group(NativeApi, "system", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("health", ({ request }) =>
          toHttpApiResponse(
            request,
            async () => {
              try {
                await run(databaseHealth);
                return jsonResponse({ status: "ok" });
              } catch {
                return jsonResponse({ status: "unavailable" }, 503);
              }
            },
            () => jsonResponse({ status: "unavailable" }, 503),
          ),
        )
        .handleRaw("readSession", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              jsonResponse(
                projection(
                  await identityPromise(run, (identity) =>
                    identity.readCurrentSession(webRequest.headers.get("cookie") ?? undefined),
                  ),
                ),
              ),
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteSession", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              mutationResponse(
                await identityPromise(run, (identity) =>
                  identity.revokeCurrentSession(
                    webRequest.headers.get("cookie") ?? undefined,
                    identityRequestContext(webRequest),
                  ),
                ),
              ),
            identityErrorResponse,
          ),
        )
        .handleRaw("listSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              jsonResponse(
                (
                  await identityPromise(run, (identity) =>
                    identity.listSessions(webRequest.headers.get("cookie") ?? undefined),
                  )
                ).map(projection),
              ),
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteOwnedSession", ({ request, params }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              mutationResponse(
                await identityPromise(run, (identity) =>
                  identity.revokeSession(
                    webRequest.headers.get("cookie") ?? undefined,
                    params.sessionId,
                    identityRequestContext(webRequest),
                  ),
                ),
              ),
            identityErrorResponse,
          ),
        )
        .handleRaw("revokeOtherSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              mutationResponse(
                await identityPromise(run, (identity) =>
                  identity.revokeOtherSessions(
                    webRequest.headers.get("cookie") ?? undefined,
                    identityRequestContext(webRequest),
                  ),
                ),
              ),
            identityErrorResponse,
          ),
        )
        .handleRaw("revokeAllSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) =>
              mutationResponse(
                await identityPromise(run, (identity) =>
                  identity.revokeAllSessions(
                    webRequest.headers.get("cookie") ?? undefined,
                    identityRequestContext(webRequest),
                  ),
                ),
              ),
            identityErrorResponse,
          ),
        ),
    ),
  );
