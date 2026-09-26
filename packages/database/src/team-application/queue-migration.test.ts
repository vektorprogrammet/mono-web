import { expect, layer } from "@effect/vitest";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { Pool } from "pg";
import { type DatabaseMigrationDefinition, selectDatabaseMigration } from "../migrations.js";
import { pgQuery } from "../pg-pool.js";
import { TestPlatform } from "../test-support/platform.js";
import { withPostgresTestDatabase } from "../test-support/postgres.js";

/**
 * Migrations 78 and 79 move the team application claim outbox onto its PersistedQueue: an
 * upgrade proof. The rows are written by the statements of the application before
 * migration 78, then both migrations run, on PGlite and on the selected PostgreSQL major.
 */
const move = selectDatabaseMigration("78_team-application-persisted-queue");

const drop = selectDatabaseMigration("79_team-application-outbox-claim-columns").migration;

const readSql = (migration: DatabaseMigrationDefinition) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
  });

const temporary = "MailDeliveryError:temporary-unavailability";

const commands = ["pending", "released", "failed", "processing", "settled", "cancelled"] as const;

/** The first claim time of the in-flight rows: their lease runs from it. */
const claimedAt = "2026-09-26T10:00:00.000Z";

/** The statements of the claim outbox, as its worker, submission, and deletion ran them. */
const claimOutbox = (pool: Pool) => {
  const run = (statement: string, values: ReadonlyArray<unknown> = []) =>
    pgQuery(pool, statement, values);

  return {
    insert: (
      command: string,
      applicationId: string,
      effectType: string,
      ordinal: number,
      committedAt: string,
    ) => {
      const effectId = `${command}:${effectType}`;

      return run(
        `INSERT INTO public.team_application_outbox (
           effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json,
           committed_at
         ) VALUES ($1, $2, 'migration-team', $3, $4, $5, $6, $7)`,
        [
          effectId,
          effectType,
          applicationId,
          command,
          ordinal,
          JSON.stringify({
            deliveryId: effectId,
            recipient: "ada@example.invalid",
            replyTo: "it@example.invalid",
            subject: "Søknad til IT mottatt",
            text: "Vi har mottatt søknaden din.",
          }),
          committedAt,
        ],
      );
    },
    /** The claim assignments of `outboxClaimAssignments`, narrowed to one effect. */
    claim: (effectId: string, claimId: string, at: string) =>
      run(
        `UPDATE public.team_application_outbox AS claimed
            SET status = 'Processing', claim_id = $2, claimed_at = $3,
                attempts = claimed.attempts + 1, last_failure_tag = NULL
          WHERE claimed.effect_id = $1 AND claimed.status IN ('Pending', 'Failed')`,
        [effectId, claimId, at],
      ),
    /** `leaveProcessing` of outbox-lifecycle.ts with the settle's assignments. */
    settle: (effectId: string, claimId: string, assignments: string) =>
      run(
        `UPDATE public.team_application_outbox
            SET ${assignments}, claim_id = NULL, claimed_at = NULL
          WHERE effect_id = $1 AND status = 'Processing' AND claim_id = $2
          RETURNING effect_id`,
        [effectId, claimId],
      ),
    cancel: (applicationId: string) =>
      run(
        `UPDATE public.team_application_outbox SET
           status = 'Cancelled', payload_json = '{}'::jsonb, claim_id = NULL, claimed_at = NULL,
           last_failure_tag = 'TeamApplicationDeleted'
         WHERE application_id = $1 AND status IN ('Pending', 'Processing', 'Failed')`,
        [applicationId],
      ),
  };
};

const failed = `status = 'Failed', last_failure_tag = '${temporary}'`;

