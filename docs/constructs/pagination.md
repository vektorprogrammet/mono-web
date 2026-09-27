# pagination

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Keyset cursors and pages over ordered PostgreSQL reads. The [index](../constructs.md) lists every category.

## `CursorPositioned`

A row with the ordering text that `receiptCursorTimestamp` selects.

```ts
type CursorPositioned<A> = A & { readonly cursorTimestamp: string }
```

- Inputs: `A`
- Output: `A & { readonly cursorTimestamp: string }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/database/src/receipt/cursor.ts:38](../../packages/database/src/receipt/cursor.ts#L38)

**How it works**

The row type of a keyset read: the projection of the adapter plus `cursorTimestamp`, the
ordering instant as microsecond UTC text. `receiptCursorPage` reads that text and the row's
`receiptId` to encode the next cursor, and removes the text from each item.

**Use**

```ts
const visible: Array<CursorPositioned<ReceiptSettlementQueueItem>> = [];
```

**Avoid**

Positioning a cursor on a `Date` read from the ordering column: a `Date` keeps
milliseconds, so rows that differ in microseconds are skipped or read twice across pages.
Declare the row as `CursorPositioned<Row>` and select its text with `receiptCursorTimestamp`.

## `receiptCursorTimestamp`

Selects the ordering column as microsecond UTC text so cursor positions compare exactly.

```ts
receiptCursorTimestamp(sql: DatabaseOperations, column: Statement.Fragment): Statement.Fragment
```

- Inputs:
  - `sql: DatabaseOperations`
  - `column: Statement.Fragment`
- Output: `Statement.Fragment`
- Errors: none
- Requirements: none
- Side effects: none: it builds a fragment, and the statement that embeds it reads the rows.
- Source: [packages/database/src/receipt/cursor.ts:62](../../packages/database/src/receipt/cursor.ts#L62)

**How it works**

The fragment is `to_char(column AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS
"cursorTimestamp"`, the instant with all six fractional digits. A cursor carries this text, and
the next read compares `(column, receipt_id)` with `(text::timestamptz, id)`, which PostgreSQL
parses back to the same microsecond.

**Use**

```ts
sql`SELECT ${receiptCursorTimestamp(sql, sql`receipt.approved_at`)}, receipt.receipt_id AS "receiptId" FROM economy_receipts AS receipt`;
```

**Avoid**

Formatting the column with `MS` or reading it into a `Date`: both drop the microseconds
that PostgreSQL stores, so the cursor no longer names one position. Select it with this
fragment.

## `receiptCursorPage`

Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the ordering text.

```ts
receiptCursorPage<A extends { readonly cursorTimestamp: string; readonly receiptId: ReceiptCursorPosition["receiptId"] }>(
  rows: ReadonlyArray<A>
): ReceiptPage<Omit<A, "cursorTimestamp">>
```

- Inputs: `rows: ReadonlyArray<A>`
- Output: `ReceiptPage<Omit<A, "cursorTimestamp">>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/database/src/receipt/cursor.ts:100](../../packages/database/src/receipt/cursor.ts#L100)

**How it works**

The rows arrive in cursor order, the ordering column and then `receipt_id`, and a read selects
`RECEIPT_PAGE_SIZE + 1` of them. When more than a page arrived, it keeps the first
`RECEIPT_PAGE_SIZE` and sets `nextCursor` to the cursor of the last kept row: base64 of
`["receipt-v1", cursorTimestamp, receiptId]`, which `decodeReceiptCursor` reads. Otherwise the
page has every row and no `nextCursor`. Each item loses its `cursorTimestamp`.

**Use**

```ts
return receiptCursorPage(visible);
```

**Avoid**

Encoding a next cursor by hand, or returning rows with their `cursorTimestamp`: another
cursor format fails `decodeReceiptCursor`, and the ordering text leaks into the response. Read
one row more than a page and pass the rows here.
