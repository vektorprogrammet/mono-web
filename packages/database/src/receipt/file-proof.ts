import type { PgPoolConfig } from "@effect/sql-pg/PgClient";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  databaseMigrationLoader,
  type ExecuteMigration,
  runDatabaseMigrations,
} from "../migrations.js";
import { sharedPgLayer } from "../pg-pool.js";
import { Database } from "../service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { Predicate, Cause, Effect } from "effect";
import {
  ReceiptId,
  ReceiptCommandRequestSchema,
  ReceiptAuxiliaryEffects,
  ReceiptFileService,
  type ReceiptFileRecordingSnapshot,
  type ReceiptOutboxDeliveryResult,
  type ReceiptPersistenceError,
} from "@vektorprogrammet/domain/receipt";
import {
  claimNextReceiptOutbox,
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "./outbox.js";
import { executeReceiptCommand } from "./postgres.js";
import { ReceiptVisualId, type ReceiptFile } from "@vektorprogrammet/domain/receipt";

interface OutboxStateRow {
  readonly status: string;
  readonly count: string;
  readonly attempts: string;
}

interface SchemaDefinitionRow {
  readonly kind: string;
  readonly relation: string;
  readonly name: string;
  readonly definition: string;
}

export interface ReceiptFileProofEvidence {
  readonly specId: "0034";
  readonly sourceRevision: "463d98c88e3ac89cbe6c4de28e449e69eca0a532";
  readonly database: "PostgreSQL";
  readonly providerCalls: 0;
  readonly networkCalls: 0;
  readonly productionCalls: 0;
  readonly accepted: {
    readonly submit: true;
    readonly revise: true;
    readonly withdraw: true;
    readonly staleClaimRecovery: true;
    readonly injectedFailure: true;
    readonly retry: true;
    readonly schemaUpgradeEquivalent: true;
  };
  readonly concurrency: {
    readonly acceptedResolutions: 1;
    readonly rejectedResolutions: 1;
    readonly exclusiveClaims: true;
    readonly concurrentDrains: true;
    readonly concurrentDrainClaims: true;
    readonly sameCommandAccepted: number;
    readonly sameCommandReplayed: number;
    readonly conflictingCommandAccepted: number;
    readonly conflictingCommandConflicts: number;
  };
  readonly staleRecovery: {
    readonly discoveredClaimIds: ReadonlyArray<string>;
    readonly recovered: number;
    readonly reclaimed: true;
    readonly delivered: true;
  };
  readonly delivery: {
    readonly delivered: number;
    readonly failed: number;
    readonly duplicateFileEffects: number;
    readonly orderedReplacement: true;
    readonly currentPreservedOnFailure: true;
  };
  readonly files: ReceiptFileRecordingSnapshot;
  readonly auxiliaryEffectIds: ReadonlyArray<string>;
  readonly outbox: ReadonlyArray<{
    readonly status: string;
    readonly count: number;
    readonly attempts: number;
  }>;
}

const original: ReceiptFile = {
  fileRef: "staged/proof-file-original",
  objectKey: "receipts/proof-file-original",
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "c".repeat(64),
};

const replacement: ReceiptFile = {
  fileRef: "staged/proof-file-replacement",
  objectKey: "receipts/proof-file-replacement",
  contentType: "image/png",
  byteLength: 512,
  sha256: "d".repeat(64),
};

const raceFile: ReceiptFile = {
  fileRef: "staged/proof-file-race",
  objectKey: "receipts/proof-file-race",
  contentType: "image/jpeg",
  byteLength: 384,
  sha256: "e".repeat(64),
};

const identicalFile: ReceiptFile = {
  fileRef: "staged/proof-file-concurrent-identical",
  objectKey: "receipts/proof-file-concurrent-identical",
  contentType: "application/pdf",
  byteLength: 640,
  sha256: "f".repeat(64),
};

const conflictFile: ReceiptFile = {
  fileRef: "staged/proof-file-concurrent-conflict",
  objectKey: "receipts/proof-file-concurrent-conflict",
  contentType: "application/pdf",
  byteLength: 768,
  sha256: "a".repeat(64),
};

const ownerPersonId = PersonId.make("file-proof-owner");

const approverPersonId = PersonId.make("file-proof-approver");

interface ReceiptFileProofCommandContext {
  readonly receiptId: string;
  readonly visualId: string;
  readonly now: string;
}

const context = (
  receiptId: string,
  visualId: string,
  now: string,
): ReceiptFileProofCommandContext => ({
  receiptId,
  visualId,
  now,
});

const principal = (personId: PersonId, authorizationInstant: string) => ({
  personId,
  authorizationInstant,
});

const allocation = (value: ReceiptFileProofCommandContext) => ({
  receiptId: ReceiptId.make(value.receiptId),
  visualId: ReceiptVisualId.make(value.visualId),
});

const submitCommand = (commandId: string, description: string, file: ReceiptFile) => ({
  _tag: "SubmitReceipt" as const,
  commandId,
  departmentId: DepartmentId.make("file-proof-department"),
  description,
  amountOre: 12_345,
  receiptDate: "2026-08-20",
  file,
});

const submit = (
  commandId: string,
  receiptId: string,
  visualId: string,
  file: ReceiptFile,
  now: string,
) => {
  const commandContext = context(receiptId, visualId, now);

  return executeReceiptCommand(
    submitCommand(commandId, "Receipt file proof", file),
    principal(ownerPersonId, now),
    allocation(commandContext),
  );
};

const hasFailureTag = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
  tag: string,
): boolean =>
  Predicate.isTagged(result, "Failure") &&
  result.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      (reason.error === null || Predicate.isObjectOrArray(reason.error)) &&
      reason.error !== null &&
      "_tag" in reason.error &&
      reason.error._tag === tag,
  );

