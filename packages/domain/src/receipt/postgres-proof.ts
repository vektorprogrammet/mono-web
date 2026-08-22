import * as PgClient from "@effect/sql-pg/PgClient";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { importLegacyReceipts, type ReceiptImportProvenance } from "./import.js";
import {
  executeReceiptCommand,
  migrateReceiptPostgres,
  storeReceiptImportResult,
} from "./postgres.js";
import { listApproverReceipts, listAssistantReceipts, receiptStatusTotals } from "./projections.js";
import type { LegacyReceiptRow, ReceiptActor, ReceiptFile } from "./schema.js";

interface CountRow {
  readonly count: string;
}

export interface ReceiptProofEvidence {
  readonly specId: "0033";
  readonly database: "PostgreSQL";
  readonly providerCalls: 0;
  readonly passed: true;
  readonly accepted: {
    readonly submit: boolean;
    readonly refund: boolean;
    readonly revise: boolean;
    readonly withdraw: boolean;
    readonly import: boolean;
  };
  readonly rejected: {
    readonly wrongScope: boolean;
    readonly conflictingReplay: boolean;
    readonly terminalTransition: boolean;
    readonly quarantine: boolean;
    readonly transactionFailure: boolean;
    readonly invalidAmount: boolean;
  };
  readonly replay: {
    readonly exactObservation: boolean;
    readonly duplicateEffects: number;
  };
  readonly durableRows: {
    readonly receipts: number;
    readonly commandReceipts: number;
    readonly outbox: number;
    readonly audit: number;
    readonly importLedger: number;
  };
  readonly projections: {
    readonly assistantReceiptIds: ReadonlyArray<string>;
    readonly approverReceiptIds: ReadonlyArray<string>;
    readonly statusTotals: ReadonlyArray<{
      readonly status: string;
      readonly receiptCount: string;
      readonly amountOre: string;
    }>;
  };
}

const file: ReceiptFile = {
  fileRef: "proof-file-1",
  objectKey: "temporary/proof-file-1",
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "c".repeat(64),
};

const owner: ReceiptActor = {
  personId: "proof-person",
  departmentId: "proof-department",
  active: true,
  approvalScope: { _tag: "None" },
};

const approver: ReceiptActor = {
  personId: "proof-approver",
  departmentId: "proof-department",
  active: true,
  approvalScope: { _tag: "Department", departmentId: "proof-department" },
};

const context = (receiptId: string, visualId: string, now: string) => ({
  receiptId,
  visualId,
  now,
});

const submit = (commandId: string, description: string) => ({
  _tag: "SubmitReceipt" as const,
  commandId,
  actor: owner,
  departmentId: "proof-department",
  paymentAccountCiphertext: "ciphertext:v1:proof-account",
  description,
  amountOre: 12_345,
  receiptDate: "2026-08-19",
  file,
});

const count = (sql: PgClient.PgClient, table: string) =>
  sql
    .unsafe<CountRow>(`SELECT count(*)::text AS count FROM ${table}`)
    .pipe(Effect.map((rows) => Number(rows[0]?.count ?? "0")));

