import { readFile } from "node:fs/promises"
import { createLocalAccountIssuer } from "better-auth"
import { Effect, ManagedRuntime } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Auth } from "@vektorprogrammet/domain/auth"
import { AuthLive, AuthEngine } from "./auth-live.js"

/**
 * Focused spec 0054 checks for the Layer-scoped better-auth engine behind
 * AuthLive. Requires a disposable loopback PostgreSQL whose name contains
 * "proof" or "test"; everything else runs on PGlite previews without auth.
 */
const authTestUrl = process.env.AUTH_TEST_PG_URL

const config = {
  postgresUrl: authTestUrl ?? "",
  secret: "auth-live-focused-test-secret-at-least-32-chars",
  baseURL: "http://127.0.0.1:8790",
} as const

const cohort = {
  personId: "auth-live-test-person",
  email: "auth-live-test@example.invalid",
  password: "AuthLiveTest!password-0054",
} as const

const assertDisposable = (url: string): void => {
  const parsed = new URL(url)
  expect(["postgres:", "postgresql:"]).toContain(parsed.protocol)
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(parsed.hostname)
  expect(decodeURIComponent(parsed.pathname.slice(1))).toMatch(/proof|test/i)
}

/** Provisions the auth.user + credential account rows for the cohort. */
const seedCredentialIdentity = async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* AuthEngine
      const context = yield* Effect.promise(() => engine.engine.$context)
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
      ).pipe(Effect.ignore)
      const passwordHash = yield* Effect.promise(() => context.password.hash(cohort.password))
      yield* Effect.tryPromise(() =>
        context.internalAdapter.linkAccount({
          accountId: cohort.personId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          userId: cohort.personId,
          password: passwordHash,
        }),
      )
    }).pipe(Effect.provide(AuthLive(config))),
  )
}

const dsl = authTestUrl === undefined ? describe.skip : describe

// One runtime per suite mirrors src/database.test.ts execution style and keeps
// the scoped auth engine (and its pool) alive across both tests.
const runtime = ManagedRuntime.make(AuthLive(config))

dsl("AuthLive (spec 0054)", () => {
  let observer: Pool | undefined

  afterAll(async () => {
    // auth.user rows reference person_profiles, so only the pool is closed
    // here; the next run's `DROP SCHEMA IF EXISTS auth CASCADE` plus the
    // person delete in the main test body reset the cohort.
    if (observer !== undefined) {
      await observer.end()
    }
  })

  it(
    "signs in against real credentials, resolves the cookie to the seeded PersonId, and fails closed after sign-out",
    async () => {
      assertDisposable(config.postgresUrl)
      observer = new Pool({ connectionString: config.postgresUrl })
      await observer.query(
        `INSERT INTO public.person_profiles (person_id, first_name, last_name)
         VALUES ($1, 'Auth', 'Live Test')
         ON CONFLICT DO NOTHING`,
        [cohort.personId],
      )
      const cleanup = new Pool({ connectionString: config.postgresUrl })
      await cleanup.query(`DROP SCHEMA IF EXISTS auth CASCADE`)
      // Re-apply the checked-in migration so the auth schema is byte-identical.
      await cleanup.query(
        await readFile(
          new URL("../migrations/0015-native-identity-better-auth.sql", import.meta.url),
          "utf8",
        ),
      )
      await cleanup.query(
        `DELETE FROM public.vektorprogrammet_schema_migrations WHERE migration_id = 15`,
      )
      await cleanup.end()
      await seedCredentialIdentity()
      await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* AuthEngine
          const auth = yield* Auth

          const signedIn = yield* Effect.tryPromise(() =>
            auth.signIn({ email: cohort.email, password: cohort.password }),
          )
          const cookie = signedIn.setCookie.split(";")[0] ?? signedIn.setCookie
          expect(signedIn.actor.personId).toBe(cohort.personId)
          expect(signedIn.setCookie).toMatch(/HttpOnly/i)
          const handlerResponse = yield* Effect.promise(() =>
            engine.handler(
              new Request("http://127.0.0.1:8790/api/auth/get-session", {
                headers: new Headers({ cookie }),
              }),
            ),
          )
          const handlerBody = (yield* Effect.promise(() => handlerResponse.json())) as {
            user?: { id?: string }
          }
          expect(handlerBody.user?.id).toBe(cohort.personId)

          yield* Effect.tryPromise(() => auth.signOut(cookie))
          const revoked = yield* Effect.exit(Effect.tryPromise(() => auth.resolveSession(cookie)))
          expect(revoked._tag).toBe("Failure")
        }),
      )
    },
    120_000,
  )

  it("fails closed for unknown session cookies", async () => {
    assertDisposable(config.postgresUrl)
    await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth
        const result = yield* Effect.exit(Effect.tryPromise(() => auth.resolveSession("vp.session_token=unknown")))
        expect(result._tag).toBe("Failure")
      }),
    )
  })
})