const drain = (
  count: number,
  prefix: string,
  claimedAt: string,
): Effect.Effect<
  ReadonlyArray<ReceiptOutboxDeliveryResult>,
  ReceiptPersistenceError,
  Database | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => deliverNextReceiptOutbox(`${prefix}-${index}`, claimedAt),
  );

/** Constraint and index definitions of the tables that `0001-receipt-authority.sql` creates. */
const receiptSchemaDefinition = (sql: SqlClient.SqlClient) =>
  sql<SchemaDefinitionRow>`
    WITH receipt_table AS (
      SELECT table_name::regclass AS relation
      FROM unnest(ARRAY[
        'economy_receipts',
        'economy_receipt_command_receipts',
        'economy_receipt_outbox',
        'economy_receipt_audit',
        'economy_receipt_import_ledger'
      ]) AS table_name
    )
    SELECT 'constraint' AS kind, constraint_row.conrelid::regclass::text AS relation,
      constraint_row.conname AS name, pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (SELECT relation FROM receipt_table)
    UNION ALL
    SELECT 'index' AS kind, index_row.indrelid::regclass::text AS relation,
      index_row.indexrelid::regclass::text AS name,
      pg_get_indexdef(index_row.indexrelid) AS definition
    FROM pg_index AS index_row
    WHERE index_row.indrelid IN (SELECT relation FROM receipt_table)
    ORDER BY kind, relation, name
  `;

/** Migration 4 replays `0001-receipt-authority.sql` over databases that migrations 1-3 created. */
const receiptAuthorityReplayMigrationId = 4;

/**
 * Reverts what later versions of `0001-receipt-authority.sql` added before migration 4 replays it:
 * claim fencing, identity checks, the amount bound, file uniqueness, and the import occurrence.
 * Restores the first command-ordinal index and import ledger primary key.
 */
