import { expect, layer } from "@effect/vitest";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Context, DateTime, Effect, FileSystem, Layer, Path } from "effect";
import { Pool } from "pg";
import {
  type DatabaseMigrationDefinition,
  databaseMigrationDefinitions,
  selectDatabaseMigration,
} from "./migrations.js";
import { openRefreshFamily, recordRefreshFamilyUse } from "./oauth-live.js";
import { DatabasePgPool, pgQuery, pgTransaction } from "./pg-pool.js";
import { TestPlatform } from "./test-support/platform.js";
import { withPostgresTestDatabase } from "./test-support/postgres.js";

const hour = 60 * 60 * 1_000;

const windows = selectDatabaseMigration("77_oauth-refresh-elapsed-windows");

/** A disposable cluster. Its databases run their sessions in Europe/Oslo. */
class OsloCluster extends Context.Service<OsloCluster, DisposablePostgres>()(
  "oauth-refresh-window.test/OsloCluster",
) {}

const osloCluster = Layer.effect(
  OsloCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (cluster) => Effect.promise(() => cluster.stop()),
  ),
);

const readSql = (migration: DatabaseMigrationDefinition) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
  });

/**
 * A new database of the cluster, migrated through `migrations`, whose sessions run in
 * Europe/Oslo, a time zone with daylight saving time. Its clocks change on 2026-10-25 and
 * 2027-03-28.
 */
const osloDatabase = (name: string, migrations: ReadonlyArray<DatabaseMigrationDefinition>) =>
  Effect.gen(function* () {
    const cluster = yield* OsloCluster;

    const connect = (database: string) =>
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              host: cluster.socketDirectory,
              port: cluster.port,
              user: cluster.user,
              database,
              max: 1,
            }),
        ),
        (pool) => Effect.promise(() => pool.end()),
      );

    const admin = yield* connect(cluster.database);
    yield* pgQuery(admin, `CREATE DATABASE ${name}`);
    yield* pgQuery(admin, `ALTER DATABASE ${name} SET TimeZone = 'Europe/Oslo'`);

    const pool = yield* connect(name);

    for (const migration of migrations) yield* pgQuery(pool, yield* readSql(migration));

    return pool;
  });

const seed = (pool: Pool) =>
  pgQuery(
    pool,
    `INSERT INTO public.person_profiles (person_id, first_name, last_name)
       VALUES ('window-person', 'Window', 'Person');
     INSERT INTO auth."user" (id, name, email, "emailVerified")
       VALUES ('window-person', 'Window Person', 'window-person@example.invalid', true);
     INSERT INTO auth."session" (id, "expiresAt", token, "updatedAt", "userId")
       VALUES ('window-session', '2099-01-01T00:00:00Z', 'window-session-token',
         '2026-01-01T00:00:00Z', 'window-person');
     INSERT INTO auth."oauthClient" (id, "clientId", "redirectUris", scopes)
       VALUES ('window-client', 'window-client', '["http://127.0.0.1/callback"]', '["native-api"]');
     INSERT INTO auth.oauth_client_bindings (client_id, client_kind)
       VALUES ('window-client', 'DelegatedPublic');`,
  );

const osloApplicationDatabase = Layer.effect(
  DatabasePgPool,
  Effect.gen(function* () {
    const pool = yield* osloDatabase("refresh_window", databaseMigrationDefinitions);
    yield* seed(pool);

    return pool;
  }).pipe(Effect.orDie),
);

/** Opens a family at `issuedAt` through the application's statement. */
const openFamily = (familyId: string, issuedAt: string) =>
  Effect.gen(function* () {
    const pool = yield* DatabasePgPool;

    yield* pgTransaction(pool, (transaction) =>
      openRefreshFamily(transaction, {
        familyId,
        authorizationCodeId: `code-${familyId}`,
        clientId: "window-client",
        personId: "window-person",
        sessionId: "window-session",
        issuedAt: DateTime.makeUnsafe(issuedAt),
      }),
    );
  });

interface FamilyRow {
  readonly family_id: string;
  readonly created_at: Date;
  readonly last_used_at: Date;
  readonly inactivity_expires_at: Date;
  readonly absolute_expires_at: Date;
}

const readFamilies = (pool: Pool) =>
  pgQuery<FamilyRow>(
    pool,
    `SELECT family_id, created_at, last_used_at, inactivity_expires_at, absolute_expires_at
       FROM auth.oauth_refresh_families ORDER BY family_id`,
  ).pipe(
    Effect.map((result) =>
      result.rows.map((row) => ({
        familyId: row.family_id,
        created: row.created_at.toISOString(),
        lastUsed: row.last_used_at.toISOString(),
        inactivityExpires: row.inactivity_expires_at.toISOString(),
        absoluteExpires: row.absolute_expires_at.toISOString(),
      })),
    ),
  );

const readWindows = (familyId: string) =>
  Effect.gen(function* () {
    const families = yield* readFamilies(yield* DatabasePgPool);
    const family = families.find((row) => row.familyId === familyId)!;

    return {
      created: family.created,
      lastUsed: family.lastUsed,
      inactivityHours: (Date.parse(family.inactivityExpires) - Date.parse(family.lastUsed)) / hour,
      absoluteHours: (Date.parse(family.absoluteExpires) - Date.parse(family.created)) / hour,
    };
  });

/**
 * Seeds families through the statements of the application before migration 0077 in
 * Europe/Oslo sessions, and applies the migration. An earlier refresh rechecked the absolute
 * window of 30 calendar days in its session, so a family that it admitted had no clock change
 * in that window, and its refresh ran 168 hours of inactivity or ended at the absolute bound.
 * The 7 calendar days of the "capped" refresh cross the autumn change after that bound.
 */
