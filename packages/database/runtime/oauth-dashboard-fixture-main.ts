import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLocalAccountIssuer } from "better-auth";
import { Pool } from "pg";
import { makeAuthEngine, makeAuthPool, type AuthEngineConfig } from "../src/auth-engine.js";
import { makeOAuthClientOperatorService } from "../src/oauth-live.js";
import { databaseMigrationDefinitions } from "../src/migrations.js";

const databaseUrl = process.env.OAUTH_DASHBOARD_PG_URL ?? "";
const dashboardOrigin = process.env.OAUTH_DASHBOARD_ORIGIN ?? "";
const backendOrigin = process.env.OAUTH_CANONICAL_ORIGIN ?? "";
const password = process.env.OAUTH_E2E_PASSWORD ?? "";
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname));
assert.match(parsedDatabaseUrl.pathname, /proof|test/u);
assert.equal(new URL(dashboardOrigin).hostname, "127.0.0.1");
assert.equal(new URL(backendOrigin).hostname, "127.0.0.1");
assert.ok(password.length >= 12);

const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
for (const migration of databaseMigrationDefinitions) {
  await migrationPool.query(await readFile(migration.url, "utf8"));
}
await migrationPool.query(
  `CREATE TABLE IF NOT EXISTS auth.vektorprogrammet_schema_migrations (
     migration_id integer PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT now(),
     name text NOT NULL
   )`,
);
for (const migration of databaseMigrationDefinitions) {
  await migrationPool.query(
    `INSERT INTO auth.vektorprogrammet_schema_migrations (migration_id, name)
     VALUES ($1, $2) ON CONFLICT (migration_id) DO NOTHING`,
    [Number.parseInt(migration.id, 10), migration.name],
  );
}
await migrationPool.end();

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
const pool = makeAuthPool(config);
const engine = makeAuthEngine(config, pool);
const context = await engine.$context;
await pool.query(
  `INSERT INTO public.person_profiles (person_id, first_name, last_name)
   VALUES ('oauth-dashboard-person', 'OAuth', 'Dashboard')`,
);
const passwordHash = await context.password.hash(password);
await context.internalAdapter.createUser(
  {
    id: "oauth-dashboard-person",
    name: "OAuth Dashboard Person",
    email: "oauth.dashboard@example.invalid",
    emailVerified: true,
  },
  { method: "email-password" },
);
await context.internalAdapter.linkAccount({
  accountId: "oauth-dashboard-person",
  providerId: "credential",
  issuer: createLocalAccountIssuer("credential"),
  userId: "oauth-dashboard-person",
  password: passwordHash,
});
const operator = makeOAuthClientOperatorService(pool, engine);
const execution = {
  dryRun: false,
  target: parsedDatabaseUrl.pathname.slice(1),
  authority: "operator",
  requestCorrelation: "oauth-dashboard-browser-fixture",
} as const;
await operator.bootstrapSigningKey(execution);
await operator.provision(
  {
    clientId: "oauth-dashboard-public",
    name: "Dashboard OAuth proof",
    clientKind: "DelegatedPublic",
    redirectUris: [`${dashboardOrigin}/dashboard/oauth/callback`],
    scopes: ["native-api", "offline_access"],
  },
  execution,
);
process.stdout.write(
  JSON.stringify({
    database: "disposable",
    person: "oauth-dashboard-person",
    client: "oauth-dashboard-public",
    signingKey: "active",
  }) + "\n",
);
await pool.end();