export const runReceiptPostgresProof = (
  migrationSql: string,
): Effect.Effect<ReceiptProofEvidence, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* migrateReceiptPostgres(migrationSql);
    yield* sql.unsafe(`
      TRUNCATE economy_receipt_outbox, economy_receipt_audit,
        economy_receipt_command_receipts, economy_receipts,
        economy_receipt_import_ledger CASCADE
    `);

    const firstContext = context("proof-receipt-1", "PROOF-0001", "2026-08-20T12:00:00.000Z");
    const submitted = yield* executeReceiptCommand(
      submit("proof-command-submit-1", "Travel"),
      firstContext,
    );
    const replay = yield* executeReceiptCommand(
      submit("proof-command-submit-1", "Travel"),
      firstContext,
    );
    const conflictingReplay = yield* Effect.exit(
      executeReceiptCommand(submit("proof-command-submit-1", "Changed travel"), firstContext),
    );
    const wrongScope = yield* Effect.exit(
      executeReceiptCommand(
        {
          _tag: "RefundReceipt",
          commandId: "proof-command-wrong-scope",
          actor: {
            ...approver,
            departmentId: "other-department",
            approvalScope: {
              _tag: "Department",
              departmentId: "other-department",
            },
          },
          receiptId: "proof-receipt-1",
          expectedRevision: 0,
        },
        { ...firstContext, now: "2026-08-20T12:01:00.000Z" },
      ),
    );
    const refunded = yield* executeReceiptCommand(
      {
        _tag: "RefundReceipt",
        commandId: "proof-command-refund",
        actor: approver,
        receiptId: "proof-receipt-1",
        expectedRevision: 0,
      },
      { ...firstContext, now: "2026-08-20T12:02:00.000Z" },
    );
    const terminalTransition = yield* Effect.exit(
      executeReceiptCommand(
        {
          _tag: "RejectReceipt",
          commandId: "proof-command-terminal",
          actor: approver,
          receiptId: "proof-receipt-1",
          expectedRevision: 1,
        },
        { ...firstContext, now: "2026-08-20T12:03:00.000Z" },
      ),
    );

    const secondContext = context("proof-receipt-2", "PROOF-0002", "2026-08-20T13:00:00.000Z");
    yield* executeReceiptCommand(submit("proof-command-submit-2", "Supplies"), secondContext);
    const revised = yield* executeReceiptCommand(
      {
        _tag: "RevisePendingReceipt",
        commandId: "proof-command-revise",
        actor: owner,
        receiptId: "proof-receipt-2",
        expectedRevision: 0,
        description: "Supplies and postage",
        amountOre: 13_000,
        receiptDate: "2026-08-19",
        file,
      },
      { ...secondContext, now: "2026-08-20T13:01:00.000Z" },
    );
    const withdrawn = yield* executeReceiptCommand(
      {
        _tag: "WithdrawPendingReceipt",
        commandId: "proof-command-withdraw",
        actor: owner,
        receiptId: "proof-receipt-2",
        expectedRevision: 1,
      },
      { ...secondContext, now: "2026-08-20T13:02:00.000Z" },
    );

    yield* sql.unsafe(`
      CREATE OR REPLACE FUNCTION reject_receipt_proof_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.command_id = 'proof-command-rollback' THEN
          RAISE EXCEPTION 'receipt proof rollback injection';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receipt_proof_audit_failure
        BEFORE INSERT ON economy_receipt_audit
        FOR EACH ROW EXECUTE FUNCTION reject_receipt_proof_audit();
    `);
    const failedTransaction = yield* Effect.exit(
      executeReceiptCommand(
        submit("proof-command-rollback", "Rollback after durable writes"),
        context("proof-receipt-3", "PROOF-0003", "2026-08-20T14:00:00.000Z"),
      ),
    );
    yield* sql.unsafe(`
      DROP TRIGGER receipt_proof_audit_failure ON economy_receipt_audit;
      DROP FUNCTION reject_receipt_proof_audit();
    `);

    const provenance = (
      row: LegacyReceiptRow,
      destinationIdentity: string,
    ): ReceiptImportProvenance => ({
      sourceRepository: "legacy",
      sourceRevision: "d05c261",
      snapshotId: "proof-snapshot",
      sourceWatermark: "binlog:100",
      transformationRevision: "receipt-import-v1",
      sourceDigest: sha256Hex(canonicalJsonBytes(row)),
      destinationIdentity,
    });
    const legacy: LegacyReceiptRow = {
      sourcePrimaryKey: "legacy-1",
      ownerPersonId: "proof-person",
      departmentId: "proof-department",
      visualId: "LEGACY-PROOF-1",
      amountDecimal: "123.45",
      description: "Imported travel",
      receiptDate: "2026-08-19",
      submittedAt: "2026-08-20T10:00:00.000Z",
      status: "pending",
      refundDate: null,
      paymentAccountCiphertext: "ciphertext:v1:legacy-proof",
      file,
    };
    const invalidLegacy = { ...legacy, sourcePrimaryKey: "legacy-2", amountDecimal: "1.234" };
    const [imported, quarantined] = importLegacyReceipts([
      {
        row: legacy,
        receiptId: "proof-import-1",
        provenance: provenance(legacy, "proof-import-1"),
      },
      {
        row: invalidLegacy,
        receiptId: "proof-import-2",
        provenance: provenance(invalidLegacy, "proof-import-2"),
      },
    ]);
    yield* storeReceiptImportResult(imported!);
    yield* storeReceiptImportResult(quarantined!);

    const invalidAmount = yield* Effect.exit(
      executeReceiptCommand(
        { ...submit("proof-command-invalid-amount", "Invalid amount"), amountOre: 0 },
        context("proof-invalid-amount", "PROOF-INVALID", "2026-08-20T15:00:00.000Z"),
      ),
    );
    const assistantProjection = yield* listAssistantReceipts(owner.personId);
    const approverProjection = yield* listApproverReceipts({
      _tag: "Department",
      departmentId: "proof-department",
    });
    const totals = yield* receiptStatusTotals;

    const [receipts, commandReceipts, outbox, audit, importLedger, rolledBack] = yield* Effect.all([
      count(sql, "economy_receipts"),
      count(sql, "economy_receipt_command_receipts"),
      count(sql, "economy_receipt_outbox"),
      count(sql, "economy_receipt_audit"),
      count(sql, "economy_receipt_import_ledger"),
      sql<{ readonly count: string }>`
          SELECT count(*)::text AS count FROM economy_receipts
          WHERE receipt_id = 'proof-receipt-3'
        `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? "0"))),
    ]);

    const evidence: ReceiptProofEvidence = {
      specId: "0033",
      database: "PostgreSQL",
      providerCalls: 0,
      passed: true,
      accepted: {
        submit: submitted.observation.status === "Pending",
        refund: refunded.observation.status === "Refunded",
        revise: revised.observation.revision === 1,
        withdraw: withdrawn.observation.status === "Withdrawn",
        import: imported?._tag === "AcceptedReceiptImport",
      },
      rejected: {
        wrongScope: wrongScope._tag === "Failure",
        conflictingReplay: conflictingReplay._tag === "Failure",
        terminalTransition: terminalTransition._tag === "Failure",
        quarantine: quarantined?._tag === "QuarantinedReceiptImport",
        transactionFailure: failedTransaction._tag === "Failure" && rolledBack === 0,
        invalidAmount: invalidAmount._tag === "Failure",
      },
      replay: {
        exactObservation:
          replay.replayed &&
          replay.observation.receiptId === submitted.observation.receiptId &&
          replay.observation.revision === submitted.observation.revision,
        duplicateEffects: replay.outboxCount,
      },
      durableRows: { receipts, commandReceipts, outbox, audit, importLedger },
      projections: {
        assistantReceiptIds: assistantProjection.map(({ receiptId }) => receiptId),
        approverReceiptIds: approverProjection.map(({ receiptId }) => receiptId),
        statusTotals: totals,
      },
    };
    assert.deepEqual(evidence.accepted, {
      submit: true,
      refund: true,
      revise: true,
      withdraw: true,
      import: true,
    });
    assert.deepEqual(evidence.rejected, {
      wrongScope: true,
      conflictingReplay: true,
      terminalTransition: true,
      quarantine: true,
      transactionFailure: true,
      invalidAmount: true,
    });
    assert.deepEqual(evidence.replay, { exactObservation: true, duplicateEffects: 0 });
    assert.deepEqual(evidence.durableRows, {
      receipts: 2,
      commandReceipts: 5,
      outbox: 11,
      audit: 5,
      importLedger: 2,
    });
    assert.deepEqual(evidence.projections.assistantReceiptIds, [
      "proof-receipt-2",
      "proof-receipt-1",
    ]);
    assert.deepEqual(evidence.projections.approverReceiptIds, [
      "proof-receipt-2",
      "proof-receipt-1",
    ]);
    return evidence;
  });

export const renderReceiptProofEvidence = (evidence: ReceiptProofEvidence): string =>
  `${canonicalJson(evidence)}\n`;
