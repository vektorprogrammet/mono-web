import assert from "node:assert/strict";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  Organization,
  OrganizationCommandId,
  OrganizationLive,
  PersonId,
  type CreateDepartmentCommand,
} from "@vektorprogrammet/domain/organization";
import { Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { DatabaseLive } from "./layers.js";
import { databaseSchemaRevision } from "./migrations.js";
import { runDatabaseMain } from "../runtime/node.js";

const proofCohort = {
  id: "organization-postgres-proof-0052-v1",
  replayCommandId: "organization-postgres-proof-replay-command",
  conflictCommandId: "organization-postgres-proof-conflict-command",
} as const;

const headSeparator = databaseSchemaRevision.indexOf("_");
const headMigrationId = Number(databaseSchemaRevision.slice(0, headSeparator));
const headMigrationName = databaseSchemaRevision.slice(headSeparator + 1);

const administrator = {
  _tag: "OrganizationAdministrator" as const,
  personId: PersonId.make("organization-postgres-proof-administrator"),
};

const replayCommand: CreateDepartmentCommand = {
  _tag: "CreateDepartment",
  commandId: OrganizationCommandId.make(proofCohort.replayCommandId),
  name: "Concurrent Replay Department",
  shortName: "CRD",
  email: "concurrent-replay@example.invalid",
  address: null,
  city: "Bergen",
  latitude: null,
  longitude: null,
};

const conflictCommandA: CreateDepartmentCommand = {
  _tag: "CreateDepartment",
  commandId: OrganizationCommandId.make(proofCohort.conflictCommandId),
  name: "Conflict Winner A",
  shortName: "CWA",
  email: "conflict-a@example.invalid",
  address: null,
  city: "Bergen",
  latitude: null,
  longitude: null,
};

const conflictCommandB: CreateDepartmentCommand = {
  ...conflictCommandA,
  name: "Conflict Winner B",
  shortName: "CWB",
  email: "conflict-b@example.invalid",
};

const makeProofLayer = (url: Redacted.Redacted<string>, applicationName: string) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(url)),
    applicationName,
    maxConnections: 1,
  });
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  return Layer.merge(databaseLayer, organizationLayer);
};

