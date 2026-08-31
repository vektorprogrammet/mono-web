import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

/**
 * Healthy database observation.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const HealthOkResponse = Schema.Struct({ status: Schema.Literals(["ok"]) })
  .pipe(HttpApiSchema.status(200))
  .annotate({
    identifier: "HealthOkResponse",
    description: "The native database boundary is available.",
    examples: [{ status: "ok" as const }],
  });

/**
 * Unavailable database observation.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const HealthUnavailableResponse = Schema.Struct({ status: Schema.Literals(["unavailable"]) })
  .pipe(HttpApiSchema.status(503))
  .annotate({
    identifier: "HealthUnavailableResponse",
    description: "The native database boundary is unavailable.",
    examples: [{ status: "unavailable" as const }],
  });

/**
 * Database health endpoint.
 *
 * @since 0.1.0
 * @category Endpoints
 */
export const HealthEndpoint = HttpApiEndpoint.get("health", "/health", {
  success: HealthOkResponse,
  error: HealthUnavailableResponse,
}).annotateMerge(
  operationAnnotations("Read native health", "Checks the native PostgreSQL boundary."),
);

/**
 * Authenticated session projection returned to browser applications.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const SessionResponse = Schema.Struct({
  personId: Schema.String,
  expiresAt: Schema.String,
}).annotate({
  identifier: "SessionResponse",
  description: "Resolved person identity and UTC session expiry.",
  examples: [{ personId: "person_example", expiresAt: "2026-09-01T12:00:00.000Z" }],
});

/**
 * Identity provider failure response.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const IdentityEngineUnavailableResponse = errorBody(
  "IdentityEngineUnavailableResponse",
  ["IdentityEngineError"],
  503,
);

/**
 * Strict current-session endpoint.
 *
 * @since 0.1.0
 * @category Endpoints
 */
export const ReadSessionEndpoint = HttpApiEndpoint.get("readSession", "/api/me/session", {
  success: SessionResponse,
  error: IdentityEngineUnavailableResponse,
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read current session",
      "Resolves the Better Auth cookie to a native person.",
    ),
  );

/**
 * Operational and session endpoints.
 *
 * @since 0.1.0
 * @category Groups
 */
export class SystemApi extends HttpApiGroup.make("system")
  .add(HealthEndpoint, ReadSessionEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "System",
      description: "Native health and session observations.",
    }),
  ) {}
