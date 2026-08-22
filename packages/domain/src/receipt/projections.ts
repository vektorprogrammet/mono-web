import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect } from "effect";
import { ReceiptPersistenceError } from "./errors.js";

export interface ReceiptListItem {
  readonly receiptId: string;
  readonly visualId: string;
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly amountOre: string;
  readonly status: "Pending" | "Refunded" | "Rejected" | "Withdrawn";
  readonly receiptDate: string;
  readonly revision: number;
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
): Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<ReceiptListItem>`
      SELECT receipt_id AS "receiptId", visual_id AS "visualId",
        owner_person_id AS "ownerPersonId", department_id AS "departmentId",
        amount_ore::text AS "amountOre", status, receipt_date::text AS "receiptDate", revision
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
  scope:
    | { readonly _tag: "Department"; readonly departmentId: string }
    | { readonly _tag: "Global" },
): Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows =
      scope._tag === "Global"
        ? sql<ReceiptListItem>`
            SELECT receipt_id AS "receiptId", visual_id AS "visualId",
              owner_person_id AS "ownerPersonId", department_id AS "departmentId",
              amount_ore::text AS "amountOre", status, receipt_date::text AS "receiptDate", revision
            FROM economy_receipts
            ORDER BY submitted_at DESC, receipt_id ASC
          `
        : sql<ReceiptListItem>`
            SELECT receipt_id AS "receiptId", visual_id AS "visualId",
              owner_person_id AS "ownerPersonId", department_id AS "departmentId",
              amount_ore::text AS "amountOre", status, receipt_date::text AS "receiptDate", revision
            FROM economy_receipts
            WHERE department_id = ${scope.departmentId}
            ORDER BY submitted_at DESC, receipt_id ASC
          `;
    return yield* rows.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(projectionError("list approver receipts", cause)),
      ),
    );
  });

export const receiptStatusTotals: Effect.Effect<
  ReadonlyArray<ReceiptStatusTotal>,
  ReceiptPersistenceError,
  PgClient.PgClient
> = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
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
  readonly currency: "NOK";
  readonly description: string;
  readonly submittedAt: string;
}

export const listOwnedReceiptProjection = (
  ownerPersonId: string,
  status?: ReceiptListItem["status"],
): Effect.Effect<
  ReadonlyArray<OwnedReceiptProjectionItem>,
  ReceiptPersistenceError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows =
      status === undefined
        ? sql<OwnedReceiptProjectionItem>`
            SELECT receipt_id AS "receiptId", visual_id AS "visualId",
              owner_person_id AS "ownerPersonId", department_id AS "departmentId",
              amount_ore::text AS "amountOre", currency, description,
              receipt_date::text AS "receiptDate",
              to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
              to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
