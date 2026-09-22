import { Database, type DatabaseShape } from "../service.js";
import { Effect, Schema } from "effect";
import {
  ReceiptNotFound,
  ReceiptPersistenceError,
  ReceiptSettlementEvidenceSelectSchema,
  type ReceiptSettlementEvidence,
} from "@vektorprogrammet/domain/receipt";
import type {
  OwnedReceiptProjectionItem,
  ReceiptLifecycleAuditProjection,
  ReceiptLifecycleEvidenceProjection,
  ReceiptLifecycleOutboxProjection,
  ReceiptListItem,
  ReceiptStatus,
  ReceiptStatusTotal,
} from "@vektorprogrammet/domain/receipt";

const projectionError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

const decodeSettlementEvidence = (
  row: unknown,
): Effect.Effect<ReceiptSettlementEvidence, ReceiptPersistenceError> =>
  Schema.decodeUnknownEffect(ReceiptSettlementEvidenceSelectSchema)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => projectionError("decode Receipt settlement evidence", cause)));
const selectSettlementEvidence = (
  sql: DatabaseShape,
  receiptId: string,
): Effect.Effect<ReceiptSettlementEvidence | undefined, ReceiptPersistenceError> =>
  sql<Record<string, unknown>>`
    SELECT
      settlement_id AS "settlementId",
      receipt_id AS "receiptId",
      amount_ore::text AS "amountOre",
      currency,
      payment_destination_fingerprint AS "paymentDestinationFingerprint",
      external_authority AS "externalAuthority",
      external_reference AS "externalReference",
      to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
      recorded_by_person_id AS "recordedByPersonId",
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
      receipt_revision AS "receiptRevision"
    FROM public.economy_receipt_settlements
    WHERE receipt_id = ${receiptId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeSettlementEvidence(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(projectionError("read Receipt settlement evidence", cause)),
    ),
  );

export const listAssistantReceipts = (
  ownerPersonId: string,
): Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* sql<ReceiptListItem>`
    SELECT receipt_id AS "receiptId", visual_id AS "visualId",
      owner_person_id AS "ownerPersonId", department_id AS "departmentId",
      description, amount_ore::text AS "amountOre", currency,
      status, receipt_date::text AS "receiptDate",
      CASE WHEN approved_at IS NULL THEN NULL
        ELSE to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "approvedAt",
      revision
    FROM economy_receipts
    WHERE owner_person_id = ${ownerPersonId}
    ORDER BY submitted_at DESC, receipt_id ASC
  `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(projectionError("list assistant receipts", cause)),
      ),
    );
  });

export const listApproverReceipts = (
  status?: ReceiptStatus,
): Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const statusPredicate = status === undefined ? sql`TRUE` : sql`status = ${status}`;
    return yield* sql<ReceiptListItem>`
      SELECT receipt_id AS "receiptId", visual_id AS "visualId",
        owner_person_id AS "ownerPersonId", department_id AS "departmentId",
        description, amount_ore::text AS "amountOre", currency,
        status, receipt_date::text AS "receiptDate",
        CASE WHEN approved_at IS NULL THEN NULL
          ELSE to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "approvedAt",
        revision
      FROM economy_receipts
      WHERE ${statusPredicate}
      ORDER BY submitted_at DESC, receipt_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(projectionError("list approver receipts", cause)),
      ),
    );
  });

export const receiptStatusTotals: Effect.Effect<
  ReadonlyArray<ReceiptStatusTotal>,
  ReceiptPersistenceError,
  Database
> = Effect.gen(function* () {
  const sql = yield* Database;
  return yield* sql<ReceiptStatusTotal>`
    SELECT status, count(*)::text AS "receiptCount", coalesce(sum(amount_ore), 0)::text AS "amountOre"
    FROM economy_receipts
    GROUP BY status
    ORDER BY status ASC
  `.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(projectionError("read receipt status totals", cause)),
    ),
  );
});

interface OwnedReceiptProjectionRow extends Omit<OwnedReceiptProjectionItem, "settlement"> {
  readonly settlement: unknown | null;
}