/** Writes every outbox state through the claim outbox's own statements. */
const seed = (pool: Pool) =>
  Effect.gen(function* () {
    yield* pgQuery(
      pool,
      `INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
         VALUES ('migration-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim');
       INSERT INTO public.organization_teams (team_id, department_id, name, email, accept_application, active)
         VALUES ('migration-team', 'migration-department', 'IT', 'it@example.invalid', true, true);`,
    );

    const outbox = claimOutbox(pool);

    for (const [index, command] of [...commands, "late"].entries()) {
      const applicationId = `00000000-0000-4000-8000-00000000000${index}`;
      const committedAt = `2026-09-26T09:0${index}:00.000Z`;

      yield* pgQuery(
        pool,
        `INSERT INTO public.team_application_command_receipts
           (command_id, command_sha256, operation, team_id, application_id, observation_json, committed_at)
         VALUES ($1, $2, 'SubmitTeamApplication', 'migration-team', $3, '{}', $4)`,
        [command, "a".repeat(64), applicationId, committedAt],
      );

      // The late command submits only after the migration.
      if (command === "late") continue;

      yield* outbox.insert(command, applicationId, "SendTeamApplicationReceipt", 0, committedAt);
      yield* outbox.insert(command, applicationId, "NotifyTeamOfApplication", 1, committedAt);
    }

    const receipt = (command: string) => `${command}:SendTeamApplicationReceipt`;
    const notification = (command: string) => `${command}:NotifyTeamOfApplication`;

    // An interrupted attempt released its claim to Pending.
    yield* outbox.claim(receipt("released"), "worker-a", "2026-09-26T09:30:00.000Z");
    yield* outbox.settle(
      receipt("released"),
      "worker-a",
      "status = 'Pending', last_failure_tag = 'InterruptedTeamApplicationOutboxClaim'",
    );

    // Temporary provider failures wait for the next claim.
    for (const claim of ["worker-a", "worker-b"]) {
      yield* outbox.claim(receipt("failed"), claim, "2026-09-26T09:31:00.000Z");
      yield* outbox.settle(receipt("failed"), claim, failed);
    }

    yield* outbox.claim(notification("failed"), "worker-a", "2026-09-26T09:32:00.000Z");
    yield* outbox.settle(notification("failed"), "worker-a", failed);

    // Two attempts in flight when the migration runs, the second after a failure.
    yield* outbox.claim(receipt("processing"), "worker-in-flight", claimedAt);
    yield* outbox.claim(notification("processing"), "worker-a", "2026-09-26T09:33:00.000Z");
    yield* outbox.settle(notification("processing"), "worker-a", failed);
    yield* outbox.claim(notification("processing"), "worker-in-flight", claimedAt);

    yield* outbox.claim(receipt("settled"), "worker-a", "2026-09-26T09:34:00.000Z");
    yield* outbox.settle(
      receipt("settled"),
      "worker-a",
      "status = 'Delivered', last_failure_tag = NULL, payload_json = '{}'::jsonb",
    );
    yield* outbox.claim(notification("settled"), "worker-a", "2026-09-26T09:35:00.000Z");
    yield* outbox.settle(
      notification("settled"),
      "worker-a",
      "status = 'Quarantined', last_failure_tag = 'InvalidTeamApplicationEnvelope', payload_json = '{}'::jsonb",
    );

    yield* outbox.cancel("00000000-0000-4000-8000-000000000005");
  });

/** Each effect's status, attempts, and failure tag, and whether it keeps its envelope. */
const readOutbox = (pool: Pool) =>
  pgQuery<{
    readonly effect_id: string;
    readonly status: string;
    readonly attempts: number;
    readonly last_failure_tag: string | null;
    readonly envelope: boolean;
  }>(
    pool,
    `SELECT effect_id, status, attempts, last_failure_tag, payload_json <> '{}'::jsonb AS envelope
       FROM public.team_application_outbox ORDER BY committed_at, command_id, ordinal`,
  ).pipe(Effect.map(({ rows }) => rows));

/** The same facts through the delivery state view that replaces the claim columns. */
const readDeliveryState = (pool: Pool) =>
  pgQuery<{
    readonly effect_id: string;
    readonly status: string;
    readonly attempts: number;
    readonly last_failure_tag: string | null;
    readonly envelope: boolean;
  }>(
    pool,
    `SELECT state.effect_id, state.status, state.attempts, state.last_failure_tag,
            outbox.payload_json <> '{}'::jsonb AS envelope
       FROM public.team_application_delivery_state AS state
       JOIN public.team_application_outbox AS outbox USING (effect_id)
      ORDER BY state.committed_at, state.command_id, state.ordinal`,
  ).pipe(Effect.map(({ rows }) => rows));

