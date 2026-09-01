import { Database } from "../database/service.js";
import { Effect } from "effect";
import { ReceiptNotFound, ReceiptPersistenceError } from "./errors.js";
import type { Receipt, ReceiptStatus } from "./schema.js";

export interface ReceiptListItem extends Pick<
  Receipt,
  | "receiptId"
  | "visualId"
  | "ownerPersonId"
  | "departmentId"
  | "description"
  | "currency"
  | "status"
  | "receiptDate"
  | "revision"
> {
  readonly amountOre: string;
}

export interface ReceiptStatusTotal {
  readonly status: ReceiptListItem["status"];
  readonly receiptCount: string;
  readonly amountOre: string;
}

const projectionError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

export const listAssistantReceipts = (
  ownerPersonId: string,
): Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* sql<ReceiptListItem>`
    SELECT receipt_id AS "receiptId", visual_id AS "visualId",
      owner_person_id AS "ownerPersonId", department_id AS "departmentId",
      description, amount_ore::text AS "amountOre", currency,
      status, receipt_date::text AS "receiptDate", revision
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
        status, receipt_date::text AS "receiptDate", revision
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
export interface OwnedReceiptProjectionItem extends ReceiptListItem {
  readonly submittedAt: Receipt["submittedAt"];
}

export const listOwnedReceiptProjection = (
  ownerPersonId: string,
  status?: ReceiptListItem["status"],
): Effect.Effect<ReadonlyArray<OwnedReceiptProjectionItem>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows =
      status === undefined
        ? sql<OwnedReceiptProjectionItem>`
          SELECT receipt_id AS "receiptId", visual_id AS "visualId",
            owner_person_id AS "ownerPersonId", department_id AS "departmentId",
            amount_ore::text AS "amountOre", currency, description,
            receipt_date::text AS "receiptDate",
            to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS "submittedAt",
            status, revision
          FROM economy_receipts
          WHERE owner_person_id = ${ownerPersonId}
          ORDER BY submitted_at DESC, receipt_id ASC
        `
        : sql<OwnedReceiptProjectionItem>`
          SELECT receipt_id AS "receiptId", visual_id AS "visualId",
            owner_person_id AS "ownerPersonId", department_id AS "departmentId",
            amount_ore::text AS "amountOre", currency, description,
            receipt_date::text AS "receiptDate",
            to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS "submittedAt",
            status, revision
          FROM economy_receipts
          WHERE owner_person_id = ${ownerPersonId}
            AND status = ${status}
          ORDER BY submitted_at DESC, receipt_id ASC
        `;
    return yield* rows.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(projectionError("list owned receipt projection", cause)),
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

export interface ReceiptLifecycleOutboxProjection {
  readonly effectId: string;
  readonly effectType: string;
  readonly commandId: string;
  readonly receiptId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly attempts: number;
  readonly lastFailureTag: string | null;
}

export interface ReceiptLifecycleAuditProjection {
  readonly commandId: string;
  readonly receiptId: string;
  readonly action: string;
  readonly receiptRevision: number;
}

export interface ReceiptLifecycleEvidenceProjection {
  readonly receiptId: string;
  readonly file: {
    readonly fileRef: string;
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly outbox: ReadonlyArray<ReceiptLifecycleOutboxProjection>;
  readonly audit: ReadonlyArray<ReceiptLifecycleAuditProjection>;
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
    if (receipt === undefined) {
      return yield* Effect.fail(new ReceiptNotFound({ receiptId }));
    }
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
      outbox,
      audit,
    };
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(projectionError("read Receipt lifecycle evidence", cause)),
    ),
  );
