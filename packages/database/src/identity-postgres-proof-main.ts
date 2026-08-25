import assert from "node:assert/strict";
import { Database } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { createLocalAccountIssuer } from "better-auth";
import { Config, Effect, Redacted } from "effect";
import { Pool } from "pg";
import {
  makeAuthEngine,
  makeAuthPool,
  type AuthEngine,
  type AuthEngineConfig,
} from "./auth-engine.js";
import { DatabaseLive } from "./layers.js";
import { databaseSchemaRevision } from "./migrations.js";
import { runDatabaseEffect, runDatabaseMain } from "../runtime/node.js";

const proofCohort = {
  id: "identity-postgres-proof-0054-v1",
  personId: "identity-postgres-proof-person-0054",
  orphanPersonId: "identity-postgres-proof-orphan-0054",
  email: "identity-postgres-proof-0054@example.invalid",
  password: "IdentityProof!0054-valid-password",
  wrongPassword: "IdentityProof!0054-wrong-password",
} as const;

const proofBaseUrl = "http://127.0.0.1:8788";
const sessionCookieName = "better-auth.session_token";
const authTables = ["account", "session", "user", "verification"] as const;

const assertDisposableDatabaseUrl = (postgresUrl: string) => {
  const parsed = new URL(postgresUrl);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "DATABASE_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    "identity proof is restricted to loopback PostgreSQL",
  );
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(
    databaseName,
    /proof/i,
    "identity proof requires a database whose name contains 'proof'",
  );
};

const resetIdentityCohort = async (pool: Pool, migrationId: number) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP SCHEMA IF EXISTS auth CASCADE");

    const profileTable = await client.query<{ readonly tableName: string | null }>(
      `SELECT to_regclass('public.person_profiles')::text AS "tableName"`,
    );
    if (profileTable.rows[0]?.tableName !== null) {
      await client.query(`DELETE FROM public.person_profiles WHERE person_id IN ($1, $2)`, [
        proofCohort.personId,
        proofCohort.orphanPersonId,
      ]);
    }

    const migrationTable = await client.query<{ readonly tableName: string | null }>(
      `SELECT to_regclass('public.vektorprogrammet_schema_migrations')::text AS "tableName"`,
    );
    if (migrationTable.rows[0]?.tableName !== null) {
      await client.query(
        `DELETE FROM public.vektorprogrammet_schema_migrations WHERE migration_id >= ${migrationId}`,
      );
    }

    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
};

const identityMigrationId = 15;

const applyIdentityMigration = (postgresUrl: string) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(postgresUrl),
    applicationName: "identity-postgres-proof-migration",
    maxConnections: 1,
  });

  return runDatabaseEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.health;
        return database.schemaRevision;
      }).pipe(Effect.provide(databaseLayer)),
    ),
  );
};

const inspectIdentitySchema = async (pool: Pool) => {
  const migration = await pool.query<{
    readonly migrationId: number;
    readonly name: string;
  }>(
    `SELECT migration_id AS "migrationId", name
     FROM public.vektorprogrammet_schema_migrations
     WHERE migration_id = 15`,
  );
  assert.deepEqual(migration.rows, [{ migrationId: 15, name: "native-identity-better-auth" }]);

  const authSchemaTables = await pool.query<{ readonly tableName: string }>(
    `SELECT table_name AS "tableName"
     FROM information_schema.tables
     WHERE table_schema = 'auth'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [[...authTables]],
  );
  assert.deepEqual(
    authSchemaTables.rows.map(({ tableName }) => tableName),
    [...authTables],
  );

  const publicSchemaTables = await pool.query<{ readonly tableName: string }>(
    `SELECT table_name AS "tableName"
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [[...authTables]],
  );
  assert.deepEqual(publicSchemaTables.rows, []);

  const identityForeignKeys = await pool.query<{
    readonly sourceColumn: string;
    readonly targetSchema: string;
    readonly targetTable: string;
    readonly targetColumn: string;
  }>(
    `SELECT DISTINCT
       source_attribute.attname AS "sourceColumn",
       target_namespace.nspname AS "targetSchema",
       target_table.relname AS "targetTable",
       target_attribute.attname AS "targetColumn"
     FROM pg_constraint AS constraint_row
     INNER JOIN pg_class AS source_table
       ON source_table.oid = constraint_row.conrelid
     INNER JOIN pg_namespace AS source_namespace
       ON source_namespace.oid = source_table.relnamespace
     INNER JOIN pg_class AS target_table
       ON target_table.oid = constraint_row.confrelid
     INNER JOIN pg_namespace AS target_namespace
       ON target_namespace.oid = target_table.relnamespace
     INNER JOIN pg_attribute AS source_attribute
       ON source_attribute.attrelid = constraint_row.conrelid
       AND source_attribute.attnum = ANY(constraint_row.conkey)
     INNER JOIN pg_attribute AS target_attribute
       ON target_attribute.attrelid = constraint_row.confrelid
       AND target_attribute.attnum = ANY(constraint_row.confkey)
     WHERE constraint_row.contype = 'f'
       AND source_namespace.nspname = 'auth'
       AND source_table.relname = 'user'`,
  );
  assert.ok(
    identityForeignKeys.rows.some(
      (row) =>
        row.sourceColumn === "id" &&
        row.targetSchema === "public" &&
        row.targetTable === "person_profiles" &&
        row.targetColumn === "person_id",
    ),
    "auth.user.id must reference public.person_profiles.person_id",
  );

  return {
    recorded: true as const,
    coreTablesInAuth: authSchemaTables.rowCount,
    coreTablesInPublic: publicSchemaTables.rowCount,
    personIdForeignKey: true as const,
  };
};

