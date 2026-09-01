/**
 * Public HTTP contracts for health and first-party session resources.
 *
 * @since 0.1.0
 */
import { PUBLIC_SYSTEM_ACCESS } from "@vektorprogrammet/domain/authz";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec } from "./access.js";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

export const HealthOkResponse = Schema.Struct({ status: Schema.Literals(["ok"]) })
  .pipe(HttpApiSchema.status(200))
  .annotate({ identifier: "HealthOkResponse", description: "Database is available." });

export const HealthUnavailableResponse = Schema.Struct({ status: Schema.Literals(["unavailable"]) })
  .pipe(HttpApiSchema.status(503))
  .annotate({
    identifier: "HealthUnavailableResponse",
    description: "Database is unavailable.",
  });

export const HealthEndpoint = HttpApiEndpoint.get("health", "/health", {
  success: HealthOkResponse,
  error: HealthUnavailableResponse,
})
  .pipe((endpoint) => annotateAccessSpec(endpoint, PUBLIC_SYSTEM_ACCESS))
  .annotateMerge(
    operationAnnotations("Read native health", "Checks the native PostgreSQL boundary."),
  );

const SessionId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.length <= 128, {
      message: "a bounded opaque session identifier",
    }),
  ),
);

/** Credential-free owner-only session metadata. */
export const SessionResponse = Schema.Struct({
  sessionId: SessionId,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
}).annotate({
  identifier: "SessionResponse",
  description: "Safe first-party session metadata without credential material.",
});

export const SessionListResponse = Schema.Array(SessionResponse).annotate({
  identifier: "SessionListResponse",
  description: "Sessions owned by the authenticated person.",
});

export const IdentityEngineUnavailableResponse = errorBody(
  "IdentityEngineUnavailableResponse",
  ["IdentityEngineError"],
  503,
);

export const OwnedSessionNotFoundResponse = errorBody(
  "OwnedSessionNotFoundResponse",
  ["SessionNotFound"],
  404,
);

export const ReadSessionEndpoint = HttpApiEndpoint.get("readSession", "/api/session", {
  success: SessionResponse,
  error: IdentityEngineUnavailableResponse,
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read current session",
      "Reads safe metadata for the authoritative current Better Auth session.",
    ),
  );

export const DeleteSessionEndpoint = HttpApiEndpoint.delete("deleteSession", "/api/session", {
  error: IdentityEngineUnavailableResponse,
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("End current session", "Revokes the authoritative current session."),
  );

export const ListSessionsEndpoint = HttpApiEndpoint.get("listSessions", "/api/sessions", {
  success: SessionListResponse,
  error: IdentityEngineUnavailableResponse,
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "List current person's sessions",
      "Lists only safe metadata for sessions owned by the authenticated person.",
    ),
  );

export const DeleteOwnedSessionEndpoint = HttpApiEndpoint.delete(
  "deleteOwnedSession",
  "/api/sessions/:sessionId",
  {
    params: { sessionId: SessionId },
    error: [OwnedSessionNotFoundResponse, IdentityEngineUnavailableResponse],
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Revoke one session",
      "Revokes one owned session; missing and non-owned identifiers are concealed.",
    ),
  );

export const RevokeOtherSessionsEndpoint = HttpApiEndpoint.post(
  "revokeOtherSessions",
  "/api/sessions::revoke-others",
  { error: IdentityEngineUnavailableResponse },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Revoke other sessions",
      "Revokes every owned session except the authoritative current session.",
    ),
  );

export const RevokeAllSessionsEndpoint = HttpApiEndpoint.post(
  "revokeAllSessions",
  "/api/sessions::revoke-all",
  { error: IdentityEngineUnavailableResponse },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Revoke all sessions",
      "Revokes every owned session, including the authoritative current session.",
    ),
  );

export class SystemApi extends HttpApiGroup.make("system")
  .add(
    HealthEndpoint,
    ReadSessionEndpoint,
    DeleteSessionEndpoint,
    ListSessionsEndpoint,
    DeleteOwnedSessionEndpoint,
    RevokeOtherSessionsEndpoint,
    RevokeAllSessionsEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "System",
      description: "Native health and first-party session resources.",
    }),
  ) {}
