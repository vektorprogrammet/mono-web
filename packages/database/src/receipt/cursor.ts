import {
  receiptPage,
  type ReceiptCursorPosition,
  type ReceiptPage,
} from "@vektorprogrammet/domain/receipt";
import type { Statement } from "effect/unstable/sql";
import type { DatabaseOperations } from "../service.js";

export type CursorPositioned<A> = A & { readonly cursorTimestamp: string };

/** Selects the ordering column as microsecond UTC text so cursor positions compare exactly. */
export const receiptCursorTimestamp = (
  sql: DatabaseOperations,
  column: Statement.Fragment,
): Statement.Fragment =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"`;

export const withoutCursorTimestamp = <A extends { readonly cursorTimestamp: string }>({
  cursorTimestamp: _cursorTimestamp,
  ...row
}: A): Omit<A, "cursorTimestamp"> => row;

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
