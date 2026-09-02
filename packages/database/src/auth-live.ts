import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getSessionCookie } from "better-auth/cookies";
import { Context, Effect, Layer, Schema } from "effect";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AuthorizationInstant } from "@vektorprogrammet/domain/authz";
import { ServicePrincipalGrantAuthority } from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/domain/database";
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
  type IdentitySession,
  type IdentitySessionId,
  type IdentitySessionMutationSuccess,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { DatabasePgPool } from "./layers.js";
import { makeAuthEngine, type AuthEngineConfig } from "./auth-engine.js";
import {
  exactRedirectAccepted,
  makeOAuthClientOperatorService,
  makeOAuthCredentialAuthorityService,
  makeOAuthInternalIntrospectionHandler,
  makeOAuthReleaseBarrier,
  OAuthClientOperator,
  OAuthCredentialAuthority,
} from "./oauth-live.js";
import { makeServicePrincipalGrantAuthorityService } from "./service-principal-grants-live.js";

/** The one Better Auth instance behind this module's services. */
export type AuthEngineInstance = ReturnType<typeof makeAuthEngine>;
export interface AuthEngineService {
  readonly engine: AuthEngineInstance;
  /** Standard Better Auth handler with bounded identity security auditing. */
  readonly handler: (request: Request, context: IdentityRequestContext) => Promise<Response>;
  /** Frozen external OAuth protocol surface. It is never used for generic Better Auth dispatch. */
  readonly oauthHandler: (request: Request, context: IdentityRequestContext) => Promise<Response>;
  /** Independent internal-only OAuth introspection surface. */
  readonly oauthIntrospectionHandler: (
    request: Request,
    context: IdentityRequestContext,
  ) => Promise<Response>;
  readonly exactRedirectAccepted: (clientId: string, redirectUri: string) => Promise<boolean>;
  /** Records a transport rejection that intentionally did not reach Better Auth. */
  readonly recordTrustedOriginRejection: (context: IdentityRequestContext) => Promise<void>;
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

interface Queryable {
  readonly query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ readonly rows: Array<R>; readonly rowCount: number | null }>;
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

const sessionProjection = async (
  row: SessionRow,
  currentSessionId: string,
): Promise<IdentitySession> =>
  decodeIdentitySession({
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ipAddress: sanitizedSourceIp(row.ipAddress),
    userAgent: sanitizedUserAgent(row.userAgent),
    current: row.sessionId === currentSessionId,
  }).pipe(Effect.runPromise);

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

const appendAudit = async (
  database: Queryable,
  unsafeEvent: IdentitySecurityEvent,
): Promise<void> => {
  const event = Schema.decodeUnknownSync(IdentitySecurityEvent)(unsafeEvent, {
    onExcessProperty: "error",
  });
  await database.query(
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
      JSON.stringify(event.details),
    ],
  );
};

const inTransaction = async <A>(
  pool: Pool,
  use: (client: PoolClient) => Promise<A>,
): Promise<A> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await use(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
};