const readQueue = (pool: Pool) =>
  pgQuery<{
    readonly id: string;
    readonly element: string;
    readonly state: string;
    readonly attempts: number;
    readonly leased: boolean;
    readonly leased_since: string | null;
  }>(
    pool,
    `SELECT id, element::json ->> 'effectId' AS element, state, attempts,
            acquired_by IS NOT NULL AS leased,
            to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS leased_since
       FROM public.effect_queue WHERE queue_name = 'team-application-notification'
      ORDER BY sequence`,
  ).pipe(Effect.map(({ rows }) => rows));

/**
 * Runs one statement of the claim outbox in the database and answers the SQLSTATE that
 * rejected it or the number of rows that it changed. The error stays in the database:
 * PGlite's socket server closes a connection that reports one.
 */
const attempt = (pool: Pool, statement: string) =>
  pgQuery(
    pool,
    `CREATE OR REPLACE FUNCTION public.queue_migration_attempt(statement text) RETURNS text
     LANGUAGE plpgsql AS $$
     DECLARE changed integer;
     BEGIN
       EXECUTE statement;
       GET DIAGNOSTICS changed = ROW_COUNT;
       RETURN 'changed ' || changed;
     EXCEPTION WHEN OTHERS THEN
       RETURN 'rejected ' || SQLSTATE;
     END $$`,
  ).pipe(
    Effect.andThen(
      pgQuery<{ readonly outcome: string }>(
        pool,
        "SELECT public.queue_migration_attempt($1) AS outcome",
        [statement],
      ),
    ),
    Effect.map(({ rows }) => rows[0]?.outcome),
  );

