/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as SqlClient from "effect/sql/SqlClient";
import { AuthPoolLive, nativePgLayer } from "../src/pg-pool.js";
import { DatabaseRuntimeLive } from "../src/runtime-layer.js";
import assert from "node:assert/strict";
import { Database } from "../src/service.js";
import { withNativeAuthProvisioning } from "../src/auth-engine.js";
import { createLocalAccountIssuer } from "better-auth";
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import {
  NativeAuthEngine,
  NativeAuthEngineLive,
  type AuthEngine,
  type AuthEngineConfig,
} from "../src/auth-engine.js";
import { Context, Layer } from "effect";
import { DatabaseLive } from "../src/layers.js";
import { BetterAuthStartupOptions, NativeDatabaseStartupOptions } from "../src/search-path.js";
import { TestPlatform } from "../src/test-support/platform.js";
import { SecretEqualityLive } from "../src/web-crypto.js";

/**
 * Native identity seed entrypoint (spec 0054).
 *
 * Provisions login-capable persons against a DISPOSABLE PostgreSQL cluster:
 * inserts public.person_profiles rows, then creates better-auth users with
 * CALLER-SUPPLIED ids (auth.user.id IS PersonId - the FK requires the
 * person_profiles row to exist first). Idempotent: person inserts use
 * ON CONFLICT DO NOTHING; an auth.user row matching id or email skips the
 * person entirely. Schema migrations run first through the same DatabaseLive
 * layer every capability uses.
 *
 * Usage:
 *   IDENTITY_SEED_PG_URL=postgres://postgres@127.0.0.1:45121/postgres \
 *   IDENTITY_SEED_PERSONS='[{"personId":"...","firstName":"...","lastName":"...","email":"...","password":"..."}]' \
 *   bun run identity:seed
 */

const SeedPerson = Schema.Struct({
  personId: Schema.NonEmptyString,
  firstName: Schema.NonEmptyString,
  lastName: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
  password: Schema.String.pipe(Schema.check(Schema.isMinLength(12))),
});

type SeedPerson = typeof SeedPerson.Type;

const defaultSeedUrl = "postgres://postgres@127.0.0.1:45121/postgres";

const assertLoopbackDatabaseUrl = (postgresUrl: string): void => {
  const parsed = new URL(postgresUrl);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "IDENTITY_SEED_PG_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    "identity seed is restricted to loopback PostgreSQL",
  );
};

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const applyMigrations = (postgresUrl: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.health;

      return database.schemaRevision;
    }).pipe(
      Effect.provide(
        DatabaseLive({
          url: Redacted.make(postgresUrl),
          applicationName: "identity-seed-migration",
          maxConnections: 1,
          startupOptions: NativeDatabaseStartupOptions,
        }),
      ),
    ),
  );

const seedPerson = (engine: AuthEngine, observer: SqlClient.SqlClient, person: SeedPerson) =>
  Effect.gen(function* () {
    yield* observer.unsafe(
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id) DO NOTHING`,
      [person.personId, person.firstName, person.lastName],
    );

    const existing = yield* observer.unsafe<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM auth."user" WHERE id = $1 OR email = $2`,
      [person.personId, person.email],
    );

    if (existing[0]?.count !== "0") {
      return { personId: person.personId, action: "skipped" as const };
    }

    const context = yield* Effect.promise(() => engine.$context);

    yield* withNativeAuthProvisioning(context, () =>
      context.internalAdapter.createUser(
        {
          id: person.personId,
          name: `${person.firstName} ${person.lastName}`,
          email: person.email,
          emailVerified: true,
        },
        { method: "email-password" },
      ),
    );

    const password = yield* Effect.tryPromise(() => context.password.hash(person.password));

    yield* withNativeAuthProvisioning(context, () =>
      context.internalAdapter.linkAccount({
        accountId: person.personId,
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        userId: person.personId,
        password,
      }),
    );

    const details = yield* jsonText({
      outcomeCode: "account-provisioned",
      affectedSessionCount: 0,
    });

    yield* observer.unsafe(
      `INSERT INTO auth.identity_security_audit (
       event_id, event_kind, subject_person_id, session_id, actor_principal,
       request_correlation, source_ip, user_agent, details
     ) VALUES (gen_random_uuid()::text, 'account-provisioned-administratively', $1, NULL,
       'administrative:identity-seed', NULL, NULL, NULL, $2::jsonb)`,
      [person.personId, details],
    );

    return { personId: person.personId, action: "created" as const };
  });

const program = Effect.gen(function* () {
  const postgresUrl = yield* Config.String("IDENTITY_SEED_PG_URL").pipe(
    Config.withDefault(defaultSeedUrl),
  );

  const persons = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(SeedPerson)),
    "IDENTITY_SEED_PERSONS",
  );

  assertLoopbackDatabaseUrl(postgresUrl);
  const schemaRevision = yield* applyMigrations(postgresUrl);

  const trustedOrigins = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(Schema.String)),
    "NATIVE_IDENTITY_TRUSTED_ORIGINS",
  );

  assert.ok(trustedOrigins.length > 0, "NATIVE_IDENTITY_TRUSTED_ORIGINS is required");

  const deployment = yield* Config.Literals(["local", "production"], "NATIVE_IDENTITY_DEPLOYMENT");

  const secret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(
    Config.withDefault(Redacted.make("identity-seed-disposable-secret-0123456789abcdef")),
  );

  const config: AuthEngineConfig = {
    postgresUrl,
    secret: Redacted.value(secret),
    oauth: {
      canonicalOrigin: trustedOrigins[0]!,
      dashboardOrigin: trustedOrigins[0]!,
      nativeApiResource: "urn:vektorprogrammet:native-api",
    },
    trustedOrigins,
    secureCookies: deployment !== "local",
  };

  const outcomes = yield* Effect.scoped(
    Effect.flatMap(
      Effect.map(
        Layer.build(
          nativePgLayer({
            url: Redacted.make(postgresUrl),
            startupOptions: NativeDatabaseStartupOptions,
            maxConnections: 1,
            applicationName: "identity-seed-observer",
          }),
        ),
        Context.get(SqlClient.SqlClient),
      ),
      (observer) =>
        NativeAuthEngine.pipe(
          Effect.flatMap((engine) =>
            Effect.forEach(persons, (person) => seedPerson(engine, observer, person)),
          ),
          Effect.provide(
            NativeAuthEngineLive(config).pipe(
              Layer.provide(SecretEqualityLive(globalThis.crypto.subtle)),
              Layer.provide(
                Layer.mergeAll(
                  AuthPoolLive(config, {
                    maxConnections: 4,
                    applicationName: "stable-auth-proof",
                    pipeline: true,
                    startupOptions: BetterAuthStartupOptions,
                  }),
                  DatabaseRuntimeLive({
                    url: Redacted.make(postgresUrl),
                    maxConnections: 1,
                    startupOptions: NativeDatabaseStartupOptions,
                    applicationName: "identity-seed-sql",
                  }),
                ),
              ),
            ),
          ),
        ),
    ),
  );

  const summary = yield* jsonText({ schemaRevision, seeded: persons.length, outcomes });

  yield* Effect.sync(() => process.stdout.write(`${summary}\n`));
});

// A set but empty variable is present, not absent: it never selects the default database.
void Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.merge(
        TestPlatform,
        ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      ),
    ),
  ),
).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
