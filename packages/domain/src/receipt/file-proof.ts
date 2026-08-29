import { Database } from "../database/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { Cause, Effect } from "effect";
import { ReceiptAuxiliaryEffects } from "./auxiliary-service.js";
import { ReceiptFileService, type ReceiptFileRecordingSnapshot } from "./file-service.js";
import {
  claimNextReceiptOutbox,
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
  type ReceiptOutboxDeliveryResult,
} from "./outbox.js";
import { executeReceiptCommand } from "./postgres.js";
import { ReceiptId, ReceiptVisualId, type ReceiptFile } from "./schema.js";

interface OutboxStateRow {
  readonly status: string;
  readonly count: string;
  readonly attempts: string;
}
interface SchemaDefinitionRow {
  readonly kind: string;
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
  result._tag === "Failure" &&
  result.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      typeof reason.error === "object" &&
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
  import("./errors.js").ReceiptPersistenceError,
  Database | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => deliverNextReceiptOutbox(`${prefix}-${index}`, claimedAt),
  );

export const runReceiptFileProof = (
  fileSnapshot: Effect.Effect<ReceiptFileRecordingSnapshot>,
  failNextFileEffect: (effectId: string) => Effect.Effect<void>,
  auxiliaryEffectIds: Effect.Effect<ReadonlyArray<string>>,
): Effect.Effect<
  ReceiptFileProofEvidence,
  unknown,
  Database | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const files = yield* ReceiptFileService;
    yield* sql.unsafe(`
      TRUNCATE economy_receipt_outbox, economy_receipt_audit,
        economy_receipt_command_receipts, economy_receipts,
        economy_receipt_import_ledger CASCADE
    `);
    yield* sql.unsafe(`
      DELETE FROM economy_receipt_approval_grants
      WHERE approval_grant_id = 'file-proof-approval';
      DELETE FROM economy_payment_authorities
      WHERE payment_authority_id = 'file-proof-payment';
      DELETE FROM organization_memberships
      WHERE membership_id IN ('file-proof-owner-membership', 'file-proof-approver-membership');
      DELETE FROM organization_teams
      WHERE team_id = 'file-proof-team';
      DELETE FROM organization_departments
      WHERE department_id = 'file-proof-department';
      DELETE FROM person_profiles
      WHERE person_id IN ('file-proof-owner', 'file-proof-approver');

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
    const schemaDefinition = () =>
      sql<SchemaDefinitionRow>`
        SELECT 'constraint' AS kind, constraint_row.conname AS name,
          pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (
          'economy_receipts'::regclass,
          'economy_receipt_outbox'::regclass
        )
        UNION ALL
        SELECT 'index' AS kind, index_row.indexname AS name, index_row.indexdef AS definition
        FROM pg_indexes AS index_row
        WHERE index_row.schemaname = current_schema()
          AND index_row.tablename IN ('economy_receipts', 'economy_receipt_outbox')
        ORDER BY kind, name
      `;
    const freshSchema = yield* schemaDefinition();
    yield* sql`
      DELETE FROM vektorprogrammet_schema_migrations
      WHERE migration_id = 4
    `;
    yield* sql.unsafe(`
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
    `);
    yield* sql.migrate;
    const upgradedSchema = yield* schemaDefinition();
    if (JSON.stringify(freshSchema) !== JSON.stringify(upgradedSchema)) {
      throw new Error("fresh and upgraded Receipt schemas differ");
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
      {
        _tag: "RevisePendingReceipt",
        commandId: "file-proof-revise",
        receiptId: "file-proof-receipt",
        expectedRevision: 0,
        description: "Receipt file proof replacement",
        amountOre: 13_000,
        receiptDate: "2026-08-20",
        file: replacement,
      },
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
      {
        _tag: "WithdrawPendingReceipt",
        commandId: "file-proof-withdraw",
        receiptId: "file-proof-receipt",
        expectedRevision: 1,
      },
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
    const [refund, reject] = yield* Effect.all(
      [
        Effect.exit(
          executeReceiptCommand(
            {
              _tag: "RefundReceipt",
              commandId: "file-proof-race-refund",
              receiptId: "file-proof-race-receipt",
              expectedRevision: 0,
            },
            principal(approverPersonId, raceContext.now),
          ),
        ),
        Effect.exit(
          executeReceiptCommand(
            {
              _tag: "RejectReceipt",
              commandId: "file-proof-race-reject",
              receiptId: "file-proof-race-receipt",
              expectedRevision: 0,
            },
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
      result._tag === "Idle" ? [] : [result.claim.claimId],
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
      (result) => result._tag === "Success" && !result.value.replayed,
    ).length;
    const sameCommandReplayed = identicalCommandResults.filter(
      (result) => result._tag === "Success" && result.value.replayed,
    ).length;
    const conflictingCommandAccepted = conflictingCommandResults.filter(
      (result) => result._tag === "Success" && !result.value.replayed,
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
    const delivered = allDeliveries.filter((result) => result._tag === "Delivered").length;
    const failed = allDeliveries.filter((result) => result._tag === "Failed").length;
    const promoteIndex = snapshot.events.findIndex(
      (event) => event.effectId === "file-proof-revise:PromoteReceiptFile",
    );
    const deleteIndex = snapshot.events.findIndex(
      (event) => event.effectId === "file-proof-revise:DeleteReceiptFile",
    );
    const orderedReplacement = promoteIndex >= 0 && deleteIndex >= 0 && promoteIndex < deleteIndex;
    const currentPreservedOnFailure =
      failedDelivery._tag === "Failed" &&
      currentAfterFailure.current.length === 1 &&
      currentAfterFailure.current[0]?.objectKey === original.objectKey;
    const replacementReclaimed =
      failedDelivery._tag === "Failed" &&
      failedDelivery.claim.claimId === "claim-replacement-failure";
    const replacementDelivered =
      replacementDelivery._tag === "Delivered" &&
      replacementDelivery.claim.claimId === "claim-replacement-retry";
    const duplicateFileEffects =
      snapshot.events.length - new Set(snapshot.events.map((event) => event.effectId)).size;
    const resolutionResults = [refund, reject];
    const acceptedResolutions = resolutionResults.filter(
      (result) => result._tag === "Success",
    ).length;
    const rejectedResolutions = resolutionResults.filter(
      (result) => result._tag === "Failure",
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
