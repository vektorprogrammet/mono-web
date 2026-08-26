import { createLocalAccountIssuer } from "better-auth";
import { Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { Identity } from "@vektorprogrammet/domain/identity";
import { AuthLive, AuthEngine } from "./auth-live.js";
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
  baseURL: "http://127.0.0.1:8790",
} as const;

const cohort = {
  personId: "auth-live-test-person",
  email: "auth-live-test@example.invalid",
  password: "AuthLiveTest!password-0054",
} as const;

const assertDisposable = (url: string): void => {
  const parsed = new URL(url);
  expect(["postgres:", "postgresql:"]).toContain(parsed.protocol);
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(parsed.hostname);
  expect(decodeURIComponent(parsed.pathname.slice(1))).toMatch(/proof|test/i);
};

/** Provisions the auth.user + credential account rows for the cohort. */
const seedCredentialIdentity = async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* AuthEngine;
      const context = yield* Effect.promise(() => engine.engine.$context);
      yield* Effect.tryPromise(() =>
        context.internalAdapter.createUser(
          {
            id: cohort.personId,
            name: "Auth Live Test",
            email: cohort.email,
            emailVerified: true,
          },
          { method: "email-password" },
        ),
      ).pipe(Effect.ignore);
      const passwordHash = yield* Effect.promise(() => context.password.hash(cohort.password));
      yield* Effect.tryPromise(() =>
        context.internalAdapter.linkAccount({
          accountId: cohort.personId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          userId: cohort.personId,
          password: passwordHash,
        }),
      );
    }),
  );
};
const resetAuthData = async (pool: Pool) => {
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

        const signedIn = yield* Effect.tryPromise(() =>
          identity.signIn({ email: cohort.email, password: cohort.password }),
        );
        const cookie = signedIn.setCookie.split(";")[0] ?? signedIn.setCookie;
        expect(signedIn.actor.personId).toBe(cohort.personId);
        expect(signedIn.setCookie).toMatch(/HttpOnly/i);
        const handlerResponse = yield* Effect.promise(() =>
          engine.handler(
            new Request("http://127.0.0.1:8790/api/auth/get-session", {
              headers: new Headers({ cookie }),
            }),
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
