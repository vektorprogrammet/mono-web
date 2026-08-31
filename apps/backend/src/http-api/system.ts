import { databaseHealth } from "@vektorprogrammet/domain/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { NativeApi } from "@vektorprogrammet/http-api";
import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveAuthenticatedSession } from "../authority.js";
import type { BackendRun } from "../router.js";
import { toHttpApiResponse } from "./transport.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const sessionErrorResponse = (cause: unknown): Response => {
  const unauthenticated = cause instanceof UnauthenticatedActor;
  return jsonResponse(
    {
      error: {
        tag: unauthenticated ? "UnauthenticatedActor" : "IdentityEngineError",
      },
    },
    unauthenticated ? 401 : 503,
  );
};

/** Native HttpApi implementations for health and strict session reads. */
export const SystemApiHandlers = (run: BackendRun, options: { readonly now?: () => string }) =>
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
            async (webRequest) => {
              const actor = await resolveAuthenticatedSession(
                webRequest.headers.get("cookie") ?? undefined,
                { run, now: options.now },
              );
              return jsonResponse({
                personId: actor.personId,
                expiresAt: DateTime.toDateUtc(actor.expiresAt).toISOString(),
              });
            },
            sessionErrorResponse,
          ),
        ),
    ),
  );
