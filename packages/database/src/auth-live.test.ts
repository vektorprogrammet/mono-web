import { betterAuth, createLocalAccountIssuer } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies } from "better-auth/cookies";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorizationInstant } from "@vektorprogrammet/domain/authz";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import {
  Identity,
  IdentityActor,
  IdentityOwnedSessionNotFound,
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
import { makeAuthEngineOptions } from "./auth-engine.js";
import { DatabaseLive } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

/**
 * Focused spec 0054 checks for the Layer-scoped better-auth engine behind
 * AuthLive. Requires a disposable loopback PostgreSQL whose name contains
 * "proof" or "test"; everything else runs on PGlite previews without auth.
 */
const authTestUrl = process.env.AUTH_TEST_PG_URL;

const config = {
  postgresUrl: authTestUrl ?? "",
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

const assertDisposable = (url: string): void => {
  const parsed = new URL(url);
  expect(["postgres:", "postgresql:"]).toContain(parsed.protocol);
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(parsed.hostname);
  expect(decodeURIComponent(parsed.pathname.slice(1))).toMatch(/proof|test/i);
};

/** Provisions one auth.user + credential account pair. */
const seedCredentialIdentity = async (
  person: Readonly<{ personId: string; email: string; password: string }> = cohort,
) => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* AuthEngine;
      const context = yield* Effect.promise(() => engine.engine.$context);
      yield* Effect.tryPromise(() =>
        context.internalAdapter.createUser(
          {
            id: person.personId,
            name: "Auth Live Test",
            email: person.email,
            emailVerified: true,
          },
          { method: "email-password" },
        ),
      ).pipe(Effect.ignore);
      const passwordHash = yield* Effect.promise(() => context.password.hash(person.password));
      yield* Effect.tryPromise(() =>
        context.internalAdapter.linkAccount({
          accountId: person.personId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          userId: person.personId,
          password: passwordHash,
        }),
      );
    }),
  );
};
const resetAuthData = async (pool: Pool) => {
  await pool.query(`TRUNCATE auth.identity_security_audit`);
  await pool.query(`DELETE FROM auth."session"`);
  await pool.query(`DELETE FROM auth."account"`);
  await pool.query(`DELETE FROM auth."user"`);
};
const dsl = authTestUrl === undefined ? describe.skip : describe;

const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "auth-live-focused-test",
  maxConnections: 4,
});
const runtime = makeControlledTestRuntime(AuthLive(config).pipe(Layer.provideMerge(databaseLayer)));

