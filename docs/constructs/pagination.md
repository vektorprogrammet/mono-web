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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/receipt/cursor.ts:22](../../packages/database/src/receipt/cursor.ts#L22)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/receipt/cursor.ts:29](../../packages/database/src/receipt/cursor.ts#L29)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/receipt/cursor.ts:49](../../packages/database/src/receipt/cursor.ts#L49)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
