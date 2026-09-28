/**
 * Keyset cursor pages over receipt reads.
 *
 * Use these helpers in a read that pages by the receipt cursor: select the ordering column with
 * `receiptCursorTimestamp`, read one row more than a page, and finish the page with
 * `receiptCursorPage`. The cursor keeps the microsecond precision of PostgreSQL timestamps, which a
 * JavaScript `Date` would lose.
 */
import { dual } from "effect/Function";
import {
  receiptPage,
  type ReceiptCursorPosition,
  type ReceiptPage,
} from "@vektorprogrammet/domain/receipt";
import type { Statement } from "effect/unstable/sql";
import type { DatabaseOperations } from "../service.js";

/**
 * A row with the ordering text that `receiptCursorTimestamp` selects.
 *
 * @remarks
 * The row type of a keyset read: the projection of the adapter plus `cursorTimestamp`, the
 * ordering instant as microsecond UTC text. `receiptCursorPage` reads that text and the row's
 * `receiptId` to encode the next cursor, and removes the text from each item.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const visible: Array<CursorPositioned<ReceiptSettlementQueueItem>> = [];
 * ```
 *
 * @avoid Positioning a cursor on a `Date` read from the ordering column: a `Date` keeps
 * milliseconds, so rows that differ in microseconds are skipped or read twice across pages.
 * Declare the row as `CursorPositioned<Row>` and select its text with `receiptCursorTimestamp`.
 *
 * @construct pagination
 */
export type CursorPositioned<A> = A & { readonly cursorTimestamp: string };

/**
 * Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
 *
 * @remarks
 * The fragment is `to_char(column AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS
 * "cursorTimestamp"`, the instant with all six fractional digits. A cursor carries this text, and
 * the next read compares `(column, receipt_id)` with `(text::timestamptz, id)`, which PostgreSQL
 * parses back to the same microsecond.
 *
 * @sideEffects none: it builds a fragment, and the statement that embeds it reads the rows.
 *
 * @example
 * ```ts
 * sql`SELECT ${receiptCursorTimestamp(sql, sql`receipt.approved_at`)}, receipt.receipt_id AS "receiptId" FROM economy_receipts AS receipt`;
 * ```
 *
 * @avoid Formatting the column with `MS` or reading it into a `Date`: both drop the microseconds
 * that PostgreSQL stores, so the cursor no longer names one position. Select it with this
 * fragment.
 *
 * @construct pagination
 */
export const receiptCursorTimestamp: {
  (column: Statement.Fragment): (sql: DatabaseOperations) => Statement.Fragment;
  (sql: DatabaseOperations, column: Statement.Fragment): Statement.Fragment;
} = dual(
  2,
  (sql: DatabaseOperations, column: Statement.Fragment): Statement.Fragment =>
    sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"`,
);

/**
 * Drops the ordering text from a row before the row leaves the adapter.
 */
export const withoutCursorTimestamp = <A extends { readonly cursorTimestamp: string }>({
  cursorTimestamp: _cursorTimestamp,
  ...row
}: A): Omit<A, "cursorTimestamp"> => row;

/**
 * Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the
 * ordering text.
 *
 * @remarks
 * The rows arrive in cursor order, the ordering column and then `receipt_id`, and a read selects
 * `RECEIPT_PAGE_SIZE + 1` of them. When more than a page arrived, it keeps the first
 * `RECEIPT_PAGE_SIZE` and sets `nextCursor` to the cursor of the last kept row: base64 of
 * `["receipt-v1", cursorTimestamp, receiptId]`, which `decodeReceiptCursor` reads. Otherwise the
 * page has every row and no `nextCursor`. Each item loses its `cursorTimestamp`.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * return receiptCursorPage(visible);
 * ```
 *
 * @avoid Encoding a next cursor by hand, or returning rows with their `cursorTimestamp`: another
 * cursor format fails `decodeReceiptCursor`, and the ordering text leaks into the response. Read
 * one row more than a page and pass the rows here.
 *
 * @construct pagination
 */
export const receiptCursorPage = <
  A extends {
    readonly cursorTimestamp: string;
    readonly receiptId: ReceiptCursorPosition["receiptId"];
  },
>(
  rows: ReadonlyArray<A>,
): ReceiptPage<Omit<A, "cursorTimestamp">> => {
  const page = receiptPage(rows, (row) => ({
    timestamp: row.cursorTimestamp,
    receiptId: row.receiptId,
  }));

  return { ...page, items: page.items.map(withoutCursorTimestamp) };
};