describe("Better Auth session hardening configuration", () => {
  const localOptions = makeAuthEngineOptions(config, {} as Pool);
  const previewOptions = makeAuthEngineOptions(
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
    {} as Pool,
  );

  it("disables public sign-up and omits the cookie cache", () => {
    expect(localOptions.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    });
    expect(localOptions.session).toEqual({
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    });
    expect("cookieCache" in localOptions.session).toBe(false);
  });

  it("selects exact local and secure-prefixed cookie attributes", () => {
    const local = getCookies(localOptions).sessionToken;
    const preview = getCookies(previewOptions).sessionToken;
    expect(local).toMatchObject({
      name: "better-auth.session_token",
      attributes: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
    });
    expect(preview).toMatchObject({
      name: "__Secure-better-auth.session_token",
      attributes: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    });
  });

  it("rejects the public sign-up route before creating identity state", async () => {
    const engine = betterAuth({
      ...makeAuthEngineOptions(config, {} as Pool),
      database: memoryAdapter({ ...oauthMemoryModels }),
    });
    const response = await engine.handler(
      new Request("http://127.0.0.1:8790/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:8790",
        },
        body: JSON.stringify({
          name: "Forbidden",
          email: "forbidden@example.invalid",
          password: "ForbiddenSignUp!0054",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });
  });

  it("verifies the Better Auth cookie before the ambient snapshot reads its session row", async () => {
    const issuingEngine = betterAuth({
      ...localOptions,
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        ...oauthMemoryModels,
      }),
      emailAndPassword: {
        ...localOptions.emailAndPassword,
        disableSignUp: false,
      },
    });
    const issued = await issuingEngine.api.signUpEmail({
      body: {
        name: "Snapshot",
        email: "snapshot@example.invalid",
        password: "SnapshotCookie!0055",
      },
      asResponse: true,
    });
    const cookie = issued.headers.getSetCookie()[0]?.split(";")[0];
    const body = (await issued.json()) as { readonly user: { readonly id: string } };
    expect(cookie).toBeDefined();

    let sessionReads = 0;
    const database = Object.assign(
      (() => {
        sessionReads += 1;
        return Effect.succeed([
          {
            sessionId: "snapshot-session",
            personId: body.user.id,
            expiresAt: new Date("2031-09-16T12:00:00.000Z"),
          },
        ]);
      }) as unknown as DatabaseShape,
      {
        health: Effect.void,
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
    );
    const snapshotIdentity = makeIdentitySnapshotService(config);
    const resolve = (cookieHeader: string | undefined) =>
      snapshotIdentity
        .resolveSession(cookieHeader, AuthorizationInstant.make("2026-09-01T12:00:00.000Z"))
        .pipe(Effect.provideService(Database, database));

    const actor = await Effect.runPromise(resolve(cookie));
    expect(actor.personId).toBe(body.user.id);
    expect(sessionReads).toBe(1);

    const rejected = await Effect.runPromise(Effect.exit(resolve("better-auth.session_token=raw")));
    expect(rejected._tag).toBe("Failure");
    if (rejected._tag === "Failure") {
      expect(rejected.cause.toString()).toContain(IdentitySessionNotFound.name);
    }
    expect(sessionReads).toBe(1);
  });
});

describe("audited Better Auth response ordering", () => {
  it("does not return credential success when the required post-transition audit append fails", async () => {
    const ordering: string[] = [];
    const actor = new IdentityActor({
      personId: PersonId.make("audit-ordering-person"),
      sessionId: "audit-ordering-session",
      expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
    });
    const handler = auditedAuthHandler(
      {
        handler: async () => {
          ordering.push("credential-state-transition");
          return new Response(JSON.stringify({ user: { id: actor.personId } }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "better-auth.session_token=opaque-test-value; Path=/; HttpOnly",
            },
          });
        },
      },
      {
        resolveSession: async (cookieHeader) => {
          ordering.push("persisted-session-resolved");
          expect(cookieHeader).toBe("better-auth.session_token=opaque-test-value");
          return actor;
        },
        recordSecurityEvent: async (event) => {
          ordering.push("audit-append-attempted");
          expect(event).toMatchObject({
            eventKind: "sign-in-success",
            subjectPersonId: actor.personId,
            sessionId: actor.sessionId,
          });
          throw new Error("injected audit append failure");
        },
      },
    );

    const response = await handler(
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
    await expect(response.json()).resolves.toEqual({
      error: { tag: "IdentityEngineError" },
    });
  });
});