const resetProofCohort = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM organization_creation_audit
        WHERE command_id IN (${replayCommand.commandId}, ${conflictCommandA.commandId})
      `;
      yield* sql`
        DELETE FROM organization_departments
        WHERE native_creation_command_id IN (
          ${replayCommand.commandId},
          ${conflictCommandA.commandId}
        )
      `;
      yield* sql`
        DELETE FROM organization_command_receipts
        WHERE command_id IN (${replayCommand.commandId}, ${conflictCommandA.commandId})
      `;
    }),
  );

const contender = (
  command: CreateDepartmentCommand,
  ready: Deferred.Deferred<void>,
  start: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const organization = yield* Organization;
    const [connection] = yield* sql<{ readonly pid: number }>`
      SELECT pg_backend_pid() AS pid
    `;
    yield* Deferred.succeed(ready, undefined);
    yield* Deferred.await(start);
    const outcome = yield* Effect.result(organization.createDepartment(command, administrator));
    return { pid: connection?.pid ?? -1, outcome };
  });

const raceDepartmentCommands = (
  databaseUrl: Redacted.Redacted<string>,
  raceName: string,
  leftCommand: CreateDepartmentCommand,
  rightCommand: CreateDepartmentCommand,
) =>
  Effect.gen(function* () {
    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    const start = yield* Deferred.make<void>();
    const contenderA = yield* Effect.forkScoped(
      contender(leftCommand, readyA, start).pipe(
        Effect.provide(makeProofLayer(databaseUrl, `${raceName}-a`)),
      ),
    );
    const contenderB = yield* Effect.forkScoped(
      contender(rightCommand, readyB, start).pipe(
        Effect.provide(makeProofLayer(databaseUrl, `${raceName}-b`)),
      ),
    );
    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    yield* Deferred.succeed(start, undefined);
    return yield* Effect.all([Fiber.join(contenderA), Fiber.join(contenderB)], {
      concurrency: "unbounded",
    });
  });

const program = Effect.scoped(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.redacted("DATABASE_URL");
    const setup = yield* Effect.gen(function* () {
      const sql = yield* Database;
      assert.equal(sql.schemaRevision, databaseSchemaRevision);
      yield* resetProofCohort(sql);
      yield* sql`
        DELETE FROM vektorprogrammet_schema_migrations
        WHERE migration_id = ${headMigrationId}
      `;
      yield* sql.migrate;
      const [migration] = yield* sql<{ readonly count: string }>`
        SELECT count(*)::text AS count
        FROM vektorprogrammet_schema_migrations
        WHERE migration_id = ${headMigrationId}
          AND name = ${headMigrationName}
      `;
      return { migrationReplayed: Number(migration?.count ?? "-1") === 1 };
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "organization-postgres-proof-setup")));

    const identical = yield* raceDepartmentCommands(
      databaseUrl,
      "organization-postgres-proof-identical",
      replayCommand,
      replayCommand,
    );
    const conflicting = yield* raceDepartmentCommands(
      databaseUrl,
      "organization-postgres-proof-conflicting",
      conflictCommandA,
      conflictCommandB,
    );

    const durable = yield* Effect.gen(function* () {
      const sql = yield* Database;
      const [row] = yield* sql<{
        readonly receipts: string;
        readonly audits: string;
        readonly entities: string;
        readonly exactLinks: string;
      }>`
        WITH accepted(command_id) AS (
          VALUES
            (${replayCommand.commandId}::text),
            (${conflictCommandA.commandId}::text)
        ),
        linked AS (
          SELECT
            receipt.command_id,
            receipt.entity_id,
            audit.command_id AS audit_command_id,
            department.native_creation_command_id
          FROM accepted
          INNER JOIN organization_command_receipts AS receipt
            ON receipt.command_id = accepted.command_id
          INNER JOIN organization_creation_audit AS audit
            ON audit.command_id = receipt.command_id
            AND audit.entity_kind = receipt.entity_kind
            AND audit.entity_id = receipt.entity_id
            AND audit.actor_person_id = receipt.actor_person_id
            AND audit.occurred_at = receipt.committed_at
          INNER JOIN organization_departments AS department
            ON receipt.entity_kind = 'Department'
            AND department.department_id = receipt.entity_id
        )
        SELECT
          (SELECT count(*)::text
            FROM organization_command_receipts
            INNER JOIN accepted USING (command_id)) AS receipts,
          (SELECT count(*)::text
            FROM organization_creation_audit
            INNER JOIN accepted USING (command_id)) AS audits,
          (SELECT count(*)::text
            FROM organization_departments
            WHERE native_creation_command_id IN (
              ${replayCommand.commandId},
              ${conflictCommandA.commandId}
            )) AS entities,
          (SELECT count(*)::text FROM linked
            WHERE audit_command_id = command_id
              AND native_creation_command_id = command_id) AS "exactLinks"
      `;
      return {
        receipts: Number(row?.receipts ?? "-1"),
        audits: Number(row?.audits ?? "-1"),
        entities: Number(row?.entities ?? "-1"),
        exactLinks: Number(row?.exactLinks ?? "-1"),
      };
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "organization-postgres-proof-observer")));

    const identicalSuccesses = identical.filter((entry) => entry.outcome._tag === "Success");
    const identicalCommitted = identicalSuccesses.filter(
      (entry) => entry.outcome._tag === "Success" && entry.outcome.success.committed,
    ).length;
    const identicalReplayed = identicalSuccesses.filter(
      (entry) => entry.outcome._tag === "Success" && !entry.outcome.success.committed,
    ).length;
    const conflictingCommitted = conflicting.filter(
      (entry) => entry.outcome._tag === "Success" && entry.outcome.success.committed,
    ).length;
    const conflictingRejected = conflicting.filter(
      (entry) =>
        entry.outcome._tag === "Failure" &&
        entry.outcome.failure._tag === "OrganizationCommandConflict",
    ).length;

    const evidence = {
      specId: "0052" as const,
      database: "PostgreSQL" as const,
      schemaRevision: databaseSchemaRevision,
      cohort: proofCohort.id,
      passed: true as const,
      migration: setup,
      identicalCommandConcurrency: {
        independentConnectionIds: identical.map((entry) => entry.pid),
        independentConnections: identical[0]?.pid !== identical[1]?.pid,
        committed: identicalCommitted,
        replayed: identicalReplayed,
      },
      conflictingCommandConcurrency: {
        independentConnectionIds: conflicting.map((entry) => entry.pid),
        independentConnections: conflicting[0]?.pid !== conflicting[1]?.pid,
        committed: conflictingCommitted,
        commandConflicts: conflictingRejected,
      },
      durable,
    };

    assert.equal(evidence.migration.migrationReplayed, true);
    assert.deepEqual(evidence.identicalCommandConcurrency, {
      independentConnectionIds: evidence.identicalCommandConcurrency.independentConnectionIds,
      independentConnections: true,
      committed: 1,
      replayed: 1,
    });
    assert.deepEqual(evidence.conflictingCommandConcurrency, {
      independentConnectionIds: evidence.conflictingCommandConcurrency.independentConnectionIds,
      independentConnections: true,
      committed: 1,
      commandConflicts: 1,
    });
    assert.deepEqual(evidence.durable, {
      receipts: 2,
      audits: 2,
      entities: 2,
      exactLinks: 2,
    });

    const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
    yield* Effect.sync(() =>
      process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
    );
  }),
);

runDatabaseMain(program);