/** Seeds through migration 77, migrates to 78, runs the claim outbox again, and migrates to 79. */
const upgrade = (pool: Pool) =>
  Effect.gen(function* () {
    yield* seed(pool);

    const before = yield* readOutbox(pool);

    yield* pgQuery(pool, yield* readSql(move.migration));

    const moved = yield* readDeliveryState(pool);
    const queue = yield* readQueue(pool);

    // A process that still runs the claim outbox can no longer write its claim columns.
    const claimWriters = {
      claim: yield* attempt(
        pool,
        `UPDATE public.team_application_outbox AS claimed
            SET status = 'Processing', claim_id = 'worker-late', claimed_at = '${claimedAt}',
                attempts = claimed.attempts + 1, last_failure_tag = NULL
          WHERE claimed.effect_id = 'pending:SendTeamApplicationReceipt'
            AND claimed.status IN ('Pending', 'Failed')`,
      ),
      settle: yield* attempt(
        pool,
        `UPDATE public.team_application_outbox
            SET status = 'Delivered', last_failure_tag = NULL, payload_json = '{}'::jsonb,
                claim_id = NULL, claimed_at = NULL
          WHERE effect_id = 'processing:SendTeamApplicationReceipt'
            AND status = 'Processing' AND claim_id = 'worker-in-flight'`,
      ),
      recoverStale: yield* attempt(
        pool,
        `UPDATE public.team_application_outbox
            SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
                last_failure_tag = 'StaleTeamApplicationOutboxClaim'
          WHERE status = 'Processing' AND claimed_at < now()`,
      ),
      submit: yield* attempt(
        pool,
        `INSERT INTO public.team_application_outbox (
           effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json,
           committed_at
         ) VALUES (
           'late:SendTeamApplicationReceipt', 'SendTeamApplicationReceipt', 'migration-team',
           '00000000-0000-4000-8000-000000000006', 'late', 0, '{}'::jsonb,
           '2026-09-26T11:00:00.000Z'
         )`,
      ),
    };

    yield* pgQuery(pool, "DROP FUNCTION public.queue_migration_attempt(text)");
    yield* pgQuery(pool, yield* readSql(drop));

    const claimColumns = yield* pgQuery<{ readonly column_name: string }>(
      pool,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'team_application_outbox'
          AND column_name IN ('claim_id', 'claimed_at', 'attempts')`,
    ).pipe(Effect.map(({ rows }) => rows.map(({ column_name }) => column_name)));

    return {
      before,
      moved,
      queue,
      claimWriters,
      claimColumns,
      dropped: yield* readDeliveryState(pool),
    };
  });

const row = (
  effect_id: string,
  status: string,
  attempts: number,
  last_failure_tag: string | null,
  envelope: boolean,
) => ({ effect_id, status, attempts, last_failure_tag, envelope });

const beforeRows = [
  row("pending:SendTeamApplicationReceipt", "Pending", 0, null, true),
  row("pending:NotifyTeamOfApplication", "Pending", 0, null, true),
  row(
    "released:SendTeamApplicationReceipt",
    "Pending",
    1,
    "InterruptedTeamApplicationOutboxClaim",
    true,
  ),
  row("released:NotifyTeamOfApplication", "Pending", 0, null, true),
  row("failed:SendTeamApplicationReceipt", "Failed", 2, temporary, true),
  row("failed:NotifyTeamOfApplication", "Failed", 1, temporary, true),
  row("processing:SendTeamApplicationReceipt", "Processing", 1, null, true),
  row("processing:NotifyTeamOfApplication", "Processing", 2, null, true),
  row("settled:SendTeamApplicationReceipt", "Delivered", 1, null, false),
  row("settled:NotifyTeamOfApplication", "Quarantined", 1, "InvalidTeamApplicationEnvelope", false),
  row("cancelled:SendTeamApplicationReceipt", "Cancelled", 0, "TeamApplicationDeleted", false),
  row("cancelled:NotifyTeamOfApplication", "Cancelled", 0, "TeamApplicationDeleted", false),
];

const upgradeEvidence = {
  // The delivery state keeps every id, status, attempt count, tag, and envelope.
  before: beforeRows,
  moved: beforeRows,
  queue: beforeRows.map(({ effect_id, status, attempts }) => ({
    id: effect_id,
    element: effect_id,
    state: ["Delivered", "Quarantined", "Cancelled"].includes(status) ? "completed" : "pending",
    attempts,
    leased: status === "Processing",
    leased_since: status === "Processing" ? claimedAt : null,
  })),
  claimWriters: {
    claim: "rejected 23514",
    settle: "changed 0",
    recoverStale: "changed 0",
    submit: "rejected 23502",
  },
  claimColumns: [],
  dropped: beforeRows,
};

class MigrationCluster extends Context.Service<MigrationCluster, DisposablePostgres>()(
  "team-application/queue-migration.test/MigrationCluster",
) {}

const migrationCluster = Layer.effect(
  MigrationCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (cluster) => Effect.promise(() => cluster.stop()),
  ),
);

/** A new database of the cluster, migrated through `migrations`. */
const clusterDatabase = (name: string, migrations: ReadonlyArray<DatabaseMigrationDefinition>) =>
  Effect.gen(function* () {
    const cluster = yield* MigrationCluster;

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

    const pool = yield* connect(name);

    for (const migration of migrations) yield* pgQuery(pool, yield* readSql(migration));

    return pool;
  });

layer(Layer.merge(migrationCluster, TestPlatform), {
  excludeTestServices: true,
  timeout: "120 seconds",
})("team application queue migration", (it) => {
  it.effect(
    "moves in-flight rows with their original ids and states, and drops the claim columns only after no worker can write them, on PostgreSQL",
    () =>
      Effect.gen(function* () {
        const pool = yield* clusterDatabase("team_application_queue", move.preceding);

        expect(yield* upgrade(pool)).toEqual(upgradeEvidence);
      }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect(
    "moves in-flight rows with their original ids and states, and drops the claim columns only after no worker can write them, on PGlite",
    () =>
      withPostgresTestDatabase(upgrade, move.preceding).pipe(
        Effect.map((evidence) => expect(evidence).toEqual(upgradeEvidence)),
        Effect.orDie,
      ),
  );
});