dsl("AuthLive (spec 0054)", () => {
  let observer: Pool | undefined;

  afterAll(async () => {
    if (observer !== undefined) {
      await observer.end();
    }
  });

  it("signs in against real credentials, resolves the cookie to the seeded PersonId, and fails closed after sign-out", async () => {
    await runtime.runPromise(Database.use((database) => database.health));
    observer = new Pool({ connectionString: config.postgresUrl });
    await resetAuthData(observer);
    await observer.query(
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
         VALUES ($1, 'Auth', 'Live Test')
         ON CONFLICT DO NOTHING`,
      [cohort.personId],
    );
    await seedCredentialIdentity();
    await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* AuthEngine;
        const identity = yield* Identity;
        const snapshotIdentity = yield* IdentitySnapshot;

        const signedIn = yield* Effect.tryPromise(() =>
          identity.signIn({ email: cohort.email, password: cohort.password }),
        );
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
                AuthorizationInstant.make(new Date().toISOString()),
              );
            }),
          ),
        );
        expect(snapshotActor.personId).toBe(cohort.personId);
        expect(signedIn.setCookie).toMatch(/HttpOnly/i);
        const handlerResponse = yield* Effect.promise(() =>
          engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/get-session", {
              headers: new Headers({ cookie }),
            }),
            requestContext,
          ),
        );
        const handlerBody = (yield* Effect.promise(() => handlerResponse.json())) as {
          user?: { id?: string };
        };
        expect(handlerBody.user?.id).toBe(cohort.personId);

        yield* Effect.tryPromise(() => identity.signOut(cookie));
        const revoked = yield* Effect.exit(
          Effect.tryPromise(() => identity.resolveSession(cookie)),
        );
        expect(revoked._tag).toBe("Failure");
      }),
    );
  }, 120_000);

  it("fails closed for unknown session cookies", async () => {
    assertDisposable(config.postgresUrl);
    await runtime.runPromise(
      Effect.gen(function* () {
        const identity = yield* Identity;
        const result = yield* Effect.exit(
          Effect.tryPromise(() => identity.resolveSession("vp.session_token=unknown")),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it("enforces owner-only revocation, immediate persisted invalidation, retry semantics, and audit transaction ordering", async () => {
    assertDisposable(config.postgresUrl);
    observer ??= new Pool({ connectionString: config.postgresUrl });
    await resetAuthData(observer);
    await observer.query(
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
       VALUES
         ($1, 'Auth', 'Live Test'),
         ($2, 'Other', 'Live Test')
       ON CONFLICT DO NOTHING`,
      [cohort.personId, otherCohort.personId],
    );
    await seedCredentialIdentity();
    await seedCredentialIdentity(otherCohort);
    const identity = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Identity;
      }),
    );
    const signIn = async (
      person: Readonly<{ email: string; password: string }>,
    ): Promise<{ readonly cookie: string; readonly sessionId: string }> => {
      const signedIn = await identity.signIn(person);
      return {
        cookie: signedIn.setCookie.split(";")[0] ?? signedIn.setCookie,
        sessionId: signedIn.actor.sessionId,
      };
    };
    const context = (requestCorrelation: string) =>
      new IdentityRequestContext({
        requestCorrelation,
        sourceIp: "127.0.0.1",
        userAgent: "auth-live-hardening-test",
      });

    const current = await signIn(cohort);
    const owned = await signIn(cohort);
    const nonOwned = await signIn(otherCohort);
    const listed = await identity.listSessions(current.cookie);
    expect(listed).toHaveLength(2);
    expect(listed.filter(({ current: isCurrent }) => isCurrent)).toHaveLength(1);
    expect(listed.map(({ sessionId }) => sessionId)).not.toContain(nonOwned.sessionId);

    const missingOutcomes = await Promise.all(
      ["missing-session", nonOwned.sessionId].map((sessionId) =>
        identity.revokeSession(current.cookie, sessionId, context(`concealed-${sessionId}`)).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      ),
    );
    expect(missingOutcomes.every((cause) => cause instanceof IdentityOwnedSessionNotFound)).toBe(
      true,
    );

    await observer.query(`
      CREATE OR REPLACE FUNCTION auth.fail_identity_security_audit_test()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.request_correlation = 'auth-live-rollback' THEN
          RAISE EXCEPTION 'injected identity audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await observer.query(`
      CREATE TRIGGER fail_identity_security_audit_test
      BEFORE INSERT ON auth.identity_security_audit
      FOR EACH ROW EXECUTE FUNCTION auth.fail_identity_security_audit_test()
    `);
    await expect(
      identity.revokeSession(current.cookie, owned.sessionId, context("auth-live-rollback")),
    ).rejects.toMatchObject({ _tag: "IdentityEngineError" });
    await expect(identity.resolveSession(owned.cookie)).resolves.toMatchObject({
      sessionId: owned.sessionId,
    });
    await observer.query(
      `DROP TRIGGER fail_identity_security_audit_test ON auth.identity_security_audit`,
    );
    await observer.query(`DROP FUNCTION auth.fail_identity_security_audit_test()`);

    await identity.revokeSession(current.cookie, owned.sessionId, context("auth-live-revoke-one"));
    await expect(identity.resolveSession(owned.cookie)).rejects.toBeDefined();
    await expect(
      identity.revokeSession(
        current.cookie,
        owned.sessionId,
        context("auth-live-revoke-one-retry"),
      ),
    ).rejects.toBeInstanceOf(IdentityOwnedSessionNotFound);

    const otherOne = await signIn(cohort);
    const otherTwo = await signIn(cohort);
    await identity.revokeOtherSessions(current.cookie, context("auth-live-revoke-others"));
    await expect(identity.resolveSession(current.cookie)).resolves.toMatchObject({
      sessionId: current.sessionId,
    });
    await expect(identity.resolveSession(otherOne.cookie)).rejects.toBeDefined();
    await expect(identity.resolveSession(otherTwo.cookie)).rejects.toBeDefined();
    await expect(
      identity.revokeOtherSessions(current.cookie, context("auth-live-revoke-others-repeat")),
    ).resolves.toEqual({ setCookies: [] });

    await identity.revokeAllSessions(current.cookie, context("auth-live-revoke-all"));
    await expect(identity.resolveSession(current.cookie)).rejects.toBeDefined();
    await expect(
      identity.revokeAllSessions(current.cookie, context("auth-live-revoke-all-retry")),
    ).rejects.toBeDefined();

    const ended = await signIn(cohort);
    await identity.revokeCurrentSession(ended.cookie, context("auth-live-end-current"));
    await expect(identity.resolveSession(ended.cookie)).rejects.toBeDefined();
    await expect(
      identity.revokeCurrentSession(ended.cookie, context("auth-live-end-current-retry")),
    ).rejects.toBeDefined();

    const audit = await observer.query<{
      eventKind: string;
      requestCorrelation: string;
      details: { readonly affectedSessionCount: number; readonly outcomeCode: string };
    }>(
      `SELECT
         event_kind AS "eventKind",
         request_correlation AS "requestCorrelation",
         details
       FROM auth.identity_security_audit
       ORDER BY occurred_at, event_id`,
    );
    expect(
      audit.rows.map(({ eventKind, requestCorrelation }) => ({
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
      audit.rows.every(
        ({ details }) =>
          Object.keys(details).sort().join(",") === "affectedSessionCount,outcomeCode" &&
          Number.isSafeInteger(details.affectedSessionCount),
      ),
    ).toBe(true);
  }, 120_000);
  /**
   * Regression guard for the AuthLive pool-lifetime bug (spec 0054):
   * keeping one ManagedRuntime alive must keep its pg Pool usable across
   * handler calls separated by time outside Effect.
   */
  it("keeps its pg Pool alive for sequential handler calls", async () => {
    assertDisposable(config.postgresUrl);
    if (observer === undefined) {
      observer = new Pool({ connectionString: config.postgresUrl });
    }
    await resetAuthData(observer);
    await seedCredentialIdentity();

    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* AuthEngine;
        return yield* Effect.tryPromise(() =>
          engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/sign-in/email", {
              method: "POST",
              headers: new Headers({ "content-type": "application/json" }),
              body: JSON.stringify({ email: cohort.email, password: cohort.password }),
            }),
            requestContext,
          ),
        );
      }),
    );
    expect(first.ok).toBe(true);
    await Promise.resolve();

    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* AuthEngine;
        return yield* Effect.tryPromise(() =>
          engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/sign-in/email", {
              method: "POST",
              headers: new Headers({ "content-type": "application/json" }),
              body: JSON.stringify({ email: cohort.email, password: cohort.password }),
            }),
            requestContext,
          ),
        );
      }),
    );
    expect(second.ok).toBe(true);
  }, 120_000);
});

afterAll(async () => {
  await runtime.dispose();
});
