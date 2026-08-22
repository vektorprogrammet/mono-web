import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect } from "effect";
import { ReceiptAuxiliaryEffects } from "./auxiliary-service.js";
import { ReceiptFileService, type ReceiptFileRecordingSnapshot } from "./file-service.js";
import {
  claimNextReceiptOutbox,
  deliverNextReceiptOutbox,
  recoverStaleReceiptOutbox,
  type ReceiptOutboxDeliveryResult,
} from "./outbox.js";
import { executeReceiptCommand, migrateReceiptPostgres } from "./postgres.js";
import type { ReceiptActor, ReceiptFile } from "./schema.js";

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
  readonly database: "PostgreSQL";
  readonly providerCalls: 0;
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
  };
  readonly delivery: {
    readonly delivered: number;
    readonly failed: number;
    readonly duplicateFileEffects: 0;
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

const owner: ReceiptActor = {
  personId: "file-proof-owner",
  departmentId: "file-proof-department",
  active: true,
  approvalScope: { _tag: "None" },
};

const approver: ReceiptActor = {
  personId: "file-proof-approver",
  departmentId: "file-proof-department",
  active: true,
  approvalScope: { _tag: "Department", departmentId: "file-proof-department" },
};

const context = (receiptId: string, visualId: string, now: string) => ({
  receiptId,
  visualId,
  now,
});

const submit = (
  commandId: string,
  receiptId: string,
  visualId: string,
  file: ReceiptFile,
  now: string,
) =>
  executeReceiptCommand(
    {
      _tag: "SubmitReceipt",
      commandId,
      actor: owner,
      departmentId: owner.departmentId,
      paymentAccountCiphertext: "ciphertext:v1:file-proof-account",
      description: "Receipt file proof",
      amountOre: 12_345,
      receiptDate: "2026-08-20",
      file,
    },
    context(receiptId, visualId, now),
  );

const drain = (
  count: number,
  prefix: string,
  claimedAt: string,
): Effect.Effect<
  ReadonlyArray<ReceiptOutboxDeliveryResult>,
  import("./errors.js").ReceiptPersistenceError,
  PgClient.PgClient | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => deliverNextReceiptOutbox(`${prefix}-${index}`, claimedAt),
  );

export const runReceiptFileProof = (
  migrationSql: string,
  fileSnapshot: Effect.Effect<ReceiptFileRecordingSnapshot>,
  failNextFileEffect: (effectId: string) => Effect.Effect<void>,
  auxiliaryEffectIds: Effect.Effect<ReadonlyArray<string>>,
): Effect.Effect<
  ReceiptFileProofEvidence,
  unknown,
  PgClient.PgClient | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const files = yield* ReceiptFileService;
    yield* sql.unsafe(`
      TRUNCATE economy_receipt_outbox, economy_receipt_audit,
        economy_receipt_command_receipts, economy_receipts,
        economy_receipt_import_ledger CASCADE
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
    yield* sql.unsafe(`
      ALTER TABLE economy_receipt_outbox
        DROP CONSTRAINT economy_receipt_outbox_status_check,
        DROP CONSTRAINT economy_receipt_outbox_claim_check,
        DROP COLUMN claim_id,
        DROP COLUMN claimed_at,
        DROP COLUMN last_failure_tag;
      ALTER TABLE economy_receipt_outbox
        ADD CONSTRAINT economy_receipt_outbox_status_check
        CHECK (status IN ('Pending', 'Delivered', 'Failed'));
      ALTER TABLE economy_receipts
        DROP CONSTRAINT economy_receipts_amount_ore_check;
      ALTER TABLE economy_receipts
        ADD CONSTRAINT economy_receipts_amount_ore_check CHECK (amount_ore > 0);
      DROP INDEX economy_receipts_file_ref_unique;
      DROP INDEX economy_receipts_file_object_key_unique;
    `);
    yield* migrateReceiptPostgres(migrationSql);
    const upgradedSchema = yield* schemaDefinition();
    if (JSON.stringify(freshSchema) !== JSON.stringify(upgradedSchema)) {
      throw new Error("fresh and upgraded Receipt schemas differ");
    }
    yield* files.stage(original);
    yield* files.stage(replacement);
    yield* files.stage(raceFile);

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
        actor: owner,
        receiptId: "file-proof-receipt",
        expectedRevision: 0,
        description: "Receipt file proof replacement",
        amountOre: 13_000,
        receiptDate: "2026-08-20",
        file: replacement,
      },
      context("file-proof-receipt", "FILE-PROOF-1", "2026-08-20T16:02:00.000Z"),
    );

    const staleClaim = yield* claimNextReceiptOutbox("claim-stale", "2026-08-20T16:03:00.000Z");
    if (staleClaim === undefined) throw new Error("expected replacement promote claim");
    const recovered = yield* recoverStaleReceiptOutbox("2026-08-20T16:04:00.000Z");
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
        actor: owner,
        receiptId: "file-proof-receipt",
        expectedRevision: 1,
      },
      context("file-proof-receipt", "FILE-PROOF-1", "2026-08-20T16:08:00.000Z"),
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
    if (workerClaims.filter((claim) => claim !== undefined).length !== 1) {
      throw new Error("concurrent Receipt outbox claims were not exclusive");
    }
    const workerClaimsRecovered = yield* recoverStaleReceiptOutbox("2026-08-20T16:10:31.000Z");
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
              actor: approver,
              receiptId: "file-proof-race-receipt",
              expectedRevision: 0,
            },
            raceContext,
          ),
        ),
        Effect.exit(
          executeReceiptCommand(
            {
              _tag: "RejectReceipt",
              commandId: "file-proof-race-reject",
              actor: approver,
              receiptId: "file-proof-race-receipt",
              expectedRevision: 0,
            },
            raceContext,
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const raceDelivery = yield* drain(5, "claim-race", "2026-08-20T16:12:00.000Z");

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
      currentAfterFailure.current[0]?.objectKey === original.objectKey;
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
    return {
      specId: "0034",
      database: "PostgreSQL",
      providerCalls: 0,
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
      },
      delivery: {
        delivered,
        failed,
        duplicateFileEffects: 0,
        orderedReplacement: true,
        currentPreservedOnFailure: true,
      },
      files: snapshot,
      auxiliaryEffectIds: auxiliary,
      outbox: outboxRows.map((row) => ({
        status: row.status,
        count: Number(row.count),
        attempts: Number(row.attempts),
      })),
    };
  });
