import { Database, type DatabaseOperations } from "../service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import assert from "node:assert/strict";
import { Predicate, Effect } from "effect";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  RECEIPT_PAGE_SIZE,
  type ReceiptCursorPosition,
  ReceiptId,
  ReceiptCommandRequestSchema,
  importLegacyReceipts,
  type ReceiptImportProvenance,
} from "@vektorprogrammet/domain/receipt";
import { executeReceiptCommand, storeReceiptImportResult } from "./postgres.js";
import {
  listApproverReceipts,
  listOwnedReceiptProjection,
  receiptStatusTotals,
} from "./projections.js";
import {
  ReceiptVisualId,
  type LegacyReceiptRow,
  type ReceiptFile,
} from "@vektorprogrammet/domain/receipt";

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
    readonly approve: boolean;
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

const secondFile: ReceiptFile = {
  fileRef: "proof-file-2",
  objectKey: "temporary/proof-file-2",
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "f".repeat(64),
};

const rollbackFile: ReceiptFile = {
  fileRef: "proof-file-rollback",
  objectKey: "temporary/proof-file-rollback",
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "b".repeat(64),
};

const legacyFile: ReceiptFile = {
  fileRef: "proof-file-legacy",
  objectKey: "temporary/proof-file-legacy",
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "d".repeat(64),
};

const ownerPersonId = PersonId.make("proof-person");

const approverPersonId = PersonId.make("proof-approver");

const wrongScopeApproverPersonId = PersonId.make("proof-wrong-scope-approver");

interface ProofCommandContext {
  readonly receiptId: string;
  readonly visualId: string;
  readonly now: string;
}

const context = (receiptId: string, visualId: string, now: string): ProofCommandContext => ({
  receiptId,
  visualId,
  now,
});

const principal = (personId: PersonId, authorizationInstant: string) => ({
  personId,
  authorizationInstant,
});

const allocation = (value: ProofCommandContext) => ({
  receiptId: ReceiptId.make(value.receiptId),
  visualId: ReceiptVisualId.make(value.visualId),
});

const submit = (commandId: string, description: string, receiptFile = file) => ({
  _tag: "SubmitReceipt" as const,
  commandId,
  departmentId: DepartmentId.make("proof-department"),
  description,
  amountOre: 12_345,
  receiptDate: "2026-08-19",
  file: receiptFile,
});

const count = (sql: DatabaseOperations, table: string) =>
  sql
    .unsafe<CountRow>(`SELECT count(*)::text AS count FROM ${table}`)
    .pipe(Effect.map((rows) => Number(rows[0]?.count ?? "0")));

