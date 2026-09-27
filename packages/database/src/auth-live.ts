import { NativeAuthEngine, NativeAuthEngineLive } from "./auth-engine.js";
import { PasswordRecovery } from "./password-recovery.js";
import { OAuthHandlers, OAuthLive } from "./oauth-live.js";
import { ServicePrincipalGrantAuthorityLive } from "./service-principal-grants-live.js";
import { canonicalJsonValue } from "@vektorprogrammet/domain/shared-kernel";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getSessionCookie } from "better-auth/cookies";
import { Context, Effect, Layer, Schema } from "effect";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AuthorizationInstant } from "@vektorprogrammet/domain/authz";
import { ServicePrincipalGrantAuthority } from "@vektorprogrammet/domain/authz";
import { Database } from "./service.js";
import {
  decodeIdentityActor,
  decodeIdentitySession,
  Identity,
  IdentityEngineError,
  IdentityInvalidCredentials,
  IdentityOwnedSessionNotFound,
  IdentityRateLimited,
  IdentitySecurityEvent,
  IdentitySecurityEventDetails,
  IdentitySessionNotFound,
  type IdentityActor,
  type IdentityRequestContext,
  type IdentitySessionId,
  type IdentitySessionMutationSuccess,
  type IdentitySignInInput,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DatabasePgPool, pgQuery, pgTransaction } from "./pg-pool.js";

import { type AuthEngineConfig } from "./auth-engine.js";
import {
  exactRedirectAccepted,
  OAuthClientOperator,
  OAuthCredentialAuthority,
} from "./oauth-live.js";

/** The one Better Auth instance behind this module's services. */
export type AuthEngineInstance = NativeAuthEngine["Service"];

export interface AuthEngineService {
  readonly engine: AuthEngineInstance;
  /** Standard Better Auth handler with bounded identity security auditing. */
  readonly handler: (
    request: Request,
    context: IdentityRequestContext,
  ) => Effect.Effect<Response, IdentityEngineError>;
  /** Frozen external OAuth protocol surface. It is never used for generic Better Auth dispatch. */
  readonly oauthHandler: (
    request: Request,
    context: IdentityRequestContext,
  ) => Effect.Effect<Response, IdentityEngineError>;
  /** Independent internal-only OAuth introspection surface. */
  readonly oauthIntrospectionHandler: (
    request: Request,
    context: IdentityRequestContext,
  ) => Effect.Effect<Response, IdentityEngineError>;
  readonly exactRedirectAccepted: (
    clientId: string,
    redirectUri: string,
  ) => Effect.Effect<boolean, IdentityEngineError>;
  /** Records a transport rejection that intentionally did not reach Better Auth. */
  readonly recordTrustedOriginRejection: (
    context: IdentityRequestContext,
    credentialFlow?: "PasswordRecovery",
  ) => Effect.Effect<void, IdentityEngineError>;
}

export class AuthEngine extends Context.Service<AuthEngine, AuthEngineService>()(
  "@vektorprogrammet/database/AuthEngine",
) {}

export interface IdentitySnapshotService {
  /**
   * Verifies one Better Auth cookie against persisted session state through
   * the ambient Database transaction. The credential does not leave this seam.
   */
  readonly resolveSession: (
    cookieHeader: string | undefined,
    authorizationInstant: AuthorizationInstant,
  ) => Effect.Effect<IdentityActor, IdentitySessionNotFound | IdentityEngineError, Database>;
  readonly revokeCurrentSession: (
    actor: IdentityActor,
    request: IdentityRequestContext,
  ) => Effect.Effect<
    IdentitySessionMutationSuccess,
    IdentitySessionNotFound | IdentityEngineError,
    Database
  >;
  readonly revokeSession: (
    actor: IdentityActor,
    sessionId: IdentitySessionId,
    request: IdentityRequestContext,
  ) => Effect.Effect<
    IdentitySessionMutationSuccess,
    IdentityOwnedSessionNotFound | IdentityEngineError,
    Database
  >;
  readonly revokeOtherSessions: (
    actor: IdentityActor,
    request: IdentityRequestContext,
  ) => Effect.Effect<IdentitySessionMutationSuccess, IdentityEngineError, Database>;
  readonly revokeAllSessions: (
    actor: IdentityActor,
    request: IdentityRequestContext,
  ) => Effect.Effect<
    IdentitySessionMutationSuccess,
    IdentitySessionNotFound | IdentityEngineError,
    Database
  >;
}

