/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import type * as SqlClient from "effect/sql/SqlClient";
import { AuthPgPool, AuthPoolLive } from "./pg-pool.js";
import { betterAuth, createLocalAccountIssuer, type GenericEndpointContext } from "better-auth";
import {
  getCurrentAuthContext,
  runWithEndpointContext,
  type AuthEndpointContext,
} from "@better-auth/core/context";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies } from "better-auth/cookies";
import {
  Config,
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { Pool } from "pg";
import { afterAll, describe, expect, expectTypeOf, it, layer } from "@effect/vitest";
import { AuthorizationInstant } from "@vektorprogrammet/domain/authz";
import { Database } from "./service.js";
import {
  Identity,
  IdentityActor,
  IdentityOwnedSessionNotFound,
  IdentityEngineError,
  IdentitySessionNotFound,
  IdentityRequestContext,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  auditedAuthHandler,
  AuthLive,
  AuthEngine,
  IdentitySnapshot,
  makeIdentitySnapshotService,
} from "./auth-live.js";
import {
  makeAuthEngineOptions,
  makeBetterAuthCallbackRunner,
  withNativeAuthProvisioning,
} from "./auth-engine.js";
import { DatabaseLive } from "./layers.js";
import { DatabaseTestLive, TestPlatform } from "./test-support/platform.js";
import { HmacTagVerifierLive } from "./web-crypto.js";

/**
 * Focused spec 0054 checks for the Layer-scoped better-auth engine behind
 * AuthLive. Requires a disposable loopback PostgreSQL whose name contains
 * "proof" or "test"; everything else runs on PGlite previews without auth.
 *
 * AUTH_TEST_PG_URL names that cluster. A set but empty value runs the suite, which rejects it.
 */
const authTestUrl = Effect.runSync(
  Config.option(Config.String("AUTH_TEST_PG_URL")).parse(
    ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
  ),
);

const config = {
  postgresUrl: Option.getOrElse(authTestUrl, () => ""),
  secret: "auth-live-focused-test-secret-at-least-32-chars",
  oauth: {
    canonicalOrigin: "http://127.0.0.1:8790",
    dashboardOrigin: "http://127.0.0.1:8790",
    nativeApiResource: "urn:vektorprogrammet:native-api",
  },
  trustedOrigins: ["http://127.0.0.1:8790"],
  secureCookies: false,
} as const;

const cohort = {
  personId: "auth-live-test-person",
  email: "auth-live-test@example.invalid",
  password: "AuthLiveTest!password-0054",
} as const;

const otherCohort = {
  personId: "auth-live-test-other-person",
  email: "auth-live-test-other@example.invalid",
  password: "AuthLiveTest!other-password-0054",
} as const;

const requestContext = new IdentityRequestContext({
  requestCorrelation: "auth-live-test",
  sourceIp: "127.0.0.1",
  userAgent: "auth-live-test",
});

const oauthMemoryModels = {
  oauthClient: [],
  oauthAccessToken: [],
  oauthRefreshToken: [],
  oauthConsent: [],
  oauthResource: [],
  oauthClientResource: [],
  oauthClientAssertion: [],
  jwks: [],
};

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const assertDisposable = (url: string): void => {
  const parsed = new URL(url);
  expect(["postgres:", "postgresql:"]).toContain(parsed.protocol);
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(parsed.hostname);
  expect(decodeURIComponent(parsed.pathname.slice(1))).toMatch(/proof|test/i);
};

/** Provisions one auth.user + credential account pair. */
const seedCredentialIdentity = (
  person: Readonly<{ personId: string; email: string; password: string }> = cohort,
) =>
  Effect.gen(function* () {
    const engine = yield* AuthEngine;
    const context = yield* Effect.promise(() => engine.engine.$context);
    yield* withNativeAuthProvisioning(context, () =>
      context.internalAdapter.createUser(
        {
          id: person.personId,
          name: "Auth Live Test",
          email: person.email,
          emailVerified: true,
        },
        { method: "email-password" },
      ),
    );
    const passwordHash = yield* Effect.promise(() => context.password.hash(person.password));
    yield* withNativeAuthProvisioning(context, () =>
      context.internalAdapter.linkAccount({
        accountId: person.personId,
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        userId: person.personId,
        password: passwordHash,
      }),
    );
  });

const resetAuthData = (pool: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* pool.unsafe(`TRUNCATE auth.identity_security_audit`);
    yield* pool.unsafe(`DELETE FROM auth."session"`);
    yield* pool.unsafe(`DELETE FROM auth."account"`);
    yield* pool.unsafe(`DELETE FROM auth."user"`);
  });