const engineFailure = (operation: string, cause: unknown): IdentityEngineError =>
  cause instanceof IdentityEngineError
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
        ${sql.json(event.details)}
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
        SELECT "id" AS "sessionId", "userId" AS "personId", "expiresAt" AS "expiresAt"
        FROM auth."session"
        WHERE "token" = ${token}
          AND "expiresAt" > ${authorizationInstant}::timestamptz
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
const identityShape = (
  engine: AuthEngineInstance,
  pool: Pool,
  config: AuthEngineConfig,
): IdentityShape => {
  const resolveSession = async (cookieHeader: string | undefined): Promise<IdentityActor> => {
    let session: Awaited<ReturnType<typeof engine.api.getSession>>;
    try {
      session = await engine.api.getSession({ headers: cookieHeaders(cookieHeader) });
    } catch (cause) {
      throw engineFailure("resolveSession", cause);
    }
    if (session?.user == null) throw new IdentitySessionNotFound();
    try {
      return await decodeIdentityActor({
        personId: session.user.id,
        sessionId: session.session.id,
        expiresAt: session.session.expiresAt,
      }).pipe(Effect.runPromise);
    } catch (cause) {
      throw engineFailure("decodeSession", cause);
    }
  };

  const clearSessionCookies = async (
    cookieHeader: string | undefined,
  ): Promise<ReadonlyArray<string>> => {
    try {
      const response = await engine.api.signOut({
        headers: cookieHeaders(cookieHeader, config.oauth.dashboardOrigin),
        asResponse: true,
      });
      return response.headers.getSetCookie();
    } catch (cause) {
      throw engineFailure("clearSessionCookie", cause);
    }
  };

  const recordSecurityEvent = async (event: IdentitySecurityEvent): Promise<void> => {
    try {
      await appendAudit(pool, event);
    } catch (cause) {
      throw engineFailure("recordSecurityEvent", cause);
    }
  };

  return {
    signIn: async ({ email, password }) => {
      const result = await engine.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      if (!result.ok) {
        if (result.status === 401) throw new IdentityInvalidCredentials();
        if (result.status === 429) throw new IdentityRateLimited();
        throw new IdentityEngineError({
          operation: "signIn",
          message: `authentication provider returned status ${result.status}`,
        });
      }
      const [setCookie] = result.headers.getSetCookie();
      if (setCookie === undefined) {
        throw new IdentityEngineError({
          operation: "signIn",
          message: "sign-in response carried no session cookie",
        });
      }
      const actor = await resolveSession(setCookie.split(";")[0]);
      return { setCookie, actor };
    },
    resolveSession,
    readCurrentSession: async (cookieHeader) => {
      const actor = await resolveSession(cookieHeader);
      try {
        const result = await pool.query<SessionRow>(
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
        if (row === undefined) throw new IdentitySessionNotFound();
        return await sessionProjection(row, actor.sessionId);
      } catch (cause) {
        if (cause instanceof IdentitySessionNotFound) throw cause;
        throw engineFailure("readCurrentSession", cause);
      }
    },
    listSessions: async (cookieHeader) => {
      const actor = await resolveSession(cookieHeader);
      try {
        const result = await pool.query<SessionRow>(
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
        );
        return await Promise.all(result.rows.map((row) => sessionProjection(row, actor.sessionId)));
      } catch (cause) {
        throw engineFailure("listSessions", cause);
      }
    },
    revokeCurrentSession: async (cookieHeader, request) => {
      const actor = await resolveSession(cookieHeader);
      try {
        await inTransaction(pool, async (client) => {
          const deleted = await client.query<DeletedSessionRow>(
            `DELETE FROM auth."session"
             WHERE "id" = $1 AND "userId" = $2
             RETURNING "id" AS "sessionId"`,
            [actor.sessionId, actor.personId],
          );
          if (deleted.rowCount !== 1) throw new IdentitySessionNotFound();
          await appendAudit(
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
        });
        return { setCookies: await clearSessionCookies(cookieHeader) };
      } catch (cause) {
        if (cause instanceof IdentitySessionNotFound) throw cause;
        throw engineFailure("revokeCurrentSession", cause);
      }
    },
    revokeSession: async (cookieHeader, sessionId, request) => {
      const actor = await resolveSession(cookieHeader);
      try {
        await inTransaction(pool, async (client) => {
          const deleted = await client.query<DeletedSessionRow>(
            `DELETE FROM auth."session"
             WHERE "id" = $1 AND "userId" = $2
             RETURNING "id" AS "sessionId"`,
            [sessionId, actor.personId],
          );
          if (deleted.rowCount !== 1) throw new IdentityOwnedSessionNotFound({ sessionId });
          await appendAudit(
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
        });
        return {
          setCookies: sessionId === actor.sessionId ? await clearSessionCookies(cookieHeader) : [],
        };
      } catch (cause) {
        if (cause instanceof IdentityOwnedSessionNotFound) throw cause;
        throw engineFailure("revokeSession", cause);
      }
    },
    revokeOtherSessions: async (cookieHeader, request) => {
      const actor = await resolveSession(cookieHeader);
      try {
        await inTransaction(pool, async (client) => {
          const deleted = await client.query<DeletedSessionRow>(
            `DELETE FROM auth."session"
             WHERE "userId" = $1 AND "id" <> $2
             RETURNING "id" AS "sessionId"`,
            [actor.personId, actor.sessionId],
          );
          if ((deleted.rowCount ?? 0) === 0) return;
          await appendAudit(
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
        });
        return { setCookies: [] };
      } catch (cause) {
        throw engineFailure("revokeOtherSessions", cause);
      }
    },
    revokeAllSessions: async (cookieHeader, request) => {
      const actor = await resolveSession(cookieHeader);
      try {
        await inTransaction(pool, async (client) => {
          const deleted = await client.query<DeletedSessionRow>(
            `DELETE FROM auth."session"
             WHERE "userId" = $1
             RETURNING "id" AS "sessionId"`,
            [actor.personId],
          );
          if ((deleted.rowCount ?? 0) === 0) throw new IdentitySessionNotFound();
          await appendAudit(
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
        });
        return { setCookies: await clearSessionCookies(cookieHeader) };
      } catch (cause) {
        if (cause instanceof IdentitySessionNotFound) throw cause;
        throw engineFailure("revokeAllSessions", cause);
      }
    },
    recordSecurityEvent,
    signOut: async (cookieHeader) => ({ setCookies: await clearSessionCookies(cookieHeader) }),
  };
};

/** @internal Exposed only for focused ordering tests around the Better Auth boundary. */
export const auditedAuthHandler =
  (
    engine: Pick<AuthEngineInstance, "handler">,
    identity: Pick<IdentityShape, "resolveSession" | "recordSecurityEvent">,
  ): AuthEngineService["handler"] =>
  async (request, context) => {
    const pathname = new URL(request.url).pathname;
    const signOutActor =
      request.method === "POST" && pathname === "/api/auth/sign-out"
        ? await identity
            .resolveSession(request.headers.get("cookie") ?? undefined)
            .catch(() => null)
        : null;
    const response = await engine.handler(request);
    try {
      if (request.method === "POST" && pathname === "/api/auth/sign-in/email") {
        if (response.ok) {
          const [setCookie] = response.headers.getSetCookie();
          if (setCookie === undefined) throw new Error("successful sign-in returned no cookie");
          const actor = await identity.resolveSession(setCookie.split(";")[0]);
          await identity.recordSecurityEvent(
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
          await identity.recordSecurityEvent(
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
        await identity.recordSecurityEvent(
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
        await identity.recordSecurityEvent(
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
      return response;
    } catch {
      return new Response(JSON.stringify({ error: { tag: "IdentityEngineError" } }), {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }
  };

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
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const engine = makeAuthEngine(config, pool);
      const identity = Identity.of(identityShape(engine, pool, config));
      const identitySnapshot = IdentitySnapshot.of(makeIdentitySnapshotService(config));
      const oauthCredentialAuthority = OAuthCredentialAuthority.of(
        makeOAuthCredentialAuthorityService(pool, config.oauth),
      );
      const oauthClientOperator = OAuthClientOperator.of(
        makeOAuthClientOperatorService(pool, engine),
      );
      const servicePrincipalGrantAuthority = ServicePrincipalGrantAuthority.of(
        makeServicePrincipalGrantAuthorityService(pool),
      );
      const oauthHandler = makeOAuthReleaseBarrier(engine, pool, config.oauth);
      const oauthIntrospectionHandler = makeOAuthInternalIntrospectionHandler(engine, pool);
      const authEngine = AuthEngine.of({
        engine,
        handler: auditedAuthHandler(engine, identity),
        oauthHandler,
        oauthIntrospectionHandler,
        exactRedirectAccepted: (clientId, redirectUri) =>
          exactRedirectAccepted(pool, clientId, redirectUri),
        recordTrustedOriginRejection: (context) =>
          identity.recordSecurityEvent(
            auditEvent({
              eventKind: "trusted-origin-csrf-rejected",
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
  );