const upgradeFromBefore0077 = (pool: Pool) =>
  Effect.gen(function* () {
    yield* seed(pool);

    const inOslo = (statement: string, values: ReadonlyArray<unknown>) =>
      pgTransaction(pool, (transaction) =>
        pgQuery(transaction, "SET LOCAL TimeZone = 'Europe/Oslo'").pipe(
          Effect.andThen(pgQuery(transaction, statement, values)),
        ),
      );

    const open = (familyId: string, created: string) =>
      inOslo(
        `INSERT INTO auth.oauth_refresh_families (
           family_id, authorization_code_id, client_id, person_id, session_id,
           created_at, last_used_at, inactivity_expires_at, absolute_expires_at
         ) VALUES ($1, $2, 'window-client', 'window-person', 'window-session', $3, $3, $4, $5)`,
        [
          familyId,
          `code-${familyId}`,
          created,
          DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(created), { hours: 168 })),
          DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(created), { hours: 720 })),
        ],
      );

    const refresh = (familyId: string, used: string) =>
      inOslo(
        `UPDATE auth.oauth_refresh_families
            SET last_used_at = to_timestamp($2),
                inactivity_expires_at = LEAST(to_timestamp($2) + interval '7 days', absolute_expires_at)
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId, Date.parse(used) / 1_000],
      );

    yield* open("capped", "2026-09-24T12:00:00.000Z");
    yield* refresh("capped", "2026-10-20T12:00:00.000Z");
    yield* open("steady", "2026-09-01T12:00:00.000Z");
    yield* refresh("steady", "2026-09-05T12:00:00.000Z");
    yield* open("unused", "2026-11-02T12:00:00.000Z");

    const before = yield* readFamilies(pool);
    yield* pgQuery(pool, yield* readSql(windows.migration));

    return { before, after: yield* readFamilies(pool) };
  });

const earlierFamilies = [
  {
    familyId: "capped",
    created: "2026-09-24T12:00:00.000Z",
    lastUsed: "2026-10-20T12:00:00.000Z",
    inactivityExpires: "2026-10-24T12:00:00.000Z",
    absoluteExpires: "2026-10-24T12:00:00.000Z",
  },
  {
    familyId: "steady",
    created: "2026-09-01T12:00:00.000Z",
    lastUsed: "2026-09-05T12:00:00.000Z",
    inactivityExpires: "2026-09-12T12:00:00.000Z",
    absoluteExpires: "2026-10-01T12:00:00.000Z",
  },
  {
    familyId: "unused",
    created: "2026-11-02T12:00:00.000Z",
    lastUsed: "2026-11-02T12:00:00.000Z",
    inactivityExpires: "2026-11-09T12:00:00.000Z",
    absoluteExpires: "2026-12-02T12:00:00.000Z",
  },
];

const upgradeEvidence = { before: earlierFamilies, after: earlierFamilies };

layer(Layer.merge(osloCluster, TestPlatform), { excludeTestServices: true, timeout: "60 seconds" })(
  "OAuth refresh windows in a PostgreSQL session with daylight saving time",
  (it) => {
    it.layer(osloApplicationDatabase)("through the application's statements", (it) => {
      it.effect("opens a family whose absolute window crosses the autumn clock change", () =>
        Effect.gen(function* () {
          yield* openFamily("autumn", "2026-10-20T12:00:00.000Z");

          expect(yield* readWindows("autumn")).toEqual({
            created: "2026-10-20T12:00:00.000Z",
            lastUsed: "2026-10-20T12:00:00.000Z",
            inactivityHours: 168,
            absoluteHours: 720,
          });
        }).pipe(Effect.orDie),
      );

      it.effect("opens a family whose windows cross the spring clock change", () =>
        Effect.gen(function* () {
          yield* openFamily("spring", "2027-03-25T12:00:00.000Z");

          expect(yield* readWindows("spring")).toEqual({
            created: "2027-03-25T12:00:00.000Z",
            lastUsed: "2027-03-25T12:00:00.000Z",
            inactivityHours: 168,
            absoluteHours: 720,
          });
        }).pipe(Effect.orDie),
      );

      it.effect(
        "restarts 168 hours of inactivity on a refresh before the autumn clock change",
        () =>
          Effect.gen(function* () {
            yield* openFamily("refresh", "2026-10-19T12:00:00.000Z");

            const pool = yield* DatabasePgPool;

            yield* pgTransaction(pool, (transaction) =>
              recordRefreshFamilyUse(
                transaction,
                "refresh",
                Date.parse("2026-10-20T12:00:00.000Z") / 1_000,
              ),
            );

            expect(yield* readWindows("refresh")).toEqual({
              created: "2026-10-19T12:00:00.000Z",
              lastUsed: "2026-10-20T12:00:00.000Z",
              inactivityHours: 168,
              absoluteHours: 720,
            });
          }).pipe(Effect.orDie),
      );
    });

    it.effect("upgrades families that the earlier statements wrote, on PostgreSQL", () =>
      Effect.gen(function* () {
        const pool = yield* osloDatabase("refresh_window_upgrade", windows.preceding);

        expect(yield* upgradeFromBefore0077(pool)).toEqual(upgradeEvidence);
      }).pipe(Effect.scoped, Effect.orDie),
    );

    it.effect("upgrades families that the earlier statements wrote, on PGlite", () =>
      withPostgresTestDatabase(upgradeFromBefore0077, windows.preceding).pipe(
        Effect.map((evidence) => expect(evidence).toEqual(upgradeEvidence)),
      ),
    );
  },
);