const dsl = Option.isSome(authTestUrl) ? describe : describe.skip;

const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "auth-live-focused-test",
  maxConnections: 4,
}).pipe(Layer.provide(TestPlatform));

/** The suite migrates and truncates its cluster, so it checks that the cluster is disposable first. */
const disposableCluster = Layer.effectDiscard(
  Effect.sync(() => assertDisposable(config.postgresUrl)),
);

const subtle = globalThis.crypto.subtle;

/** The snapshot service over the verifier of the engine secret, as `AuthLive` builds it. */
const snapshotService = makeIdentitySnapshotService().pipe(
  Effect.provide(HmacTagVerifierLive(subtle, config.secret)),
);

const authLayer = AuthLive(config, subtle).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      databaseLayer,
      AuthPoolLive(config, {
        maxConnections: 4,
        applicationName: "auth-live-test-adapter",
        pipeline: true,
        startupOptions: "-c search_path=auth",
      }),
    ),
  ),
  Layer.provide(disposableCluster),
  Layer.provide(TestPlatform),
);

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "Better Auth session hardening configuration",
  (it) => {
    const optionsPool = new Pool({ max: 1 });

    afterAll(() => optionsPool.end());

    const diagnostics: string[] = [];

    const diagnostic = () => {
      diagnostics.push("auth diagnostic");
    };

    const localOptions = (
      sql: SqlClient.SqlClient,
      run: Effect.Success<typeof makeBetterAuthCallbackRunner>,
    ) => makeAuthEngineOptions(config, optionsPool, sql, run, diagnostic);

    const previewOptions = (
      sql: SqlClient.SqlClient,
      run: Effect.Success<typeof makeBetterAuthCallbackRunner>,
    ) =>
      makeAuthEngineOptions(
        {
          ...config,
          oauth: {
            canonicalOrigin: "https://preview.example.invalid",
            dashboardOrigin: "https://preview.example.invalid",
            nativeApiResource: "urn:vektorprogrammet:native-api",
          },
          trustedOrigins: ["https://preview.example.invalid"],
          secureCookies: true,
        },
        optionsPool,
        sql,
        run,
        diagnostic,
      );

    it.effect("selects exact local and secure-prefixed cookie attributes", () =>
      Effect.gen(function* () {
        const sql = yield* Database;
        const run = yield* makeBetterAuthCallbackRunner;
        const local = getCookies(localOptions(sql, run)).sessionToken;
        const preview = getCookies(previewOptions(sql, run)).sessionToken;
        expect(local).toMatchObject({
          name: "better-auth.session_token",
          attributes: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
        });
        expect(preview).toMatchObject({
          name: "__Secure-better-auth.session_token",
          attributes: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
        });
      }),
    );

    it.effect("rejects the public sign-up route before creating identity state", () =>
      Effect.gen(function* () {
        const engine = betterAuth({
          ...localOptions(yield* Database, yield* makeBetterAuthCallbackRunner),
          database: memoryAdapter({ ...oauthMemoryModels }),
        });

        const body = yield* jsonText({
          name: "Forbidden",
          email: "forbidden@example.invalid",
          password: "ForbiddenSignUp!0054",
        });

        const response = yield* Effect.promise(() =>
          engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/sign-up/email", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://127.0.0.1:8790",
              },
              body,
            }),
          ),
        );

        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
        });
      }),
    );

    it.effect(
      "accepts signed cookies only while their session remains persisted",
      () =>
        Effect.gen(function* () {
          const snapshotMemory = {
            user: [],
            session: [],
            account: [],
            verification: [],
            ...oauthMemoryModels,
          };

          const issuingEngine = betterAuth({
            baseURL: config.oauth.canonicalOrigin,
            secret: config.secret,
            trustedOrigins: [...config.trustedOrigins],
            database: memoryAdapter(snapshotMemory),
            advanced: { useSecureCookies: false },
            emailAndPassword: { enabled: true, minPasswordLength: 12 },
          });

          const issued = yield* Effect.promise(() =>
            issuingEngine.api.signUpEmail({
              body: {
                name: "Snapshot",
                email: "snapshot@example.invalid",
                password: "SnapshotCookie!0055",
              },
              asResponse: true,
            }),
          );

          const cookie = issued.headers.getSetCookie()[0]?.split(";")[0];

          const body = yield* Effect.promise(() => issued.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
              ),
            ),
          );

          expect(cookie).toBeDefined();

          const [session] = yield* Schema.decodeEffect(
            Schema.Array(
              Schema.Struct({ id: Schema.String, token: Schema.String, expiresAt: Schema.Date }),
            ),
          )(snapshotMemory.session);

          if (session === undefined) {
            return yield* Effect.die(new Error("Sign-up did not persist its session"));
          }

          yield* Database.use((sql) =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${body.user.id}, 'Snapshot', 'Owner')`;
              yield* sql`INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES (${body.user.id}, 'Snapshot', 'snapshot@example.invalid', TRUE)`;
              yield* sql`INSERT INTO auth."session" (id, token, "expiresAt", "updatedAt", "userId") VALUES (${session.id}, ${session.token}, ${session.expiresAt.toISOString()}, date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), ${body.user.id})`;
            }),
          );
          const snapshotIdentity = yield* snapshotService;

          const resolve = (cookieHeader: string | undefined) =>
            snapshotIdentity.resolveSession(
              cookieHeader,
              AuthorizationInstant.make("2026-09-01T12:00:00.000Z"),
            );

          expect((yield* resolve(cookie)).personId).toBe(body.user.id);
          expect(yield* Effect.flip(resolve("better-auth.session_token=raw"))).toBeInstanceOf(
            IdentitySessionNotFound,
          );
          yield* Database.use((sql) => sql`DELETE FROM auth."session" WHERE id = ${session.id}`);
          expect(yield* Effect.flip(resolve(cookie))).toBeInstanceOf(IdentitySessionNotFound);
        }),
      15_000,
    );

    it.effect(
      "revokes owned persisted sessions and commits the audit together",
      () =>
        Effect.gen(function* () {
          const actor = new IdentityActor({
            personId: PersonId.make("snapshot-mutation-person"),
            sessionId: "snapshot-mutation-session",
            expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
          });

          const observed = yield* Database.use((sql) =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${actor.personId}, 'Snapshot', 'Owner')`;
              yield* sql`INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES (${actor.personId}, 'Owner', 'owner@example.invalid', TRUE)`;
              yield* sql`INSERT INTO auth."session" (id, token, "expiresAt", "updatedAt", "userId") VALUES (${actor.sessionId}, 'snapshot-token', '2031-09-16', date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), ${actor.personId})`;

              const snapshotIdentity = yield* snapshotService;

              const result = yield* snapshotIdentity.revokeSession(
                actor,
                actor.sessionId,
                requestContext,
              );

              const sessions =
                yield* sql`SELECT id FROM auth."session" WHERE id = ${actor.sessionId}`;

              const audit =
                yield* sql`SELECT event_kind, subject_person_id, session_id FROM auth.identity_security_audit WHERE request_correlation = ${requestContext.requestCorrelation}`;

              const retry = yield* Effect.flip(
                snapshotIdentity.revokeSession(actor, actor.sessionId, requestContext),
              );

              return { result, sessions, audit, retry };
            }),
          );

          expect(observed.result).toEqual({ setCookies: [] });
          expect(observed.sessions).toEqual([]);
          expect(observed.audit).toEqual([
            {
              event_kind: "session-revoked-one",
              subject_person_id: actor.personId,
              session_id: actor.sessionId,
            },
          ]);
          expect(observed.retry).toBeInstanceOf(IdentityOwnedSessionNotFound);
        }),
      15_000,
    );
  },
);