const postgresErrorCode = (cause: unknown): string | undefined => {
  const pending: Array<unknown> = [cause];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    pending.push(record.cause, record.error, record.originalError);
  }

  return undefined;
};

const seedCallerSuppliedIdentity = async (engine: AuthEngine, observer: Pool) => {
  await observer.query(
    `INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ($1, 'Ida', 'Identity Proof')`,
    [proofCohort.personId],
  );

  const context = await engine.$context;
  let orphanFailure: unknown;
  try {
    await context.internalAdapter.createUser(
      {
        id: proofCohort.orphanPersonId,
        name: "Orphan Identity",
        email: "identity-postgres-proof-orphan-0054@example.invalid",
        emailVerified: true,
      },
      { method: "email-password" },
    );
  } catch (cause) {
    orphanFailure = cause;
  }
  assert.ok(orphanFailure !== undefined, "an auth user without a PersonId must be rejected");
  assert.equal(
    postgresErrorCode(orphanFailure),
    "23503",
    "the orphan rejection must be PostgreSQL foreign-key enforcement",
  );

  const orphanRows = await observer.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM auth."user" WHERE id = $1`,
    [proofCohort.orphanPersonId],
  );
  assert.equal(orphanRows.rows[0]?.count, "0");

  const passwordHash = await context.password.hash(proofCohort.password);
  const user = await context.internalAdapter.createUser(
    {
      id: proofCohort.personId,
      name: "Ida Identity Proof",
      email: proofCohort.email,
      emailVerified: true,
    },
    { method: "email-password" },
  );
  assert.equal(user.id, proofCohort.personId);

  const account = await context.internalAdapter.linkAccount({
    accountId: proofCohort.personId,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    userId: proofCohort.personId,
    password: passwordHash,
  });
  assert.equal(account.userId, proofCohort.personId);

  const persisted = await observer.query<{
    readonly userId: string;
    readonly accountUserId: string;
    readonly accountId: string;
    readonly providerId: string;
    readonly issuer: string;
    readonly password: string;
  }>(
    `SELECT
       auth_user.id AS "userId",
       account."userId" AS "accountUserId",
       account."accountId" AS "accountId",
       account."providerId" AS "providerId",
       account.issuer,
       account.password
     FROM auth."user" AS auth_user
     INNER JOIN auth.account AS account ON account."userId" = auth_user.id
     WHERE auth_user.id = $1`,
    [proofCohort.personId],
  );
  assert.equal(persisted.rowCount, 1);
  assert.deepEqual(
    {
      userId: persisted.rows[0]?.userId,
      accountUserId: persisted.rows[0]?.accountUserId,
      accountId: persisted.rows[0]?.accountId,
      providerId: persisted.rows[0]?.providerId,
      issuer: persisted.rows[0]?.issuer,
    },
    {
      userId: proofCohort.personId,
      accountUserId: proofCohort.personId,
      accountId: proofCohort.personId,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
    },
  );
  assert.notEqual(persisted.rows[0]?.password, proofCohort.password);
  assert.ok((persisted.rows[0]?.password.length ?? 0) > 0);

  return {
    orphanRejectedByForeignKey: true as const,
    callerSuppliedPersonId: true as const,
    credentialPasswordHashed: true as const,
  };
};

const sessionCookieFrom = (response: Response) => {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${sessionCookieName}=`));
  if (setCookie === undefined) return undefined;

  const pair = setCookie.slice(
    0,
    setCookie.indexOf(";") === -1 ? undefined : setCookie.indexOf(";"),
  );
  const separator = pair.indexOf("=");
  assert.ok(separator > 0, "session Set-Cookie must contain a value");
  return {
    pair,
    value: pair.slice(separator + 1),
    setCookie,
  };
};

const cookieHeaders = (cookiePair: string) => new Headers({ cookie: cookiePair });

