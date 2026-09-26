import { NativeAuthEngineLive, NativeAuthEngine, AuthPoolLive } from "../src/auth-engine.js";
import { DatabasePgPool, pgQuery, pgTransaction } from "../src/pg-pool.js";
import assert from "node:assert/strict";
import { Database } from "../src/service.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { createLocalAccountIssuer } from "better-auth";
import { Cause, Config, Context, Effect, Exit, Layer, Predicate, Redacted } from "effect";
import { Pool } from "pg";
import { type AuthEngine, type AuthEngineConfig } from "../src/auth-engine.js";
import { DatabaseLive } from "../src/layers.js";
import { TestPlatform } from "../src/test-support/platform.js";
import { databaseSchemaRevision } from "../src/migrations.js";

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

const authTables = [
  "account",
  "identity_security_audit",
  "session",
  "user",
  "verification",
] as const;

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

const resetIdentityCohort = (pool: Pool, migrationId: number) =>
  pgTransaction(pool, (client) =>
    Effect.gen(function* () {
      yield* pgQuery(client, "DROP SCHEMA IF EXISTS auth CASCADE");

      const profileTable = yield* pgQuery<{ readonly tableName: string | null }>(
        client,
        `SELECT to_regclass('public.person_profiles')::text AS "tableName"`,
      );

      if (profileTable.rows[0]?.tableName !== null) {
        yield* pgQuery(client, `DELETE FROM public.person_profiles WHERE person_id IN ($1, $2)`, [
          proofCohort.personId,
          proofCohort.orphanPersonId,
        ]);
      }

      const migrationTable = yield* pgQuery<{ readonly tableName: string | null }>(
        client,
        `SELECT to_regclass('public.vektorprogrammet_schema_migrations')::text AS "tableName"`,
      );

      if (migrationTable.rows[0]?.tableName !== null) {
        yield* pgQuery(
          client,
          `DELETE FROM public.vektorprogrammet_schema_migrations WHERE migration_id >= ${migrationId}`,
        );
      }
    }),
  );

const identityMigrationId = 15;

const applyIdentityMigration = (postgresUrl: string) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(postgresUrl),
    applicationName: "identity-postgres-proof-migration",
    maxConnections: 1,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.health;

      return database.schemaRevision;
    }).pipe(Effect.provide(databaseLayer)),
  );
};