const legacyReceiptAuthority = `
  ALTER TABLE economy_receipt_outbox
    DROP CONSTRAINT IF EXISTS economy_receipt_outbox_status_check;
  ALTER TABLE economy_receipt_outbox
    DROP CONSTRAINT IF EXISTS economy_receipt_outbox_claim_check;
  ALTER TABLE economy_receipt_outbox
    DROP CONSTRAINT IF EXISTS economy_receipt_outbox_nonempty_identity_check;
  ALTER TABLE economy_receipt_outbox
    DROP COLUMN IF EXISTS claim_id,
    DROP COLUMN IF EXISTS claimed_at,
    DROP COLUMN IF EXISTS last_failure_tag;
  ALTER TABLE economy_receipt_outbox
    ADD CONSTRAINT economy_receipt_outbox_status_check
    CHECK (status IN ('Pending', 'Delivered', 'Failed'));
  ALTER TABLE economy_receipts
    DROP CONSTRAINT IF EXISTS economy_receipts_amount_ore_check;
  ALTER TABLE economy_receipts
    DROP CONSTRAINT IF EXISTS economy_receipts_nonempty_identity_check;
  ALTER TABLE economy_receipts
    DROP CONSTRAINT IF EXISTS economy_receipts_distinct_file_identity_check;
  ALTER TABLE economy_receipts
    ADD CONSTRAINT economy_receipts_amount_ore_check CHECK (amount_ore > 0);
  ALTER TABLE economy_receipt_command_receipts
    DROP CONSTRAINT IF EXISTS economy_receipt_command_receipts_nonempty_identity_check;
  DROP INDEX IF EXISTS economy_receipts_file_ref_unique;
  DROP INDEX IF EXISTS economy_receipts_file_object_key_unique;
  CREATE UNIQUE INDEX economy_receipt_outbox_command_ordinal
    ON economy_receipt_outbox (command_id, ordinal);
  ALTER TABLE economy_receipt_import_ledger
    DROP CONSTRAINT IF EXISTS economy_receipt_import_ledger_pkey;
  ALTER TABLE economy_receipt_import_ledger
    DROP COLUMN IF EXISTS source_occurrence;
  ALTER TABLE economy_receipt_import_ledger
    ADD CONSTRAINT economy_receipt_import_ledger_pkey PRIMARY KEY (
      source_repository, source_revision, snapshot_id, source_primary_key, transformation_revision
    );
`;

/** Migration 4 recorded before `e44bf70e` replayed a 0001 without the `file_byte_length` bound. */
const replayedReceiptAuthority = `
  ALTER TABLE economy_receipts
    DROP CONSTRAINT IF EXISTS economy_receipts_file_byte_length_check;
  ALTER TABLE economy_receipts
    ADD CONSTRAINT economy_receipts_file_byte_length_check CHECK (file_byte_length > 0);
`;

const executeMigration: ExecuteMigration = (source) =>
  SqlClient.SqlClient.use((sql) => sql.unsafe(source).pipe(Effect.asVoid));

const migrateThrough = (lastMigrationId: number) =>
  Migrator.make({})({
    loader: databaseMigrationLoader(executeMigration).pipe(
      Effect.map((migrations) => migrations.filter(([id]) => id <= lastMigrationId)),
    ),
    table: "vektorprogrammet_schema_migrations",
  });

/**
 * Upgrades a legacy Receipt database in phases: migrations 1-3 and the legacy Receipt authority,
 * migration 4 and its replay-era file size check, then the remaining migrations as `DatabaseLive`
 * runs them.
 */
const upgradedLegacyReceiptSchema = (database: PgPoolConfig) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacyMigrations = yield* migrateThrough(receiptAuthorityReplayMigrationId - 1);
    yield* sql.unsafe(legacyReceiptAuthority);
    const replayMigrations = yield* migrateThrough(receiptAuthorityReplayMigrationId);
    yield* sql.unsafe(replayedReceiptAuthority);
    const appliedMigrationIds = [...legacyMigrations, ...replayMigrations].map(([id]) => id).join();

    if (appliedMigrationIds !== "1,2,3,4") {
      throw new Error(`legacy Receipt upgrade applied migrations ${appliedMigrationIds}, not 1-4`);
    }

    yield* runDatabaseMigrations(executeMigration);

    return yield* receiptSchemaDefinition(sql);
  }).pipe(Effect.provide(sharedPgLayer(database)));