const persistedSessions = async (pool: Pool) => {
  const sessions = await pool.query<{
    readonly total: string;
    readonly live: string;
  }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE "expiresAt" > now())::text AS live
     FROM auth.session
     WHERE "userId" = $1`,
    [proofCohort.personId],
  );
  return {
    total: Number(sessions.rows[0]?.total ?? "-1"),
    live: Number(sessions.rows[0]?.live ?? "-1"),
  };
};

const assertAuthSearchPath = async (pool: Pool) => {
  const searchPath = await pool.query<{
    readonly currentSchema: string;
    readonly searchPath: string;
  }>(
    `SELECT
       current_schema() AS "currentSchema",
       current_setting('search_path') AS "searchPath"`,
  );
  assert.deepEqual(searchPath.rows, [{ currentSchema: "auth", searchPath: "auth" }]);
  return searchPath.rows[0]?.searchPath;
};

const exerciseCredentialsAndSessions = async (
  engine: AuthEngine,
  independentlyConstructedEngine: AuthEngine,
  observer: Pool,
) => {
  const invalidPasswordResponse = await engine.api.signInEmail({
    body: {
      email: proofCohort.email,
      password: proofCohort.wrongPassword,
    },
    asResponse: true,
  });
  assert.equal(invalidPasswordResponse.status, 401);
  assert.equal(sessionCookieFrom(invalidPasswordResponse), undefined);
  assert.deepEqual(await persistedSessions(observer), { total: 0, live: 0 });

  const validPasswordResponse = await engine.api.signInEmail({
    body: {
      email: proofCohort.email,
      password: proofCohort.password,
    },
    asResponse: true,
  });
  assert.equal(validPasswordResponse.status, 200);
  const sessionCookie = sessionCookieFrom(validPasswordResponse);
  assert.ok(sessionCookie !== undefined, `${sessionCookieName} must be issued`);
  assert.ok(sessionCookie.value.length > 0, "session cookie value must be non-empty");
  assert.match(sessionCookie.setCookie, /;\s*HttpOnly/i);
  assert.match(sessionCookie.setCookie, /;\s*SameSite=Lax/i);
  assert.deepEqual(await persistedSessions(observer), { total: 1, live: 1 });

  const restoredSession = await independentlyConstructedEngine.api.getSession({
    headers: cookieHeaders(sessionCookie.pair),
  });
  assert.equal(restoredSession?.user.id, proofCohort.personId);
  assert.equal(restoredSession?.session.userId, proofCohort.personId);

  const signOutResponse = await engine.api.signOut({
    headers: cookieHeaders(sessionCookie.pair),
    asResponse: true,
  });
  assert.equal(signOutResponse.status, 200);
  assert.deepEqual(await persistedSessions(observer), { total: 0, live: 0 });

  const replayedSessions = await Promise.all([
    engine.api.getSession({ headers: cookieHeaders(sessionCookie.pair) }),
    independentlyConstructedEngine.api.getSession({
      headers: cookieHeaders(sessionCookie.pair),
    }),
  ]);
  const replaySuccesses = replayedSessions.filter((session) => session !== null).length;
  assert.equal(replaySuccesses, 0);

  return {
    invalidPassword: {
      status: invalidPasswordResponse.status,
      sessionsPersisted: 0 as const,
    },
    validPassword: {
      status: validPasswordResponse.status,
      cookieName: sessionCookieName,
      sessionsPersisted: 1 as const,
      restoredByIndependentEngine: true as const,
    },
    signOut: {
      status: signOutResponse.status,
      sessionsPersisted: 0 as const,
      replayAttempts: replayedSessions.length,
      replaySuccesses,
    },
  };
};

const runIdentityPostgresProof = async (postgresUrl: string) => {
  assertDisposableDatabaseUrl(postgresUrl);
  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "identity-postgres-proof-observer",
  });
  let authPool: Pool | undefined;
  let independentAuthPool: Pool | undefined;

  try {
    await resetIdentityCohort(observer, identityMigrationId);
    const schemaRevision = await applyIdentityMigration(postgresUrl);
    assert.equal(schemaRevision, databaseSchemaRevision);
    const migration = await inspectIdentitySchema(observer);

    const authConfig: AuthEngineConfig = {
      postgresUrl,
      secret: "identity-postgres-proof-0054-secret-at-least-thirty-two-characters",
      baseURL: proofBaseUrl,
    };
    authPool = makeAuthPool(authConfig);
    independentAuthPool = makeAuthPool(authConfig);
    const engine = makeAuthEngine(authConfig, authPool);
    const independentlyConstructedEngine = makeAuthEngine(authConfig, independentAuthPool);

    const searchPath = await assertAuthSearchPath(authPool);
    await assertAuthSearchPath(independentAuthPool);
    const identity = await seedCallerSuppliedIdentity(engine, observer);
    const authentication = await exerciseCredentialsAndSessions(
      engine,
      independentlyConstructedEngine,
      observer,
    );

    return {
      specId: "0054" as const,
      database: "PostgreSQL" as const,
      cohort: proofCohort.id,
      schemaRevision: databaseSchemaRevision,
      passed: true as const,
      migration,
      authConnection: { searchPath },
      identity,
      ...authentication,
    };
  } finally {
    const releases: Array<Promise<void>> = [observer.end()];
    if (authPool !== undefined) releases.push(authPool.end());
    if (independentAuthPool !== undefined) releases.push(independentAuthPool.end());
    await Promise.all(releases);
  }
};

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const evidence = yield* Effect.tryPromise({
    try: () => runIdentityPostgresProof(Redacted.value(databaseUrl)),
    catch: (cause) => cause,
  });
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});

runDatabaseMain(program);