const inspectIdentitySchema = (pool: Pool) =>
  Effect.gen(function* () {
    const migration = yield* pgQuery<{
      readonly migrationId: number;
      readonly name: string;
    }>(
      pool,
      `SELECT migration_id AS "migrationId", name
       FROM public.vektorprogrammet_schema_migrations
       WHERE migration_id = 15`,
    );

    assert.deepEqual(migration.rows, [{ migrationId: 15, name: "native-identity-better-auth" }]);

    const authSchemaTables = yield* pgQuery<{ readonly tableName: string }>(
      pool,
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

    const publicSchemaTables = yield* pgQuery<{ readonly tableName: string }>(
      pool,
      `SELECT table_name AS "tableName"
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[...authTables]],
    );

    assert.deepEqual(publicSchemaTables.rows, []);

    const identityForeignKeys = yield* pgQuery<{
      readonly sourceColumn: string;
      readonly targetSchema: string;
      readonly targetTable: string;
      readonly targetColumn: string;
    }>(
      pool,
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
  });

const postgresErrorCode = (cause: unknown): string | undefined => {
  const pending: Array<unknown> = [cause];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.shift();

    if (!Predicate.isObjectOrArray(current) || seen.has(current)) continue;

    seen.add(current);

    if (Predicate.hasProperty(current, "code") && Predicate.isString(current.code))
      return current.code;

    for (const key of ["cause", "error", "originalError"] as const) {
      if (Predicate.hasProperty(current, key)) pending.push(current[key]);
    }
  }

  return undefined;
};

const seedCallerSuppliedIdentity = (engine: AuthEngine, observer: Pool) =>
  Effect.gen(function* () {
    yield* pgQuery(
      observer,
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
       VALUES ($1, 'Ida', 'Identity Proof')`,
      [proofCohort.personId],
    );

    const context = yield* Effect.promise(() => engine.$context);

    const orphan = yield* Effect.exit(
      Effect.tryPromise(() =>
        context.internalAdapter.createUser(
          {
            id: proofCohort.orphanPersonId,
            name: "Orphan Identity",
            email: "identity-postgres-proof-orphan-0054@example.invalid",
            emailVerified: true,
          },
          { method: "email-password" },
        ),
      ),
    );

    assert.ok(Exit.isFailure(orphan), "an auth user without a PersonId must be rejected");
    assert.equal(
      postgresErrorCode(Cause.squash(orphan.cause)),
      "23503",
      "the orphan rejection must be PostgreSQL foreign-key enforcement",
    );

    const orphanRows = yield* pgQuery<{ readonly count: string }>(
      observer,
      `SELECT count(*)::text AS count FROM auth."user" WHERE id = $1`,
      [proofCohort.orphanPersonId],
    );

    assert.equal(orphanRows.rows[0]?.count, "0");

    const passwordHash = yield* Effect.tryPromise(() =>
      context.password.hash(proofCohort.password),
    );

    const user = yield* Effect.tryPromise(() =>
      context.internalAdapter.createUser(
        {
          id: proofCohort.personId,
          name: "Ida Identity Proof",
          email: proofCohort.email,
          emailVerified: true,
        },
        { method: "email-password" },
      ),
    );

    assert.equal(user.id, proofCohort.personId);

    const account = yield* Effect.tryPromise(() =>
      context.internalAdapter.linkAccount({
        accountId: proofCohort.personId,
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        userId: proofCohort.personId,
        password: passwordHash,
      }),
    );

    assert.equal(account.userId, proofCohort.personId);

    const persisted = yield* pgQuery<{
      readonly userId: string;
      readonly accountUserId: string;
      readonly accountId: string;
      readonly providerId: string;
      readonly issuer: string;
      readonly password: string;
    }>(
      observer,
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
  });

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

const persistedSessions = (pool: Pool) =>
  pgQuery<{
    readonly total: string;
    readonly live: string;
  }>(
    pool,
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE "expiresAt" > now())::text AS live
     FROM auth.session
     WHERE "userId" = $1`,
    [proofCohort.personId],
  ).pipe(
    Effect.map((sessions) => ({
      total: Number(sessions.rows[0]?.total ?? "-1"),
      live: Number(sessions.rows[0]?.live ?? "-1"),
    })),
  );

const assertAuthSearchPath = (pool: Pool) =>
  pgQuery<{
    readonly currentSchema: string;
    readonly searchPath: string;
  }>(
    pool,
    `SELECT
       current_schema() AS "currentSchema",
       current_setting('search_path') AS "searchPath"`,
  ).pipe(
    Effect.map((searchPath) => {
      assert.deepEqual(searchPath.rows, [{ currentSchema: "auth", searchPath: "auth" }]);

      return searchPath.rows[0]?.searchPath;
    }),
  );

const exerciseCredentialsAndSessions = (
  engine: AuthEngine,
  independentlyConstructedEngine: AuthEngine,
  observer: Pool,
) =>
  Effect.gen(function* () {
    const invalidPasswordResponse = yield* Effect.tryPromise(() =>
      engine.api.signInEmail({
        body: {
          email: proofCohort.email,
          password: proofCohort.wrongPassword,
        },
        asResponse: true,
      }),
    );

    assert.equal(invalidPasswordResponse.status, 401);
    assert.equal(sessionCookieFrom(invalidPasswordResponse), undefined);
    assert.deepEqual(yield* persistedSessions(observer), { total: 0, live: 0 });

    const validPasswordResponse = yield* Effect.tryPromise(() =>
      engine.api.signInEmail({
        body: {
          email: proofCohort.email,
          password: proofCohort.password,
        },
        asResponse: true,
      }),
    );

    assert.equal(validPasswordResponse.status, 200);
    const sessionCookie = sessionCookieFrom(validPasswordResponse);
    assert.ok(sessionCookie !== undefined, `${sessionCookieName} must be issued`);
    assert.ok(sessionCookie.value.length > 0, "session cookie value must be non-empty");
    assert.match(sessionCookie.setCookie, /;\s*HttpOnly/i);
    assert.match(sessionCookie.setCookie, /;\s*SameSite=Lax/i);
    assert.deepEqual(yield* persistedSessions(observer), { total: 1, live: 1 });

    const restoredSession = yield* Effect.tryPromise(() =>
      independentlyConstructedEngine.api.getSession({
        headers: cookieHeaders(sessionCookie.pair),
      }),
    );

    assert.equal(restoredSession?.user.id, proofCohort.personId);
    assert.equal(restoredSession?.session.userId, proofCohort.personId);

    const signOutResponse = yield* Effect.tryPromise(() =>
      engine.api.signOut({
        headers: cookieHeaders(sessionCookie.pair),
        asResponse: true,
      }),
    );

    assert.equal(signOutResponse.status, 200);
    assert.deepEqual(yield* persistedSessions(observer), { total: 0, live: 0 });

    const replayedSessions = yield* Effect.all(
      [
        Effect.tryPromise(() =>
          engine.api.getSession({ headers: cookieHeaders(sessionCookie.pair) }),
        ),
        Effect.tryPromise(() =>
          independentlyConstructedEngine.api.getSession({
            headers: cookieHeaders(sessionCookie.pair),
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );

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
  });

const runIdentityPostgresProof = (postgresUrl: string) =>
  Effect.gen(function* () {
    assertDisposableDatabaseUrl(postgresUrl);

    const observer = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: postgresUrl,
            options: "-c search_path=public",
            max: 1,
            application_name: "identity-postgres-proof-observer",
          }),
      ),
      (pool) => Effect.promise(() => pool.end()),
    );

    yield* resetIdentityCohort(observer, identityMigrationId);
    const schemaRevision = yield* applyIdentityMigration(postgresUrl);
    assert.equal(schemaRevision, databaseSchemaRevision);
    const migration = yield* inspectIdentitySchema(observer);

    const authConfig: AuthEngineConfig = {
      postgresUrl,
      secret: "identity-postgres-proof-0054-secret-at-least-thirty-two-characters",
      oauth: {
        canonicalOrigin: proofBaseUrl,
        dashboardOrigin: proofBaseUrl,
        nativeApiResource: "urn:vektorprogrammet:native-api",
      },
      trustedOrigins: [proofBaseUrl],
      secureCookies: false,
    };

    const nativeAuthLayer = NativeAuthEngineLive(authConfig).pipe(
      Layer.provideMerge(AuthPoolLive(authConfig)),
    );

    // Two constructions of one layer: each has its own engine and pool.
    const auth = yield* Layer.build(Layer.fresh(nativeAuthLayer));
    const independent = yield* Layer.build(Layer.fresh(nativeAuthLayer));
    const engine = Context.get(auth, NativeAuthEngine);
    const independentlyConstructedEngine = Context.get(independent, NativeAuthEngine);
    const searchPath = yield* assertAuthSearchPath(Context.get(auth, DatabasePgPool));
    yield* assertAuthSearchPath(Context.get(independent, DatabasePgPool));
    const identity = yield* seedCallerSuppliedIdentity(engine, observer);

    const authentication = yield* exerciseCredentialsAndSessions(
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
  });

const program = Effect.scoped(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.Redacted("DATABASE_URL");
    const evidence = yield* runIdentityPostgresProof(Redacted.value(databaseUrl));
    const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
    yield* Effect.sync(() =>
      process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
    );
  }),
);

void Effect.runPromise(program.pipe(Effect.provide(TestPlatform))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
