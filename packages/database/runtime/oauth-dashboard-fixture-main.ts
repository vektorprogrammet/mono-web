/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { AuthPoolLive } from "../src/pg-pool.js";
import { DatabaseLive } from "../src/layers.js";
import { Database } from "../src/service.js";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { AuthLive, AuthEngine } from "../src/auth-live.js";
import { OAuthClientOperator } from "../src/oauth-live.js";
import assert from "node:assert/strict";
import { createLocalAccountIssuer } from "better-auth";
import { type AuthEngineConfig } from "../src/auth-engine.js";
import { TestPlatform } from "../src/test-support/platform.js";

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
    const pool = yield* Database;
    const { engine } = yield* AuthEngine;
    const context = yield* Effect.promise(() => engine.$context);

    yield* pool.unsafe(`INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ('oauth-dashboard-person', 'OAuth', 'Dashboard')`);

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
  }).pipe(
    Effect.provide(
      AuthLive(config).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            AuthPoolLive(config, {
              maxConnections: 4,
              applicationName: "stable-auth-proof",
              pipeline: true,
              startupOptions: "-c search_path=auth",
            }),
            DatabaseLive({
              url: Redacted.make(config.postgresUrl),
              maxConnections: 4,
              applicationName: "stable-auth-proof-sql",
            }),
          ),
        ),
      ),
    ),
  );
});

void Effect.runPromise(program.pipe(Effect.provide(TestPlatform))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