describe("audited Better Auth response ordering", () => {
  it.effect(
    "does not return credential success when the required post-transition audit append fails",
    () =>
      Effect.gen(function* () {
        const ordering: string[] = [];

        const actor = new IdentityActor({
          personId: PersonId.make("audit-ordering-person"),
          sessionId: "audit-ordering-session",
          expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
        });

        const handler = auditedAuthHandler(
          () =>
            Effect.sync(() => {
              ordering.push("credential-state-transition");

              return Response.json(
                { user: { id: actor.personId } },
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "set-cookie": "better-auth.session_token=opaque-test-value; Path=/; HttpOnly",
                  },
                },
              );
            }),
          {
            resolveSession: (cookieHeader) =>
              Effect.sync(() => {
                ordering.push("persisted-session-resolved");
                expect(cookieHeader).toBe("better-auth.session_token=opaque-test-value");

                return actor;
              }),
            recordSecurityEvent: (event) =>
              Effect.suspend(() => {
                ordering.push("audit-append-attempted");
                expect(event).toMatchObject({
                  eventKind: "sign-in-success",
                  subjectPersonId: actor.personId,
                  sessionId: actor.sessionId,
                });

                return Effect.fail(
                  new IdentityEngineError({
                    operation: "recordSecurityEvent",
                    message: "injected audit append failure",
                  }),
                );
              }),
          },
        );

        const response = yield* handler(
          new Request("http://127.0.0.1:8790/api/auth/sign-in/email", { method: "POST" }),
          requestContext,
        );

        expect(ordering).toEqual([
          "credential-state-transition",
          "persisted-session-resolved",
          "audit-append-attempted",
        ]);
        expect(response.status).toBe(503);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: { tag: "IdentityEngineError" },
        });
      }),
  );
});

