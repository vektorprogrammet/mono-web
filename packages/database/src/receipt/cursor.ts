/**
 * Keyset cursor pages over receipt reads.
 *
 * Use these helpers in a read that pages by the receipt cursor: select the ordering column with
 * `receiptCursorTimestamp`, read one row more than a page, and finish the page with
 * `receiptCursorPage`. The cursor keeps the microsecond precision of PostgreSQL timestamps, which a
 * JavaScript `Date` would lose.
 */
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
 * @construct pagination
 */
export type CursorPositioned<A> = A & { readonly cursorTimestamp: string };

/**
 * Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
 *
 * @construct pagination
 */
export const receiptCursorTimestamp = (
  sql: DatabaseOperations,
  column: Statement.Fragment,
): Statement.Fragment =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"`;

/**
 * Drops the ordering text from a row before the row leaves the adapter.
 *
 * @construct pagination
 */
export const withoutCursorTimestamp = <A extends { readonly cursorTimestamp: string }>({
  cursorTimestamp: _cursorTimestamp,
  ...row
}: A): Omit<A, "cursorTimestamp"> => row;

/**
 * Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the
 * ordering text.
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