export const runReceiptPostgresProof = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql.unsafe(`
      INSERT INTO person_profiles (person_id, first_name, last_name) VALUES
        ('proof-person', 'Receipt', 'Owner'),
        ('proof-approver', 'Receipt', 'Approver'),
        ('proof-wrong-scope-approver', 'Other', 'Approver');
      INSERT INTO organization_departments (
        department_id, name, short_name, email, city
      ) VALUES
        ('proof-department', 'Proof Department', 'PROOF',
          'proof@example.invalid', 'Bergen'),
        ('other-department', 'Other Department', 'OTHER',
          'other@example.invalid', 'Bergen');
      INSERT INTO organization_teams (team_id, department_id, name) VALUES
        ('proof-team', 'proof-department', 'Proof Team'),
        ('proof-other-team', 'other-department', 'Other Team');
      INSERT INTO organization_memberships (
        membership_id, person_id, team_id, start_at
      ) VALUES
        ('proof-owner-membership', 'proof-person', 'proof-team',
          '2026-01-01T00:00:00.000Z'),
        ('proof-approver-membership', 'proof-approver', 'proof-team',
          '2026-01-01T00:00:00.000Z'),
        ('proof-wrong-approver-membership', 'proof-wrong-scope-approver',
          'proof-other-team', '2026-01-01T00:00:00.000Z');
      INSERT INTO economy_payment_authorities (
        payment_authority_id, person_id, department_id,
        payment_account_ciphertext, start_at
      ) VALUES (
        'proof-payment', 'proof-person', 'proof-department',
        'ciphertext:v1:proof-account', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO economy_receipt_approval_grants (
        approval_grant_id, person_id, scope, department_id, start_at
      ) VALUES
        ('proof-approval', 'proof-approver', 'Department', 'proof-department',
          '2026-01-01T00:00:00.000Z'),
        ('proof-wrong-approval', 'proof-wrong-scope-approver', 'Department',
          'other-department', '2026-01-01T00:00:00.000Z');
    `);

  const firstContext = context("proof-receipt-1", "PROOF-0001", "2026-08-20T12:00:00.000Z");

  const submitted = yield* executeReceiptCommand(
    submit("proof-command-submit-1", "Travel"),
    principal(ownerPersonId, firstContext.now),
    allocation(firstContext),
  );

  const replay = yield* executeReceiptCommand(
    submit("proof-command-submit-1", "Travel"),
    principal(ownerPersonId, firstContext.now),
    allocation(firstContext),
  );

  const conflictingReplay = yield* Effect.exit(
    executeReceiptCommand(
      submit("proof-command-submit-1", "Changed travel"),
      principal(ownerPersonId, firstContext.now),
      allocation(firstContext),
    ),
  );

  const wrongScope = yield* Effect.exit(
    executeReceiptCommand(
      ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
        commandId: "proof-command-wrong-scope",
        receiptId: ReceiptId.make("proof-receipt-1"),
        expectedRevision: 0,
      }),
      principal(wrongScopeApproverPersonId, "2026-08-20T12:01:00.000Z"),
    ),
  );

  const approved = yield* executeReceiptCommand(
    ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
      commandId: "proof-command-approve",
      receiptId: ReceiptId.make("proof-receipt-1"),
      expectedRevision: 0,
    }),
    principal(approverPersonId, "2026-08-20T12:02:00.000Z"),
  );

  const terminalTransition = yield* Effect.exit(
    executeReceiptCommand(
      ReceiptCommandRequestSchema.cases.RejectReceipt.make({
        commandId: "proof-command-terminal",
        receiptId: ReceiptId.make("proof-receipt-1"),
        expectedRevision: 1,
      }),
      principal(approverPersonId, "2026-08-20T12:03:00.000Z"),
    ),
  );

  const secondContext = context("proof-receipt-2", "PROOF-0002", "2026-08-20T13:00:00.000Z");
  yield* executeReceiptCommand(
    submit("proof-command-submit-2", "Supplies", secondFile),
    principal(ownerPersonId, secondContext.now),
    allocation(secondContext),
  );

  const revised = yield* executeReceiptCommand(
    ReceiptCommandRequestSchema.cases.RevisePendingReceipt.make({
      commandId: "proof-command-revise",
      receiptId: ReceiptId.make("proof-receipt-2"),
      expectedRevision: 0,
      description: "Supplies and postage",
      amountOre: 13_000,
      receiptDate: "2026-08-19",
      file: secondFile,
    }),
    principal(ownerPersonId, "2026-08-20T13:01:00.000Z"),
  );

  const withdrawn = yield* executeReceiptCommand(
    ReceiptCommandRequestSchema.cases.WithdrawPendingReceipt.make({
      commandId: "proof-command-withdraw",
      receiptId: ReceiptId.make("proof-receipt-2"),
      expectedRevision: 1,
    }),
    principal(ownerPersonId, "2026-08-20T13:02:00.000Z"),
  );

  yield* sql.unsafe(`
    CREATE FUNCTION reject_receipt_proof_audit() RETURNS trigger AS $$
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
  const rollbackContext = context("proof-receipt-3", "PROOF-0003", "2026-08-20T14:00:00.000Z");

  const failedTransaction = yield* Effect.exit(
    executeReceiptCommand(
      submit("proof-command-rollback", "Rollback after durable writes", rollbackFile),
      principal(ownerPersonId, rollbackContext.now),
      allocation(rollbackContext),
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
    ownerPersonId: PersonId.make("proof-person"),
    departmentId: DepartmentId.make("proof-department"),
    visualId: "LEGACY-PROOF-1",
    amountDecimal: "123.45",
    description: "Imported travel",
    receiptDate: "2026-08-19",
    submittedAt: "2026-08-20T10:00:00.000Z",
    status: "pending",
    refundDate: null,
    paymentAccountCiphertext: "ciphertext:v1:legacy-proof",
    file: legacyFile,
  };

  const invalidLegacy = {
    ...legacy,
    sourcePrimaryKey: "legacy-2",
    visualId: "LEGACY-PROOF-2",
    amountDecimal: "1.234",
  };

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

  const invalidContext = context(
    "proof-invalid-amount",
    "PROOF-INVALID",
    "2026-08-20T15:00:00.000Z",
  );

  const invalidAmount = yield* Effect.exit(
    executeReceiptCommand(
      { ...submit("proof-command-invalid-amount", "Invalid amount"), amountOre: 0 },
      principal(ownerPersonId, invalidContext.now),
      allocation(invalidContext),
    ),
  );

  const assistantReceiptIds: string[] = [];
  let ownerCursor: string | undefined;

  do {
    const page = yield* listOwnedReceiptProjection(ownerPersonId, undefined, ownerCursor);

    for (const row of page.items) assistantReceiptIds.push(row.receiptId);
    ownerCursor = page.nextCursor;
  } while (ownerCursor !== undefined);

  const approverReceiptIds: string[] = [];
  let position: ReceiptCursorPosition | undefined;

  while (true) {
    const rows = yield* listApproverReceipts(undefined, position);

    for (const row of rows) approverReceiptIds.push(row.receiptId);

    if (rows.length <= RECEIPT_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    position = { timestamp: last.cursorTimestamp, receiptId: last.receiptId };
  }

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
      approve: approved.observation.status === "Approved",
      revise: revised.observation.revision === 1,
      withdraw: withdrawn.observation.status === "Withdrawn",
      import: Predicate.isTagged(imported, "AcceptedReceiptImport"),
    },
    rejected: {
      wrongScope: Predicate.isTagged(wrongScope, "Failure"),
      conflictingReplay: Predicate.isTagged(conflictingReplay, "Failure"),
      terminalTransition: Predicate.isTagged(terminalTransition, "Failure"),
      quarantine: Predicate.isTagged(quarantined, "QuarantinedReceiptImport"),
      transactionFailure: Predicate.isTagged(failedTransaction, "Failure") && rolledBack === 0,
      invalidAmount: Predicate.isTagged(invalidAmount, "Failure"),
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
      assistantReceiptIds,
      approverReceiptIds,
      statusTotals: totals,
    },
  };

  assert.deepEqual(evidence.accepted, {
    submit: true,
    approve: true,
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
    receipts: 3,
    commandReceipts: 5,
    outbox: 11,
    audit: 5,
    importLedger: 2,
  });
  assert.deepEqual(evidence.projections.assistantReceiptIds, [
    "proof-receipt-2",
    "proof-receipt-1",
    "proof-import-1",
  ]);
  assert.deepEqual(evidence.projections.approverReceiptIds, [
    "proof-receipt-2",
    "proof-receipt-1",
    "proof-import-1",
  ]);
  assert.deepEqual(evidence.projections.statusTotals, [
    { status: "Approved", receiptCount: "1", amountOre: "12345" },
    { status: "Pending", receiptCount: "1", amountOre: "12345" },
    { status: "Withdrawn", receiptCount: "1", amountOre: "13000" },
  ]);

  return evidence;
});