dsl("AuthLive (spec 0054)", () => {
  layer(authLayer, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "signs in against real credentials, resolves the cookie to the seeded PersonId, and fails closed after sign-out",
      () =>
        Effect.gen(function* () {
          yield* Database.use((database) => database.health);
          yield* Database.use(resetAuthData);
          yield* Database.use((observer) =>
            observer.unsafe(
              `INSERT INTO public.person_profiles (person_id, first_name, last_name)
             VALUES ($1, 'Auth', 'Live Test')
             ON CONFLICT DO NOTHING`,
              [cohort.personId],
            ),
          );
          yield* seedCredentialIdentity();

          const engine = yield* AuthEngine;
          const identity = yield* Identity;
          const snapshotIdentity = yield* IdentitySnapshot;

          const signedIn = yield* identity.signIn({
            email: cohort.email,
            password: cohort.password,
          });

          const cookie = signedIn.setCookie.split(";")[0] ?? signedIn.setCookie;
          expect(signedIn.actor.personId).toBe(cohort.personId);

          const snapshotActor = yield* Database.use((database) =>
            database.withTransaction(
              Effect.gen(function* () {
                yield* database`
                  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
                `.pipe(Effect.asVoid);

                return yield* snapshotIdentity.resolveSession(
                  cookie,
                  AuthorizationInstant.make(DateTime.formatIso(yield* DateTime.now)),
                );
              }),
            ),
          );

          expect(snapshotActor.personId).toBe(cohort.personId);
          expect(signedIn.setCookie).toMatch(/HttpOnly/i);

          const handlerResponse = yield* engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/get-session", {
              headers: new Headers({ cookie }),
            }),
            requestContext,
          );

          const handlerBody = yield* Effect.promise(() => handlerResponse.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
              ),
            ),
          );

          expect(handlerBody.user?.id).toBe(cohort.personId);

          yield* identity.signOut(cookie);

          const revoked = yield* Effect.exit(identity.resolveSession(cookie));

          expect(revoked._tag).toBe("Failure");
        }),
      120_000,
    );

    it.effect("fails closed for unknown session cookies", () =>
      Effect.gen(function* () {
        assertDisposable(config.postgresUrl);
        const identity = yield* Identity;

        const result = yield* Effect.exit(identity.resolveSession("vp.session_token=unknown"));

        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect(
      "enforces owner-only revocation, immediate persisted invalidation, retry semantics, and audit transaction ordering",
      () =>
        Effect.gen(function* () {
          assertDisposable(config.postgresUrl);
          yield* Database.use(resetAuthData);
          yield* Database.use((observer) =>
            observer.unsafe(
              `INSERT INTO public.person_profiles (person_id, first_name, last_name)
           VALUES
             ($1, 'Auth', 'Live Test'),
             ($2, 'Other', 'Live Test')
           ON CONFLICT DO NOTHING`,
              [cohort.personId, otherCohort.personId],
            ),
          );
          yield* seedCredentialIdentity();
          yield* seedCredentialIdentity(otherCohort);

          const identity = yield* Identity;

          const signIn = (person: Readonly<{ email: string; password: string }>) =>
            identity.signIn(person).pipe(
              Effect.map((signedIn) => ({
                cookie: signedIn.setCookie.split(";")[0] ?? signedIn.setCookie,
                sessionId: signedIn.actor.sessionId,
              })),
            );

          const context = (requestCorrelation: string) =>
            new IdentityRequestContext({
              requestCorrelation,
              sourceIp: "127.0.0.1",
              userAgent: "auth-live-hardening-test",
            });

          const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.exit(effect).pipe(Effect.map(Exit.isFailure));

          const current = yield* signIn(cohort);
          const owned = yield* signIn(cohort);
          const nonOwned = yield* signIn(otherCohort);
          const listed = yield* identity.listSessions(current.cookie);
          expect(listed).toHaveLength(2);
          expect(listed.filter(({ current: isCurrent }) => isCurrent)).toHaveLength(1);
          expect(listed.map(({ sessionId }) => sessionId)).not.toContain(nonOwned.sessionId);

          const missingOutcomes = yield* Effect.forEach(
            ["missing-session", nonOwned.sessionId],
            (sessionId) =>
              identity
                .revokeSession(current.cookie, sessionId, context(`concealed-${sessionId}`))
                .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (cause) => cause })),
            { concurrency: "unbounded" },
          );

          expect(missingOutcomes.every(Schema.is(IdentityOwnedSessionNotFound))).toBe(true);

          yield* Database.use((observer) =>
            observer.unsafe(`
          CREATE OR REPLACE FUNCTION auth.fail_identity_security_audit_test()
          RETURNS trigger AS $$
          BEGIN
            IF NEW.request_correlation = 'auth-live-rollback' THEN
              RAISE EXCEPTION 'injected identity audit failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
                    `),
          );
          yield* Database.use((observer) =>
            observer.unsafe(`
          CREATE TRIGGER fail_identity_security_audit_test
          BEFORE INSERT ON auth.identity_security_audit
          FOR EACH ROW EXECUTE FUNCTION auth.fail_identity_security_audit_test()
                    `),
          );
          expect(
            yield* Effect.flip(
              identity.revokeSession(
                current.cookie,
                owned.sessionId,
                context("auth-live-rollback"),
              ),
            ),
          ).toBeInstanceOf(IdentityEngineError);
          expect(yield* identity.resolveSession(owned.cookie)).toMatchObject({
            sessionId: owned.sessionId,
          });
          yield* Database.use((observer) =>
            observer.unsafe(
              `DROP TRIGGER fail_identity_security_audit_test ON auth.identity_security_audit`,
            ),
          );
          yield* Database.use((observer) =>
            observer.unsafe(`DROP FUNCTION auth.fail_identity_security_audit_test()`),
          );

          yield* identity.revokeSession(
            current.cookie,
            owned.sessionId,
            context("auth-live-revoke-one"),
          );
          expect(yield* failed(identity.resolveSession(owned.cookie))).toBe(true);
          expect(
            yield* Effect.flip(
              identity.revokeSession(
                current.cookie,
                owned.sessionId,
                context("auth-live-revoke-one-retry"),
              ),
            ),
          ).toBeInstanceOf(IdentityOwnedSessionNotFound);

          const otherOne = yield* signIn(cohort);
          const otherTwo = yield* signIn(cohort);
          yield* identity.revokeOtherSessions(current.cookie, context("auth-live-revoke-others"));
          expect(yield* identity.resolveSession(current.cookie)).toMatchObject({
            sessionId: current.sessionId,
          });
          expect(yield* failed(identity.resolveSession(otherOne.cookie))).toBe(true);
          expect(yield* failed(identity.resolveSession(otherTwo.cookie))).toBe(true);
          expect(
            yield* identity.revokeOtherSessions(
              current.cookie,
              context("auth-live-revoke-others-repeat"),
            ),
          ).toEqual({ setCookies: [] });

          yield* identity.revokeAllSessions(current.cookie, context("auth-live-revoke-all"));
          expect(yield* failed(identity.resolveSession(current.cookie))).toBe(true);
          expect(
            yield* failed(
              identity.revokeAllSessions(current.cookie, context("auth-live-revoke-all-retry")),
            ),
          ).toBe(true);

          const ended = yield* signIn(cohort);
          yield* identity.revokeCurrentSession(ended.cookie, context("auth-live-end-current"));
          expect(yield* failed(identity.resolveSession(ended.cookie))).toBe(true);
          expect(
            yield* failed(
              identity.revokeCurrentSession(ended.cookie, context("auth-live-end-current-retry")),
            ),
          ).toBe(true);

          const audit = yield* Database.use((observer) =>
            observer.unsafe<{
              eventKind: string;
              requestCorrelation: string;
              details: { readonly affectedSessionCount: number; readonly outcomeCode: string };
            }>(`SELECT
             event_kind AS "eventKind",
             request_correlation AS "requestCorrelation",
             details
           FROM auth.identity_security_audit
           ORDER BY occurred_at, event_id`),
          );

          expect(
            audit.map(({ eventKind, requestCorrelation }) => ({
              eventKind,
              requestCorrelation,
            })),
          ).toEqual([
            {
              eventKind: "session-revoked-one",
              requestCorrelation: "auth-live-revoke-one",
            },
            {
              eventKind: "session-revoked-others",
              requestCorrelation: "auth-live-revoke-others",
            },
            {
              eventKind: "session-revoked-all",
              requestCorrelation: "auth-live-revoke-all",
            },
            {
              eventKind: "sign-out",
              requestCorrelation: "auth-live-end-current",
            },
          ]);
          expect(
            audit.every(
              ({ details }) =>
                Object.keys(details).sort().join(",") === "affectedSessionCount,outcomeCode" &&
                Number.isSafeInteger(details.affectedSessionCount),
            ),
          ).toBe(true);
        }),
      120_000,
    );
    /**
     * Regression guard for the AuthLive pool-lifetime bug (spec 0054):
     * keeping the AuthLive layer alive must keep its pg Pool usable across
     * handler calls separated by time outside Effect.
     */
    it.effect(
      "keeps its pg Pool alive for sequential handler calls",
      () =>
        Effect.gen(function* () {
          assertDisposable(config.postgresUrl);

          yield* Database.use(resetAuthData);
          yield* Database.use((observer) =>
            observer.unsafe(
              `INSERT INTO public.person_profiles (person_id, first_name, last_name)
               VALUES ($1, 'Auth', 'Live Test')
               ON CONFLICT DO NOTHING`,
              [cohort.personId],
            ),
          );
          yield* seedCredentialIdentity();

          const engine = yield* AuthEngine;

          const credentials = yield* jsonText({ email: cohort.email, password: cohort.password });

          const first = yield* engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/sign-in/email", {
              method: "POST",
              headers: new Headers({ "content-type": "application/json" }),
              body: credentials,
            }),
            requestContext,
          );

          expect(first.ok).toBe(true);
          yield* Effect.promise(() => Promise.resolve());

          const second = yield* engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/sign-in/email", {
              method: "POST",
              headers: new Headers({ "content-type": "application/json" }),
              body: credentials,
            }),
            requestContext,
          );

          expect(second.ok).toBe(true);
        }),
      120_000,
    );

    it.effect("keeps the provisioning callsite closed to request-shaped contexts", () =>
      Effect.sync(() => {
        const wrongContextCall = () => {
          // @ts-expect-error A Request is not the actual native engine context; EX-0037 cannot widen this callsite.
          return withNativeAuthProvisioning(new Request("http://native.test/"), () =>
            Promise.resolve(undefined),
          );
        };

        expectTypeOf(wrongContextCall).toBeFunction();
      }),
    );
    it.effect("admits only live explicit provisioning with current enabled Person facts", () =>
      Effect.gen(function* () {
        yield* Database.use(resetAuthData);
        yield* Database.use((sql) =>
          sql.unsafe(
            "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES ($1,'Marker','Owner') ON CONFLICT DO NOTHING",
            [cohort.personId],
          ),
        );
        yield* seedCredentialIdentity();
        const engine = yield* AuthEngine;
        const context = yield* Effect.promise(() => engine.engine.$context);

        const account = (userId: string, accountId: string) => ({
          userId,
          accountId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          password: "synthetic-marker-hash",
        });

        yield* Database.use((sql) =>
          sql.unsafe('UPDATE auth."user" SET access_revision=7 WHERE id=$1', [cohort.personId]),
        );
        yield* withNativeAuthProvisioning(context, () =>
          context.internalAdapter.linkAccount(account(cohort.personId, "marker-current")),
        );

        const rows = yield* Database.use((sql) =>
          sql.unsafe(
            'SELECT access_revision AS revision FROM auth."account" WHERE "accountId"=$1',
            ["marker-current"],
          ),
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ revision: Schema.Int }))),
          ),
        );

        expect(rows).toEqual([{ revision: 7 }]);
        yield* Database.use((sql) =>
          sql.unsafe('UPDATE auth."user" SET access_disabled=TRUE WHERE id=$1', [cohort.personId]),
        );

        for (const personId of [cohort.personId, "unknown-marker-person"]) {
          const failure = yield* Effect.flip(
            withNativeAuthProvisioning(context, () =>
              context.internalAdapter.linkAccount(account(personId, "marker-denied-" + personId)),
            ),
          );

          expect(failure.cause).toMatchObject({
            body: { code: "INVALID_SESSION", message: "Account access unavailable" },
          });
        }
      }),
    );

    it.effect("rejects forged and copied provisioning contexts at the real adapter hook", () =>
      Effect.gen(function* () {
        yield* Database.use(resetAuthData);
        yield* Database.use((sql) =>
          sql.unsafe(
            "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES ($1,'Marker','Owner') ON CONFLICT DO NOTHING",
            [cohort.personId],
          ),
        );
        yield* seedCredentialIdentity();
        const engine = yield* AuthEngine;
        const context = yield* Effect.promise(() => engine.engine.$context);

        const link = () =>
          context.internalAdapter.linkAccount({
            userId: cohort.personId,
            accountId: "forged-marker-account",
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            password: "synthetic-marker-hash",
          });

        const foreignContext = (yield* withNativeAuthProvisioning(context, getCurrentAuthContext))
          .context;

        for (const forged of [
          { context: foreignContext, nativeProvisioningMarker: true },
          { context: foreignContext, [Symbol.for("NativeAuthProvisioning")]: true },
        ]) {
          const failure = yield* Effect.flip(
            Effect.tryPromise(() => runWithEndpointContext(forged, link).then((result) => result)),
          );

          expect(failure.cause).toMatchObject({ body: { code: "INVALID_SESSION" } });
        }

        const copiedFailure = yield* Effect.flip(
          withNativeAuthProvisioning(context, () =>
            getCurrentAuthContext().then((marked) =>
              runWithEndpointContext({ ...marked }, link).then((result) => result),
            ),
          ),
        );

        expect(copiedFailure.cause).toMatchObject({ body: { code: "INVALID_SESSION" } });
        const expired = yield* withNativeAuthProvisioning(context, getCurrentAuthContext);

        const expiredFailure = yield* Effect.flip(
          Effect.tryPromise(() => runWithEndpointContext(expired, link).then((result) => result)),
        );

        expect(expiredFailure.cause).toMatchObject({ body: { code: "INVALID_SESSION" } });
      }),
    );

    it.effect("revokes provisioning authority on failure and interruption before late hooks", () =>
      Effect.gen(function* () {
        yield* Database.use(resetAuthData);
        yield* Database.use((sql) =>
          sql.unsafe(
            "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES ($1,'Marker','Owner') ON CONFLICT DO NOTHING",
            [cohort.personId],
          ),
        );
        yield* seedCredentialIdentity();
        const engine = yield* AuthEngine;
        const context = yield* Effect.promise(() => engine.engine.$context);
        const captured = Promise.withResolvers<AuthEndpointContext>();
        const pending = Promise.withResolvers<void>();

        const fiber = yield* withNativeAuthProvisioning(context, () =>
          getCurrentAuthContext().then((marked) => {
            captured.resolve(marked);

            return pending.promise;
          }),
        ).pipe(Effect.forkChild);

        const interruptedContext = yield* Effect.promise(() => captured.promise);
        yield* Fiber.interrupt(fiber);

        const link = () =>
          context.internalAdapter.linkAccount({
            userId: cohort.personId,
            accountId: "late-marker-account",
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            password: "synthetic-marker-hash",
          });

        const interruptedFailure = yield* Effect.flip(
          Effect.tryPromise(() =>
            runWithEndpointContext(interruptedContext, link).then((result) => result),
          ),
        );

        expect(interruptedFailure.cause).toMatchObject({ body: { code: "INVALID_SESSION" } });
        pending.resolve();
        const failedCapture = Promise.withResolvers<AuthEndpointContext>();
        yield* Effect.flip(
          withNativeAuthProvisioning(context, () =>
            getCurrentAuthContext().then((marked) => {
              failedCapture.resolve(marked);

              return Promise.reject(new Error("synthetic provisioning failure"));
            }),
          ),
        );
        const failedContext = yield* Effect.promise(() => failedCapture.promise);

        const afterFailure = yield* Effect.flip(
          Effect.tryPromise(() =>
            runWithEndpointContext(failedContext, link).then((result) => result),
          ),
        );

        expect(afterFailure.cause).toMatchObject({ body: { code: "INVALID_SESSION" } });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "keeps each real endpoint hook context while an earlier request fiber is draining",
      () =>
        Effect.gen(function* () {
          yield* Database.use(resetAuthData);
          yield* Database.use((sql) =>
            sql.unsafe(
              "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES ($1,'Context','First'),($2,'Context','Second') ON CONFLICT DO NOTHING",
              [cohort.personId, otherCohort.personId],
            ),
          );
          yield* seedCredentialIdentity(cohort);
          yield* seedCredentialIdentity(otherCohort);
          const sql = yield* Database;
          const pool = yield* AuthPgPool;
          const run = yield* makeBetterAuthCallbackRunner;
          const firstHook = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();

          const seen: Array<{
            personId: string;
            revision: number;
            ownsContext: boolean;
            context: GenericEndpointContext | null;
          }> = [];

          const options = makeAuthEngineOptions(config, pool, sql, run, () => undefined);
          const original = options.databaseHooks.session?.create?.before;

          if (original === undefined) return yield* Effect.die("Native session hook is missing");

          const observedEngine = betterAuth({
            ...options,
            databaseHooks: {
              ...options.databaseHooks,
              session: {
                create: {
                  before: (data, context) =>
                    getCurrentAuthContext()
                      .then((current) => {
                        const evidence = Result.getOrThrow(
                          Schema.decodeUnknownResult(
                            Schema.Struct({
                              nativeAccessEvidence: Schema.Struct({
                                personId: Schema.String,
                                revision: Schema.Int,
                              }),
                            }),
                          )(context?.context),
                        ).nativeAccessEvidence;

                        seen.push({
                          personId: evidence.personId,
                          revision: evidence.revision,
                          ownsContext: current === context,
                          context,
                        });

                        return original(data, context);
                      })
                      .then((result) =>
                        data.userId === cohort.personId
                          ? run(
                              Deferred.succeed(firstHook, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseFirst)),
                                Effect.as(result),
                              ),
                            )
                          : result,
                      ),
                },
              },
            },
          });

          const request = (person: typeof cohort | typeof otherCohort) =>
            Effect.flatMap(jsonText({ email: person.email, password: person.password }), (body) =>
              Effect.tryPromise(() =>
                observedEngine.handler(
                  new Request("http://127.0.0.1:8790/api/auth/sign-in/email", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                  }),
                ),
              ),
            );

          const first = yield* request(cohort).pipe(Effect.forkChild);
          yield* Deferred.await(firstHook);
          const secondResponse = yield* request(otherCohort);
          expect(secondResponse.ok).toBe(true);
          expect(first.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(releaseFirst, undefined);
          expect((yield* Fiber.join(first)).ok).toBe(true);
          expect((yield* request(cohort)).ok).toBe(true);
          expect((yield* request(otherCohort)).ok).toBe(true);
          expect(
            seen.map(({ personId, revision, ownsContext }) => ({
              personId,
              revision,
              ownsContext,
            })),
          ).toEqual([
            { personId: cohort.personId, revision: 0, ownsContext: true },
            { personId: otherCohort.personId, revision: 0, ownsContext: true },
            { personId: cohort.personId, revision: 0, ownsContext: true },
            { personId: otherCohort.personId, revision: 0, ownsContext: true },
          ]);
          expect(seen[0]?.context === seen[1]?.context).toBe(false);

          const sessions = yield* sql
            .unsafe(
              'SELECT id, "userId" AS "personId" FROM auth."session" WHERE "userId" IN ($1,$2)',
              [cohort.personId, otherCohort.personId],
            )
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ id: Schema.String, personId: Schema.String })),
                ),
              ),
            );

          expect(sessions).toHaveLength(4);
          expect(sessions[0]?.id === sessions[1]?.id).toBe(false);
        }).pipe(Effect.scoped),
      120_000,
    );
  });
});