/**
 * Session reads run in the caller's ambient Database transaction, so every method requires it.
 *
 * The leaking expectation below is exception EX-0005 of docs/effect-exceptions.json.
 *
 * @effect-expect-leaking Database
 */
export class IdentitySnapshot extends Context.Service<IdentitySnapshot, IdentitySnapshotService>()(
  "@vektorprogrammet/database/IdentitySnapshot",
) {}

interface SessionRow extends QueryResultRow {
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

interface SnapshotSessionRow {
  readonly sessionId: string;
  readonly personId: string;
  readonly expiresAt: Date;
}

interface DeletedSessionRow extends QueryResultRow {
  readonly sessionId: string;
}

const cookieHeaders = (cookieHeader: string | undefined, origin?: string): Headers => {
  const headers = new Headers();

  if (cookieHeader !== undefined && cookieHeader.length > 0) headers.set("cookie", cookieHeader);

  if (origin !== undefined) headers.set("origin", origin);

  return headers;
};

const actorPrincipal = (actor: IdentityActor): string => `person:${actor.personId}`;

const sanitizedSourceIp = (value: string | null): string | null =>
  value !== null && value.length <= 64 && /^[A-Fa-f0-9.:]+$/u.test(value) ? value : null;

const sanitizedUserAgent = (value: string | null): string | null => {
  if (value === null) return null;
  const sanitized = value.replace(/\p{Cc}/gu, "").slice(0, 256);

  return sanitized.length === 0 ? null : sanitized;
};

const sessionProjection = (row: SessionRow, currentSessionId: string) =>
  decodeIdentitySession({
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ipAddress: sanitizedSourceIp(row.ipAddress),
    userAgent: sanitizedUserAgent(row.userAgent),
    current: row.sessionId === currentSessionId,
  });

const auditEvent = (input: {
  readonly eventKind: IdentitySecurityEvent["eventKind"];
  readonly actor: IdentityActor | null;
  readonly subjectPersonId: IdentitySecurityEvent["subjectPersonId"];
  readonly sessionId: IdentitySecurityEvent["sessionId"];
  readonly context: IdentityRequestContext | null;
  readonly details: IdentitySecurityEventDetails;
}): IdentitySecurityEvent =>
  new IdentitySecurityEvent({
    eventKind: input.eventKind,
    subjectPersonId: input.subjectPersonId,
    sessionId: input.sessionId,
    actorPrincipal: input.actor === null ? null : actorPrincipal(input.actor),
    requestCorrelation: input.context?.requestCorrelation ?? null,
    sourceIp: input.context?.sourceIp ?? null,
    userAgent: input.context?.userAgent ?? null,
    details: input.details,
  });

const encodeEventDetails = Schema.encodeSync(IdentitySecurityEventDetails);

const encodeEventDetailsJson = Schema.encodeEffect(
  Schema.fromJsonString(IdentitySecurityEventDetails),
);

const appendAudit = (database: Pool | PoolClient, unsafeEvent: IdentitySecurityEvent) =>
  Effect.gen(function* () {
    const event = yield* Schema.decodeEffect(IdentitySecurityEvent)(unsafeEvent, {
      onExcessProperty: "error",
    });

    const details = yield* encodeEventDetailsJson(event.details);

    yield* pgQuery(
      database,
      `INSERT INTO auth.identity_security_audit (
         event_id,
         event_kind,
         subject_person_id,
         session_id,
         actor_principal,
         request_correlation,
         source_ip,
         user_agent,
         details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        randomUUID(),
        event.eventKind,
        event.subjectPersonId,
        event.sessionId,
        event.actorPrincipal,
        event.requestCorrelation,
        event.sourceIp,
        event.userAgent,
        details,
      ],
    );
  });

const engineFailure = (operation: string, cause: unknown): IdentityEngineError =>
  Schema.is(IdentityEngineError)(cause)
    ? cause
    : new IdentityEngineError({
        operation,
        message: cause instanceof Error ? cause.message : "identity persistence failure",
      });

const verifiedBetterAuthSessionToken = (
  cookieHeader: string | undefined,
  config: AuthEngineConfig,
): string | null => {
  const signedCookie = getSessionCookie(cookieHeaders(cookieHeader), {
    cookieName: "session_token",
    cookiePrefix: "better-auth",
  });

  if (signedCookie === null) return null;
  const separator = signedCookie.lastIndexOf(".");

  if (separator <= 0 || separator === signedCookie.length - 1) return null;
  const token = signedCookie.slice(0, separator);
  const suppliedSignature = Buffer.from(signedCookie.slice(separator + 1), "base64");
  const expectedSignature = createHmac("sha256", config.secret).update(token).digest();

  return suppliedSignature.length === expectedSignature.length &&
    timingSafeEqual(suppliedSignature, expectedSignature)
    ? token
    : null;
};

const appendSnapshotAudit = (event: IdentitySecurityEvent) =>
  Database.use((sql) =>
    sql`
      INSERT INTO auth.identity_security_audit (
        event_id,
        event_kind,
        subject_person_id,
        session_id,
        actor_principal,
        request_correlation,
        source_ip,
        user_agent,
        details
      ) VALUES (
        ${randomUUID()},
        ${event.eventKind},
        ${event.subjectPersonId},
        ${event.sessionId},
        ${event.actorPrincipal},
        ${event.requestCorrelation},
        ${event.sourceIp},
        ${event.userAgent},
        ${sql.json(canonicalJsonValue(encodeEventDetails(event.details)))}
      )
    `.pipe(Effect.asVoid),
  );

const snapshotMutationAudit = (
  actor: IdentityActor,
  request: IdentityRequestContext,
  input: {
    readonly eventKind: IdentitySecurityEvent["eventKind"];
    readonly sessionId: IdentitySessionId;
    readonly outcomeCode: IdentitySecurityEventDetails["outcomeCode"];
    readonly affectedSessionCount: number;
  },
) =>
  appendSnapshotAudit(
    auditEvent({
      eventKind: input.eventKind,
      actor,
      subjectPersonId: actor.personId,
      sessionId: input.sessionId,
      context: request,
      details: new IdentitySecurityEventDetails({
        outcomeCode: input.outcomeCode,
        affectedSessionCount: input.affectedSessionCount,
      }),
    }),
  );

/** @internal Constructor used by AuthLive and focused boundary tests. */
export const makeIdentitySnapshotService = (config: AuthEngineConfig): IdentitySnapshotService => ({
  resolveSession: (cookieHeader, authorizationInstant) =>
    Effect.gen(function* () {
      const token = verifiedBetterAuthSessionToken(cookieHeader, config);

      if (token === null) return yield* new IdentitySessionNotFound();
      const sql = yield* Database;

      const rows = yield* sql<SnapshotSessionRow>`
        SELECT s."id" AS "sessionId", s."userId" AS "personId", s."expiresAt" AS "expiresAt"
        FROM auth.usable_human_sessions s
        WHERE s."token" = ${token}
          AND s."expiresAt" > ${authorizationInstant}::timestamptz
        LIMIT 1
      `;

      const row = rows[0];

      if (row === undefined) return yield* new IdentitySessionNotFound();

      return yield* decodeIdentityActor(row).pipe(
        Effect.mapError((cause) => engineFailure("decodeSnapshotSession", cause)),
      );
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(engineFailure("resolveSnapshotSession", cause)),
      ),
    ),
  revokeCurrentSession: (actor, request) =>
    Effect.gen(function* () {
      const sql = yield* Database;

      const deleted = yield* sql<DeletedSessionRow>`
        DELETE FROM auth."session"
        WHERE "id" = ${actor.sessionId} AND "userId" = ${actor.personId}
        RETURNING "id" AS "sessionId"
      `;

      if (deleted.length !== 1) return yield* new IdentitySessionNotFound();
      yield* snapshotMutationAudit(actor, request, {
        eventKind: "sign-out",
        sessionId: actor.sessionId,
        outcomeCode: "current-session-ended",
        affectedSessionCount: 1,
      });

      return { setCookies: [] };
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(engineFailure("revokeCurrentSessionSnapshot", cause)),
      ),
    ),
  revokeSession: (actor, sessionId, request) =>
    Effect.gen(function* () {
      const sql = yield* Database;

      const deleted = yield* sql<DeletedSessionRow>`
        DELETE FROM auth."session"
        WHERE "id" = ${sessionId} AND "userId" = ${actor.personId}
        RETURNING "id" AS "sessionId"
      `;

      if (deleted.length !== 1) return yield* new IdentityOwnedSessionNotFound({ sessionId });
      yield* snapshotMutationAudit(actor, request, {
        eventKind: "session-revoked-one",
        sessionId,
        outcomeCode: "owned-session-revoked",
        affectedSessionCount: 1,
      });

      return { setCookies: [] };
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(engineFailure("revokeOwnedSessionSnapshot", cause)),
      ),
    ),
  revokeOtherSessions: (actor, request) =>
    Effect.gen(function* () {
      const sql = yield* Database;

      const deleted = yield* sql<DeletedSessionRow>`
        DELETE FROM auth."session"
        WHERE "userId" = ${actor.personId} AND "id" <> ${actor.sessionId}
        RETURNING "id" AS "sessionId"
      `;

      if (deleted.length > 0) {
        yield* snapshotMutationAudit(actor, request, {
          eventKind: "session-revoked-others",
          sessionId: actor.sessionId,
          outcomeCode: "other-sessions-revoked",
          affectedSessionCount: deleted.length,
        });
      }

      return { setCookies: [] };
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(engineFailure("revokeOtherSessionsSnapshot", cause)),
      ),
    ),
  revokeAllSessions: (actor, request) =>
    Effect.gen(function* () {
      const sql = yield* Database;

      const deleted = yield* sql<DeletedSessionRow>`
        DELETE FROM auth."session"
        WHERE "userId" = ${actor.personId}
        RETURNING "id" AS "sessionId"
      `;

      if (deleted.length === 0) return yield* new IdentitySessionNotFound();
      yield* snapshotMutationAudit(actor, request, {
        eventKind: "session-revoked-all",
        sessionId: actor.sessionId,
        outcomeCode: "all-sessions-revoked",
        affectedSessionCount: deleted.length,
      });

      return { setCookies: [] };
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(engineFailure("revokeAllSessionsSnapshot", cause)),
      ),
    ),
});

const identityOperations = (
  engine: AuthEngineInstance,
  pool: Pool,
  config: AuthEngineConfig,
): IdentityOperations => {
  const resolveSession = Effect.fn("Identity.resolveSession")(function* (
    cookieHeader: string | undefined,
  ) {
    const session = yield* Effect.tryPromise({
      try: () => engine.api.getSession({ headers: cookieHeaders(cookieHeader) }),
      catch: (cause) => engineFailure("resolveSession", cause),
    });

    if (session?.user == null) return yield* new IdentitySessionNotFound();

    const usable = yield* pgQuery(pool, `SELECT 1 FROM auth.usable_human_sessions WHERE id=$1`, [
      session.session.id,
    ]).pipe(Effect.mapError((cause) => engineFailure("resolveSession", cause)));

    if (usable.rowCount !== 1) return yield* new IdentitySessionNotFound();

    return yield* decodeIdentityActor({
      personId: session.user.id,
      sessionId: session.session.id,
      expiresAt: session.session.expiresAt,
    }).pipe(Effect.mapError((cause) => engineFailure("decodeSession", cause)));
  });

  const clearSessionCookies = (cookieHeader: string | undefined) =>
    Effect.tryPromise({
      try: () =>
        engine.api.signOut({
          headers: cookieHeaders(cookieHeader, config.oauth.dashboardOrigin),
          asResponse: true,
        }),
      catch: (cause) => engineFailure("clearSessionCookie", cause),
    }).pipe(Effect.map((response): ReadonlyArray<string> => response.headers.getSetCookie()));

  const keepSessionNotFound =
    (operation: string) =>
    (cause: unknown): IdentitySessionNotFound | IdentityEngineError =>
      Schema.is(IdentitySessionNotFound)(cause) ? cause : engineFailure(operation, cause);

  return {
    signIn: Effect.fn("Identity.signIn")(function* ({ email, password }: IdentitySignInInput) {
      const result = yield* Effect.tryPromise({
        try: () => engine.api.signInEmail({ body: { email, password }, asResponse: true }),
        catch: (cause) => engineFailure("signIn", cause),
      });

      if (!result.ok) {
        if (result.status === 401) return yield* new IdentityInvalidCredentials();

        if (result.status === 429) return yield* new IdentityRateLimited();

        return yield* new IdentityEngineError({
          operation: "signIn",
          message: `authentication provider returned status ${result.status}`,
        });
      }

      const [setCookie] = result.headers.getSetCookie();

      if (setCookie === undefined) {
        return yield* new IdentityEngineError({
          operation: "signIn",
          message: "sign-in response carried no session cookie",
        });
      }

      const actor = yield* resolveSession(setCookie.split(";")[0]);

      return { setCookie, actor };
    }),
    resolveSession,
    readCurrentSession: Effect.fn("Identity.readCurrentSession")(function* (
      cookieHeader: string | undefined,
    ) {
      const actor = yield* resolveSession(cookieHeader);

      return yield* Effect.gen(function* () {
        const result = yield* pgQuery<SessionRow>(
          pool,
          `SELECT
             "id" AS "sessionId",
             "createdAt" AS "createdAt",
             "updatedAt" AS "updatedAt",
             "expiresAt" AS "expiresAt",
             "ipAddress" AS "ipAddress",
             "userAgent" AS "userAgent"
           FROM auth."session"
           WHERE "id" = $1 AND "userId" = $2 AND "expiresAt" > CURRENT_TIMESTAMP`,
          [actor.sessionId, actor.personId],
        );

        const row = result.rows[0];

        if (row === undefined) return yield* new IdentitySessionNotFound();

        return yield* sessionProjection(row, actor.sessionId);
      }).pipe(Effect.mapError(keepSessionNotFound("readCurrentSession")));
    }),
    listSessions: Effect.fn("Identity.listSessions")(function* (cookieHeader: string | undefined) {
      const actor = yield* resolveSession(cookieHeader);

      return yield* pgQuery<SessionRow>(
        pool,
        `SELECT
           "id" AS "sessionId",
           "createdAt" AS "createdAt",
           "updatedAt" AS "updatedAt",
           "expiresAt" AS "expiresAt",
           "ipAddress" AS "ipAddress",
           "userAgent" AS "userAgent"
         FROM auth."session"
         WHERE "userId" = $1 AND "expiresAt" > CURRENT_TIMESTAMP
         ORDER BY "createdAt" DESC, "id"`,
        [actor.personId],
      ).pipe(
        Effect.flatMap((result) =>
          Effect.forEach(result.rows, (row) => sessionProjection(row, actor.sessionId)),
        ),
        Effect.mapError((cause) => engineFailure("listSessions", cause)),
      );
    }),
    revokeCurrentSession: Effect.fn("Identity.revokeCurrentSession")(function* (
      cookieHeader: string | undefined,
      request: IdentityRequestContext,
    ) {
      const actor = yield* resolveSession(cookieHeader);

      return yield* Effect.gen(function* () {
        yield* pgTransaction(pool, (client) =>
          Effect.gen(function* () {
            const deleted = yield* pgQuery<DeletedSessionRow>(
              client,
              `DELETE FROM auth."session"
               WHERE "id" = $1 AND "userId" = $2
               RETURNING "id" AS "sessionId"`,
              [actor.sessionId, actor.personId],
            );

            if (deleted.rowCount !== 1) return yield* new IdentitySessionNotFound();
            yield* appendAudit(
              client,
              auditEvent({
                eventKind: "sign-out",
                actor,
                subjectPersonId: actor.personId,
                sessionId: actor.sessionId,
                context: request,
                details: new IdentitySecurityEventDetails({
                  outcomeCode: "current-session-ended",
                  affectedSessionCount: 1,
                }),
              }),
            );
          }),
        );

        return { setCookies: yield* clearSessionCookies(cookieHeader) };
      }).pipe(Effect.mapError(keepSessionNotFound("revokeCurrentSession")));
    }),
    revokeSession: Effect.fn("Identity.revokeSession")(function* (
      cookieHeader: string | undefined,
      sessionId: IdentitySessionId,
      request: IdentityRequestContext,
    ) {
      const actor = yield* resolveSession(cookieHeader);

      return yield* Effect.gen(function* () {
        yield* pgTransaction(pool, (client) =>
          Effect.gen(function* () {
            const deleted = yield* pgQuery<DeletedSessionRow>(
              client,
              `DELETE FROM auth."session"
               WHERE "id" = $1 AND "userId" = $2
               RETURNING "id" AS "sessionId"`,
              [sessionId, actor.personId],
            );

            if (deleted.rowCount !== 1) {
              return yield* new IdentityOwnedSessionNotFound({ sessionId });
            }

            yield* appendAudit(
              client,
              auditEvent({
                eventKind: "session-revoked-one",
                actor,
                subjectPersonId: actor.personId,
                sessionId,
                context: request,
                details: new IdentitySecurityEventDetails({
                  outcomeCode: "owned-session-revoked",
                  affectedSessionCount: 1,
                }),
              }),
            );
          }),
        );

        return {
          setCookies: sessionId === actor.sessionId ? yield* clearSessionCookies(cookieHeader) : [],
        };
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(IdentityOwnedSessionNotFound)(cause)
            ? cause
            : engineFailure("revokeSession", cause),
        ),
      );
    }),
    revokeOtherSessions: Effect.fn("Identity.revokeOtherSessions")(function* (
      cookieHeader: string | undefined,
      request: IdentityRequestContext,
    ) {
      const actor = yield* resolveSession(cookieHeader);

      yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          const deleted = yield* pgQuery<DeletedSessionRow>(
            client,
            `DELETE FROM auth."session"
             WHERE "userId" = $1 AND "id" <> $2
             RETURNING "id" AS "sessionId"`,
            [actor.personId, actor.sessionId],
          );

          if ((deleted.rowCount ?? 0) === 0) return;
          yield* appendAudit(
            client,
            auditEvent({
              eventKind: "session-revoked-others",
              actor,
              subjectPersonId: actor.personId,
              sessionId: actor.sessionId,
              context: request,
              details: new IdentitySecurityEventDetails({
                outcomeCode: "other-sessions-revoked",
                affectedSessionCount: deleted.rowCount ?? deleted.rows.length,
              }),
            }),
          );
        }),
      ).pipe(Effect.mapError((cause) => engineFailure("revokeOtherSessions", cause)));

      return { setCookies: [] };
    }),
    revokeAllSessions: Effect.fn("Identity.revokeAllSessions")(function* (
      cookieHeader: string | undefined,
      request: IdentityRequestContext,
    ) {
      const actor = yield* resolveSession(cookieHeader);

      return yield* Effect.gen(function* () {
        yield* pgTransaction(pool, (client) =>
          Effect.gen(function* () {
            const deleted = yield* pgQuery<DeletedSessionRow>(
              client,
              `DELETE FROM auth."session"
               WHERE "userId" = $1
               RETURNING "id" AS "sessionId"`,
              [actor.personId],
            );

            if ((deleted.rowCount ?? 0) === 0) return yield* new IdentitySessionNotFound();
            yield* appendAudit(
              client,
              auditEvent({
                eventKind: "session-revoked-all",
                actor,
                subjectPersonId: actor.personId,
                sessionId: actor.sessionId,
                context: request,
                details: new IdentitySecurityEventDetails({
                  outcomeCode: "all-sessions-revoked",
                  affectedSessionCount: deleted.rowCount ?? deleted.rows.length,
                }),
              }),
            );
          }),
        );

        return { setCookies: yield* clearSessionCookies(cookieHeader) };
      }).pipe(Effect.mapError(keepSessionNotFound("revokeAllSessions")));
    }),
    recordSecurityEvent: (event) =>
      appendAudit(pool, event).pipe(
        Effect.mapError((cause) => engineFailure("recordSecurityEvent", cause)),
      ),
    signOut: (cookieHeader) =>
      Effect.map(
        clearSessionCookies(cookieHeader),
        (setCookies): IdentitySessionMutationSuccess => ({ setCookies }),
      ),
  };
};

/** @internal Exposed only for focused ordering tests around the Better Auth boundary. */
export const auditedAuthHandler =
  (
    handle: (request: Request) => Effect.Effect<Response, IdentityEngineError>,
    identity: Pick<IdentityOperations, "resolveSession" | "recordSecurityEvent">,
  ): AuthEngineService["handler"] =>
  (request, context) =>
    Effect.gen(function* () {
      const pathname = new URL(request.url).pathname;

      const signOutActor =
        request.method === "POST" && pathname === "/api/auth/sign-out"
          ? yield* identity
              .resolveSession(request.headers.get("cookie") ?? undefined)
              .pipe(Effect.orElseSucceed(() => null))
          : null;

      const response = yield* handle(request);

      const audit = Effect.gen(function* () {
        if (request.method === "POST" && pathname === "/api/auth/sign-in/email") {
          if (response.ok) {
            const [setCookie] = response.headers.getSetCookie();

            if (setCookie === undefined) {
              return yield* new IdentityEngineError({
                operation: "auditSignIn",
                message: "successful sign-in returned no cookie",
              });
            }

            const actor = yield* identity.resolveSession(setCookie.split(";")[0]);
            yield* identity.recordSecurityEvent(
              auditEvent({
                eventKind: "sign-in-success",
                actor,
                subjectPersonId: actor.personId,
                sessionId: actor.sessionId,
                context,
                details: new IdentitySecurityEventDetails({
                  outcomeCode: "credential-accepted",
                  affectedSessionCount: 1,
                }),
              }),
            );
          } else {
            yield* identity.recordSecurityEvent(
              auditEvent({
                eventKind: "sign-in-failure",
                actor: null,
                subjectPersonId: null,
                sessionId: null,
                context,
                details: new IdentitySecurityEventDetails({
                  outcomeCode: "credential-rejected",
                  affectedSessionCount: 0,
                }),
              }),
            );
          }
        } else if (request.method === "POST" && pathname === "/api/auth/sign-up/email") {
          yield* identity.recordSecurityEvent(
            auditEvent({
              eventKind: "sign-up-rejected",
              actor: null,
              subjectPersonId: null,
              sessionId: null,
              context,
              details: new IdentitySecurityEventDetails({
                outcomeCode: "public-sign-up-disabled",
                affectedSessionCount: 0,
              }),
            }),
          );
        } else if (response.ok && signOutActor !== null) {
          yield* identity.recordSecurityEvent(
            auditEvent({
              eventKind: "sign-out",
              actor: signOutActor,
              subjectPersonId: signOutActor.personId,
              sessionId: signOutActor.sessionId,
              context,
              details: new IdentitySecurityEventDetails({
                outcomeCode: "current-session-ended",
                affectedSessionCount: 1,
              }),
            }),
          );
        }
      });

      return yield* audit.pipe(
        Effect.as(response),
        Effect.orElseSucceed(() =>
          Response.json(
            { error: { tag: "IdentityEngineError" } },
            {
              status: 503,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        ),
      );
    });

/**
 * One scoped construction exposes the Better Auth engine, its typed Identity
 * interpretation, and transaction-bound authoritative session reads.
 */
export const AuthLive = (
  config: AuthEngineConfig,
): Layer.Layer<
  | Identity
  | IdentitySnapshot
  | AuthEngine
  | OAuthCredentialAuthority
  | OAuthClientOperator
  | ServicePrincipalGrantAuthority,
  never,
  DatabasePgPool
> => {
  const nativeEngine = NativeAuthEngineLive(config);

  const services = Layer.mergeAll(
    nativeEngine,
    OAuthLive(config.oauth).pipe(Layer.provide(nativeEngine)),
    ServicePrincipalGrantAuthorityLive,
  );

  return Layer.effectContext(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const recovery = yield* PasswordRecovery;
      const engine = yield* NativeAuthEngine;
      const identity = Identity.of(identityOperations(engine, pool, config));
      const identitySnapshot = IdentitySnapshot.of(makeIdentitySnapshotService(config));

      const oauthCredentialAuthority = yield* OAuthCredentialAuthority;

      const oauthClientOperator = yield* OAuthClientOperator;

      const servicePrincipalGrantAuthority = yield* ServicePrincipalGrantAuthority;

      const { release, introspection } = yield* OAuthHandlers;

      const authEngine = AuthEngine.of({
        engine,
        handler: (request, context) =>
          auditedAuthHandler(
            (incoming) => recovery.handler(engine.handler, incoming, context),
            identity,
          )(request, context),
        oauthHandler: release,
        oauthIntrospectionHandler: (request, context) =>
          introspection(request, context).pipe(
            Effect.mapError((cause) => engineFailure("oauthIntrospectionHandler", cause)),
          ),
        exactRedirectAccepted: (clientId, redirectUri) =>
          exactRedirectAccepted(pool, clientId, redirectUri).pipe(
            Effect.mapError((cause) => engineFailure("exactRedirectAccepted", cause)),
          ),
        recordTrustedOriginRejection: (context, credentialFlow) =>
          identity.recordSecurityEvent(
            auditEvent({
              eventKind:
                credentialFlow === "PasswordRecovery"
                  ? "password-reset-request-rejected"
                  : "trusted-origin-csrf-rejected",
              actor: null,
              subjectPersonId: null,
              sessionId: null,
              context,
              details: new IdentitySecurityEventDetails({
                outcomeCode: "origin-not-trusted",
                affectedSessionCount: 0,
              }),
            }),
          ),
      });

      return Context.make(AuthEngine, authEngine).pipe(
        Context.merge(Context.make(Identity, identity)),
        Context.merge(Context.make(IdentitySnapshot, identitySnapshot)),
        Context.merge(Context.make(OAuthCredentialAuthority, oauthCredentialAuthority)),
        Context.merge(Context.make(OAuthClientOperator, oauthClientOperator)),
        Context.merge(Context.make(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority)),
      );
    }),
  ).pipe(Layer.provide(services));
};
