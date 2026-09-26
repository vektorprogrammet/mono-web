# sql-lifecycle

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access. The [index](../constructs.md) lists every category.

## `accountAccessEnabled`

Whether the native account of `personId` exists and is not disabled.

```ts
accountAccessEnabled(
  sql: DatabaseOperations,
  personId: PersonId,
  lock: "None" | "ForShare"
): Effect.Effect<boolean, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `personId: PersonId`
  - `lock: "None" | "ForShare"`
- Output: `Effect.Effect<boolean, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/identity-access.ts:17](../../packages/database/src/identity-access.ts#L17)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `outboxClaimAssignments`

SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.

```ts
outboxClaimAssignments(
  sql: DatabaseOperations,
  targetAlias: string,
  claimId: string,
  claimedAt: string
): Statement.Fragment
```

- Inputs:
  - `sql: DatabaseOperations`
  - `targetAlias: string`
  - `claimId: string`
  - `claimedAt: string`
- Output: `Statement.Fragment`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:123](../../packages/database/src/outbox-lifecycle.ts#L123)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `markOutboxDelivered`

Settles the claimed row as Delivered, with delivery evidence when the table records it.

```ts
markOutboxDelivered(
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  evidence?: OutboxDeliveryEvidence
): Effect.Effect<void, OutboxClaimLost | SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claim: OutboxClaim`
  - `evidence?: OutboxDeliveryEvidence`
- Output: `Effect.Effect<void, OutboxClaimLost | SqlError>`
- Errors: `OutboxClaimLost | SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:138](../../packages/database/src/outbox-lifecycle.ts#L138)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `markOutboxFailed`

Settles the claimed row as Failed with its failure tag, so a later claim retries it.

```ts
markOutboxFailed(
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): Effect.Effect<void, OutboxClaimLost | SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claim: OutboxClaim`
  - `failureTag: string`
- Output: `Effect.Effect<void, OutboxClaimLost | SqlError>`
- Errors: `OutboxClaimLost | SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:168](../../packages/database/src/outbox-lifecycle.ts#L168)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `quarantineOutboxClaim`

Settles the claimed row as Quarantined, a terminal status, with its failure tag.

```ts
quarantineOutboxClaim(
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): Effect.Effect<void, OutboxClaimLost | SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claim: OutboxClaim`
  - `failureTag: string`
- Output: `Effect.Effect<void, OutboxClaimLost | SqlError>`
- Errors: `OutboxClaimLost | SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:182](../../packages/database/src/outbox-lifecycle.ts#L182)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `releaseOutboxClaim`

Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.

```ts
releaseOutboxClaim(
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): Effect.Effect<void, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claim: OutboxClaim`
  - `failureTag: string`
- Output: `Effect.Effect<void, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:203](../../packages/database/src/outbox-lifecycle.ts#L203)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `recoverStaleOutboxClaims`

Recovers every Processing row claimed before `claimedBefore`.

```ts
recoverStaleOutboxClaims(
  sql: DatabaseOperations,
  table: OutboxTable,
  claimedBefore: string,
  recovery: OutboxStaleRecovery
): Effect.Effect<number, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claimedBefore: string`
  - `recovery: OutboxStaleRecovery`
- Output: `Effect.Effect<number, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:221](../../packages/database/src/outbox-lifecycle.ts#L221)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `recoverStaleOutboxClaim`

Recovers the rows of one claim when that claim was taken before `claimedBefore`.

```ts
recoverStaleOutboxClaim(
  sql: DatabaseOperations,
  table: OutboxTable,
  claimId: string,
  claimedBefore: string,
  recovery: OutboxStaleRecovery
): Effect.Effect<number, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `table: OutboxTable`
  - `claimId: string`
  - `claimedBefore: string`
  - `recovery: OutboxStaleRecovery`
- Output: `Effect.Effect<number, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/outbox-lifecycle.ts:234](../../packages/database/src/outbox-lifecycle.ts#L234)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