export const listOwnedReceiptProjection = (
  ownerPersonId: string,
  status?: ReceiptListItem["status"],
): Effect.Effect<ReadonlyArray<OwnedReceiptProjectionItem>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const statusPredicate = status === undefined ? sql`TRUE` : sql`receipt.status = ${status}`;
    const rows = yield* sql<OwnedReceiptProjectionRow>`
      SELECT
        receipt.receipt_id AS "receiptId",
        receipt.visual_id AS "visualId",
        receipt.owner_person_id AS "ownerPersonId",
        receipt.department_id AS "departmentId",
        receipt.amount_ore::text AS "amountOre",
        receipt.currency,
        receipt.description,
        receipt.receipt_date::text AS "receiptDate",
        to_char(receipt.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AS "submittedAt",
        receipt.status,
        CASE WHEN receipt.approved_at IS NULL THEN NULL
          ELSE to_char(receipt.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "approvedAt",
        receipt.revision,
        CASE WHEN settlement.settlement_id IS NULL THEN NULL ELSE json_build_object(
          'settlementId', settlement.settlement_id,
          'receiptId', settlement.receipt_id,
          'amountOre', settlement.amount_ore::text,
          'currency', settlement.currency,
          'paymentDestinationFingerprint', settlement.payment_destination_fingerprint,
          'externalAuthority', settlement.external_authority,
          'externalReference', settlement.external_reference,
          'settledAt', to_char(settlement.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'recordedByPersonId', settlement.recorded_by_person_id,
          'recordedAt', to_char(settlement.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'receiptRevision', settlement.receipt_revision
        ) END AS settlement
      FROM economy_receipts AS receipt
      LEFT JOIN public.economy_receipt_settlements AS settlement
        ON settlement.receipt_id = receipt.receipt_id
      WHERE receipt.owner_person_id = ${ownerPersonId}
        AND ${statusPredicate}
      ORDER BY receipt.submitted_at DESC, receipt.receipt_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(projectionError("list owned receipt projection", cause)),
      ),
    );
    return yield* Effect.forEach(
      rows,
      (row): Effect.Effect<OwnedReceiptProjectionItem, ReceiptPersistenceError> =>
        row.settlement === null
          ? Effect.succeed({ ...row, settlement: null })
          : decodeSettlementEvidence(row.settlement).pipe(
              Effect.map((settlement) => ({ ...row, settlement })),
            ),
    );
  });

export interface ReceiptLifecycleFileProjection {
  readonly fileRef: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteLength: string;
  readonly sha256: string;
}

export const readReceiptLifecycleEvidence = (
  receiptId: string,
  ownerPersonId: string,
): Effect.Effect<
  ReceiptLifecycleEvidenceProjection,
  ReceiptPersistenceError | ReceiptNotFound,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const receipts = yield* sql<ReceiptLifecycleFileProjection>`
      SELECT file_ref AS "fileRef", file_object_key AS "objectKey",
        file_content_type AS "contentType", file_byte_length::text AS "byteLength",
        file_sha256 AS "sha256"
      FROM economy_receipts
      WHERE receipt_id = ${receiptId} AND owner_person_id = ${ownerPersonId}
    `;
    const receipt = receipts[0];
    if (receipt === undefined) return yield* Effect.fail(new ReceiptNotFound({ receiptId }));
    const settlement = yield* selectSettlementEvidence(sql, receiptId);
    const outbox = yield* sql<ReceiptLifecycleOutboxProjection>`
      SELECT effect_id AS "effectId", effect_type AS "effectType",
        command_id AS "commandId", receipt_id AS "receiptId", ordinal, status, attempts,
        last_failure_tag AS "lastFailureTag"
      FROM economy_receipt_outbox
      WHERE receipt_id = ${receiptId}
      ORDER BY command_id, ordinal
    `;
    const audit = yield* sql<ReceiptLifecycleAuditProjection>`
      SELECT command_id AS "commandId", receipt_id AS "receiptId",
        action, receipt_revision AS "receiptRevision"
      FROM economy_receipt_audit
      WHERE receipt_id = ${receiptId}
      ORDER BY occurred_at, command_id
    `;
    return {
      receiptId,
      file: {
        fileRef: receipt.fileRef,
        objectKey: receipt.objectKey,
        contentType: receipt.contentType,
        byteLength: Number(receipt.byteLength),
        sha256: receipt.sha256,
      },
      settlement: settlement ?? null,
      outbox,
      audit,
    };
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(projectionError("read Receipt lifecycle evidence", cause)),
    ),
  );
