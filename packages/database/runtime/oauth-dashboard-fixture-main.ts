import { Config, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { AuthLive, AuthEngine } from "../src/auth-live.js";
import { AuthPoolLive } from "../src/auth-engine.js";
import { DatabasePgPool, pgQuery } from "../src/pg-pool.js";
import { OAuthClientOperator } from "../src/oauth-live.js";
import assert from "node:assert/strict";
import { createLocalAccountIssuer } from "better-auth";
import { Pool } from "pg";
import { type AuthEngineConfig } from "../src/auth-engine.js";
import { TestPlatform } from "../src/test-support/platform.js";

import { databaseMigrationDefinitions } from "../src/migrations.js";

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  const { databaseUrl, dashboardOrigin, backendOrigin, password } = yield* Config.all({
    databaseUrl: Config.String("OAUTH_DASHBOARD_PG_URL"),
    dashboardOrigin: Config.String("OAUTH_DASHBOARD_ORIGIN"),
    backendOrigin: Config.String("OAUTH_CANONICAL_ORIGIN"),
    password: Config.Redacted("OAUTH_E2E_PASSWORD"),
  });

  const parsedDatabaseUrl = new URL(databaseUrl);

  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname));

  assert.match(parsedDatabaseUrl.pathname, /proof|test/u);

  assert.equal(new URL(dashboardOrigin).hostname, "127.0.0.1");

  assert.equal(new URL(backendOrigin).hostname, "127.0.0.1");

  assert.ok(Redacted.value(password).length >= 12);

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: databaseUrl, max: 1 })),
    (migrationPool) =>
      Effect.gen(function* () {
        for (const migration of databaseMigrationDefinitions) {
          const source = yield* path
            .fromFileUrl(migration.url)
            .pipe(Effect.flatMap((file) => fs.readFileString(file)));

          yield* pgQuery(migrationPool, source);
        }

        yield* pgQuery(
          migrationPool,
          `CREATE TABLE IF NOT EXISTS auth.vektorprogrammet_schema_migrations (
             migration_id integer PRIMARY KEY,
             created_at timestamptz NOT NULL DEFAULT now(),
             name text NOT NULL
           )`,
        );

        for (const migration of databaseMigrationDefinitions) {
          yield* pgQuery(
            migrationPool,
            `INSERT INTO auth.vektorprogrammet_schema_migrations (migration_id, name)
             VALUES ($1, $2) ON CONFLICT (migration_id) DO NOTHING`,
            [Number.parseInt(migration.id, 10), migration.name],
          );
        }
      }),
    (migrationPool) => Effect.promise(() => migrationPool.end()),
  );

  const config: AuthEngineConfig = {
    postgresUrl: databaseUrl,
    secret: "oauth-dashboard-disposable-secret-at-least-32-characters",
    oauth: {
      canonicalOrigin: backendOrigin,
      dashboardOrigin,
      nativeApiResource: "urn:vektorprogrammet:native-api",
    },
    trustedOrigins: [dashboardOrigin],
    secureCookies: false,
  };

  yield* Effect.gen(function* () {
    const pool = yield* DatabasePgPool;
    const { engine } = yield* AuthEngine;
    const context = yield* Effect.promise(() => engine.$context);

    yield* pgQuery(
      pool,
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
       VALUES ('oauth-dashboard-person', 'OAuth', 'Dashboard')`,
    );

    const passwordHash = yield* Effect.tryPromise(() =>
      context.password.hash(Redacted.value(password)),
    );

    yield* Effect.tryPromise(() =>
      context.internalAdapter.createUser(
        {
          id: "oauth-dashboard-person",
          name: "OAuth Dashboard Person",
          email: "oauth.dashboard@example.invalid",
          emailVerified: true,
        },
        { method: "email-password" },
      ),
    );

    yield* Effect.tryPromise(() =>
      context.internalAdapter.linkAccount({
        accountId: "oauth-dashboard-person",
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        userId: "oauth-dashboard-person",
        password: passwordHash,
      }),
    );

    const operator = yield* OAuthClientOperator;

    const execution = {
      dryRun: false,
      target: parsedDatabaseUrl.pathname.slice(1),
      authority: "operator",
      requestCorrelation: "oauth-dashboard-browser-fixture",
    } as const;

    yield* operator.bootstrapSigningKey(execution);

    yield* operator.provision(
      {
        clientId: "oauth-dashboard-public",
        name: "Dashboard OAuth proof",
        clientKind: "DelegatedPublic",
        redirectUris: [`${dashboardOrigin}/dashboard/oauth/callback`],
        scopes: ["native-api", "offline_access"],
      },
      execution,
    );

    const fixture = yield* jsonText({
      database: "disposable",
      person: "oauth-dashboard-person",
      client: "oauth-dashboard-public",
      signingKey: "active",
    });

    yield* Effect.sync(() => process.stdout.write(`${fixture}\n`));
  }).pipe(Effect.provide(AuthLive(config).pipe(Layer.provideMerge(AuthPoolLive(config)))));
});

void Effect.runPromise(program.pipe(Effect.provide(TestPlatform))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