export const runReceiptFileProof = (
  fileSnapshot: Effect.Effect<ReceiptFileRecordingSnapshot>,
  failNextFileEffect: (effectId: string) => Effect.Effect<void>,
  auxiliaryEffectIds: Effect.Effect<ReadonlyArray<string>>,
  legacyUpgradeDatabase: PgPoolConfig,
): Effect.Effect<
  ReceiptFileProofEvidence,
  unknown,
  Database | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const files = yield* ReceiptFileService;
    yield* sql.unsafe(`
      INSERT INTO person_profiles (person_id, first_name, last_name) VALUES
        ('file-proof-owner', 'File', 'Owner'),
        ('file-proof-approver', 'File', 'Approver');
      INSERT INTO organization_departments (
        department_id, name, short_name, email, city
      ) VALUES (
        'file-proof-department', 'File Proof Department', 'FILE',
        'file-proof@example.invalid', 'Bergen'
      );
      INSERT INTO organization_teams (team_id, department_id, name)
      VALUES ('file-proof-team', 'file-proof-department', 'File Proof Team');
      INSERT INTO organization_memberships (
        membership_id, person_id, team_id, start_at
      ) VALUES
        ('file-proof-owner-membership', 'file-proof-owner', 'file-proof-team',
          '2026-01-01T00:00:00.000Z'),
        ('file-proof-approver-membership', 'file-proof-approver', 'file-proof-team',
          '2026-01-01T00:00:00.000Z');
      INSERT INTO economy_payment_authorities (
        payment_authority_id, person_id, department_id,
        payment_account_ciphertext, start_at
      ) VALUES (
        'file-proof-payment', 'file-proof-owner', 'file-proof-department',
        'ciphertext:v1:file-proof-account', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO economy_receipt_approval_grants (
        approval_grant_id, person_id, scope, department_id, start_at
      ) VALUES (
        'file-proof-approval', 'file-proof-approver', 'Department',
        'file-proof-department', '2026-01-01T00:00:00.000Z'
      );
    `);

    const freshSchema = yield* receiptSchemaDefinition(sql);
    const upgradedSchema = yield* upgradedLegacyReceiptSchema(legacyUpgradeDatabase);
    const freshDefinitions = new Set(freshSchema.map((row) => canonicalJson(row)));
    const upgradedDefinitions = new Set(upgradedSchema.map((row) => canonicalJson(row)));

    const differingDefinitions = {
      freshOnly: freshSchema.filter((row) => !upgradedDefinitions.has(canonicalJson(row))),
      upgradedOnly: upgradedSchema.filter((row) => !freshDefinitions.has(canonicalJson(row))),
    };

    if (differingDefinitions.freshOnly.length > 0 || differingDefinitions.upgradedOnly.length > 0) {
      throw new Error(
        `fresh and upgraded Receipt schemas differ: ${canonicalJson(differingDefinitions)}`,
      );
    }

    yield* files.stage(original);
    yield* files.stage(replacement);
    yield* files.stage(raceFile);
    yield* files.stage(identicalFile);
    yield* files.stage(conflictFile);

    yield* submit(
      "file-proof-submit",
      "file-proof-receipt",
      "FILE-PROOF-1",
      original,
      "2026-08-20T16:00:00.000Z",
    );
    const submitDelivery = yield* drain(3, "claim-submit", "2026-08-20T16:01:00.000Z");

    yield* executeReceiptCommand(
      ReceiptCommandRequestSchema.cases.RevisePendingReceipt.make({
        commandId: "file-proof-revise",
        receiptId: ReceiptId.make("file-proof-receipt"),
        expectedRevision: 0,
        description: "Receipt file proof replacement",
        amountOre: 13_000,
        receiptDate: "2026-08-20",
        file: replacement,
      }),
      principal(ownerPersonId, "2026-08-20T16:02:00.000Z"),
    );

    const staleClaim = yield* claimNextReceiptOutbox(
      "claim-stale-dead-process",
      "2026-08-20T16:03:00.000Z",
    );

    if (staleClaim === undefined) throw new Error("expected replacement promote claim");

    const staleClaimIds = yield* listStaleReceiptOutboxClaimIds(
      "2026-08-20T16:04:00.000Z",
      "file-proof-receipt",
    );

    if (!staleClaimIds.includes(staleClaim.claimId)) {
      throw new Error("stale Receipt outbox claim was not explicitly discovered");
    }

    const recovered = yield* recoverStaleReceiptOutbox(
      staleClaim.claimId,
      "2026-08-20T16:04:00.000Z",
    );

    yield* Effect.sync(() => {
      if (recovered !== 1) throw new Error("expected one stale Receipt outbox claim");
    });

    const fileRecording = yield* fileSnapshot;
    yield* Effect.sync(() => {
      if (fileRecording.current[0]?.objectKey !== original.objectKey) {
        throw new Error("stale claim changed the current file");
      }
    });

    yield* failNextFileEffect("file-proof-revise:PromoteReceiptFile");

    const failedDelivery = yield* deliverNextReceiptOutbox(
      "claim-replacement-failure",
      "2026-08-20T16:05:00.000Z",
    );

    const currentAfterFailure = yield* fileSnapshot;

    const replacementDelivery = yield* deliverNextReceiptOutbox(
      "claim-replacement-retry",
      "2026-08-20T16:06:00.000Z",
    );

    const reviseRemainder = yield* drain(2, "claim-revise", "2026-08-20T16:07:00.000Z");

    yield* executeReceiptCommand(
      ReceiptCommandRequestSchema.cases.WithdrawPendingReceipt.make({
        commandId: "file-proof-withdraw",
        receiptId: ReceiptId.make("file-proof-receipt"),
        expectedRevision: 1,
      }),
      principal(ownerPersonId, "2026-08-20T16:08:00.000Z"),
    );
    const withdrawDelivery = yield* drain(2, "claim-withdraw", "2026-08-20T16:09:00.000Z");

    yield* submit(
      "file-proof-race-submit",
      "file-proof-race-receipt",
      "FILE-PROOF-2",
      raceFile,
      "2026-08-20T16:10:00.000Z",
    );

    const raceContext = context(
      "file-proof-race-receipt",
      "FILE-PROOF-2",
      "2026-08-20T16:11:00.000Z",
    );

    const workerClaims = yield* Effect.all(
      [
        claimNextReceiptOutbox("claim-worker-a", "2026-08-20T16:10:30.000Z"),
        claimNextReceiptOutbox("claim-worker-b", "2026-08-20T16:10:30.000Z"),
      ],
      { concurrency: "unbounded" },
    );

    const workerClaim = workerClaims.find((claim) => claim !== undefined);

    if (
      workerClaim === undefined ||
      workerClaims.filter((claim) => claim !== undefined).length !== 1
    ) {
      throw new Error("concurrent Receipt outbox claims were not exclusive");
    }

    const workerClaimsRecovered = yield* recoverStaleReceiptOutbox(
      workerClaim.claimId,
      "2026-08-20T16:10:31.000Z",
    );

    if (workerClaimsRecovered !== 1) {
      throw new Error("exclusive Receipt outbox claim was not recoverable");
    }

    const [approve, reject] = yield* Effect.all(
      [
        Effect.exit(
          executeReceiptCommand(
            ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
              commandId: "file-proof-race-approve",
              receiptId: ReceiptId.make("file-proof-race-receipt"),
              expectedRevision: 0,
            }),
            principal(approverPersonId, raceContext.now),
          ),
        ),
        Effect.exit(
          executeReceiptCommand(
            ReceiptCommandRequestSchema.cases.RejectReceipt.make({
              commandId: "file-proof-race-reject",
              receiptId: ReceiptId.make("file-proof-race-receipt"),
              expectedRevision: 0,
            }),
            principal(approverPersonId, raceContext.now),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const [raceDrainA, raceDrainB] = yield* Effect.all(
      [
        drain(5, "claim-race-a", "2026-08-20T16:12:00.000Z"),
        drain(5, "claim-race-b", "2026-08-20T16:12:00.000Z"),
      ],
      { concurrency: "unbounded" },
    );

    const raceDelivery = [...raceDrainA, ...raceDrainB];

    const concurrentDrainClaims = raceDelivery.flatMap((result) =>
      "claim" in result ? [result.claim.claimId] : [],
    );

    if (
      concurrentDrainClaims.length === 0 ||
      new Set(concurrentDrainClaims).size !== concurrentDrainClaims.length
    ) {
      throw new Error("simultaneous Receipt outbox drains reused a claim identity");
    }

    const identicalContext = context(
      "file-proof-concurrent-identical-receipt",
      "FILE-PROOF-3",
      "2026-08-20T16:13:00.000Z",
    );

    const identicalCommand = submitCommand(
      "file-proof-concurrent-identical",
      "Concurrent identical submission",
      identicalFile,
    );

    const identicalCommandResults = yield* Effect.all(
      [
        Effect.exit(
          executeReceiptCommand(
            identicalCommand,
            principal(ownerPersonId, identicalContext.now),
            allocation(identicalContext),
          ),
        ),
        Effect.exit(
          executeReceiptCommand(
            identicalCommand,
            principal(ownerPersonId, identicalContext.now),
            allocation(identicalContext),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const identicalCommandDelivery = yield* drain(
      3,
      "claim-concurrent-identical",
      "2026-08-20T16:14:00.000Z",
    );

    const conflictingContext = context(
      "file-proof-concurrent-conflict-receipt",
      "FILE-PROOF-4",
      "2026-08-20T16:15:00.000Z",
    );

    const conflictingCommandResults = yield* Effect.all(
      [
        Effect.exit(
          executeReceiptCommand(
            submitCommand(
              "file-proof-concurrent-conflict",
              "Concurrent conflicting submission A",
              conflictFile,
            ),
            principal(ownerPersonId, conflictingContext.now),
            allocation(conflictingContext),
          ),
        ),
        Effect.exit(
          executeReceiptCommand(
            submitCommand(
              "file-proof-concurrent-conflict",
              "Concurrent conflicting submission B",
              conflictFile,
            ),
            principal(ownerPersonId, conflictingContext.now),
            allocation(conflictingContext),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const conflictingCommandDelivery = yield* drain(
      3,
      "claim-concurrent-conflict",
      "2026-08-20T16:16:00.000Z",
    );

    const sameCommandAccepted = identicalCommandResults.filter(
      (result) => Predicate.isTagged(result, "Success") && !result.value.replayed,
    ).length;

    const sameCommandReplayed = identicalCommandResults.filter(
      (result) => Predicate.isTagged(result, "Success") && result.value.replayed,
    ).length;

    const conflictingCommandAccepted = conflictingCommandResults.filter(
      (result) => Predicate.isTagged(result, "Success") && !result.value.replayed,
    ).length;

    const conflictingCommandConflicts = conflictingCommandResults.filter((result) =>
      hasFailureTag(result, "DuplicateReceiptCommandConflict"),
    ).length;

    if (sameCommandAccepted !== 1 || sameCommandReplayed !== 1) {
      throw new Error("concurrent identical Receipt commands did not replay exactly once");
    }

    if (conflictingCommandAccepted !== 1 || conflictingCommandConflicts !== 1) {
      throw new Error("concurrent conflicting Receipt commands did not fail exactly once");
    }

    const outboxRows = yield* sql<OutboxStateRow>`
      SELECT status, count(*)::text AS count, sum(attempts)::text AS attempts
      FROM economy_receipt_outbox
      GROUP BY status
      ORDER BY status
    `;

    const snapshot = yield* fileSnapshot;
    const auxiliary = yield* auxiliaryEffectIds;

    const allDeliveries = [
      ...submitDelivery,
      failedDelivery,
      replacementDelivery,
      ...reviseRemainder,
      ...withdrawDelivery,
      ...raceDelivery,
      ...identicalCommandDelivery,
      ...conflictingCommandDelivery,
    ];

    const delivered = allDeliveries.filter((result) =>
      Predicate.isTagged(result, "Delivered"),
    ).length;

    const failed = allDeliveries.filter((result) => Predicate.isTagged(result, "Failed")).length;

    const promoteIndex = snapshot.events.findIndex(
      (event) => event.effectId === "file-proof-revise:PromoteReceiptFile",
    );

    const deleteIndex = snapshot.events.findIndex(
      (event) => event.effectId === "file-proof-revise:DeleteReceiptFile",
    );

    const orderedReplacement = promoteIndex >= 0 && deleteIndex >= 0 && promoteIndex < deleteIndex;

    const currentPreservedOnFailure =
      Predicate.isTagged(failedDelivery, "Failed") &&
      currentAfterFailure.current.length === 1 &&
      currentAfterFailure.current[0]?.objectKey === original.objectKey;

    const replacementReclaimed =
      Predicate.isTagged(failedDelivery, "Failed") &&
      failedDelivery.claim.claimId === "claim-replacement-failure";

    const replacementDelivered =
      Predicate.isTagged(replacementDelivery, "Delivered") &&
      replacementDelivery.claim.claimId === "claim-replacement-retry";

    const duplicateFileEffects =
      snapshot.events.length - new Set(snapshot.events.map((event) => event.effectId)).size;

    const resolutionResults = [approve, reject];

    const acceptedResolutions = resolutionResults.filter((result) =>
      Predicate.isTagged(result, "Success"),
    ).length;

    const rejectedResolutions = resolutionResults.filter((result) =>
      Predicate.isTagged(result, "Failure"),
    ).length;

    if (acceptedResolutions !== 1 || rejectedResolutions !== 1) {
      throw new Error("concurrent Receipt resolves did not produce exactly one winner");
    }

    if (!orderedReplacement || !currentPreservedOnFailure) {
      throw new Error("Receipt replacement file ordering or failure isolation was violated");
    }

    if (!replacementReclaimed || !replacementDelivered) {
      throw new Error("stale Receipt outbox claim was not reclaimed and delivered");
    }

    return {
      specId: "0034",
      sourceRevision: "463d98c88e3ac89cbe6c4de28e449e69eca0a532",
      database: "PostgreSQL",
      providerCalls: 0,
      networkCalls: 0,
      productionCalls: 0,
      accepted: {
        submit: true,
        revise: true,
        withdraw: true,
        staleClaimRecovery: true,
        injectedFailure: true,
        retry: true,
        schemaUpgradeEquivalent: true,
      },
      concurrency: {
        acceptedResolutions: 1,
        rejectedResolutions: 1,
        exclusiveClaims: true,
        concurrentDrains: true,
        concurrentDrainClaims: true,
        sameCommandAccepted,
        sameCommandReplayed,
        conflictingCommandAccepted,
        conflictingCommandConflicts,
      },
      staleRecovery: {
        discoveredClaimIds: staleClaimIds,
        recovered,
        reclaimed: true,
        delivered: true,
      },
      delivery: {
        delivered,
        failed,
        duplicateFileEffects,
        orderedReplacement: true,
        currentPreservedOnFailure: true,
      },
      files: snapshot,
      auxiliaryEffectIds: auxiliary
        .filter((effectId) => !effectId.startsWith("file-proof-race-"))
        .toSorted(),
      outbox: outboxRows.map((row) => ({
        status: row.status,
        count: Number(row.count),
        attempts: Number(row.attempts),
      })),
    };
  });
