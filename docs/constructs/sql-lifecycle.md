# sql-lifecycle

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access. The [index](../constructs.md) lists every category.

## `accountAccessEnabled`

Whether the native account of `personId` exists and is not disabled.

```ts
accountAccessEnabled(
  personId: PersonId,
  lock: "None" | "ForShare"
): (sql: DatabaseOperations) => Effect.Effect<boolean, SqlError>
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
- Side effects: Reads `auth."user"`; with `ForShare` it holds a share lock on the row until the transaction ends.
- Source: [packages/database/src/identity-access.ts:35](../../packages/database/src/identity-access.ts#L35)

**How it works**

It reads `NOT access_disabled` from the `auth."user"` row of `personId`, and a missing row
answers false. `ForShare` reads with a share row lock, so a disable, which
`changeNativeAccountAccess` writes under `FOR UPDATE`, waits until the transaction that
authorized with this answer ends. `None` reads without a lock, for a read that writes nothing.

**Use**

```ts
if (!(yield* accountAccessEnabled(sql, personId, "ForShare"))) return yield* fail("Denied");
```

**Avoid**

Checking a command's actor with `None`, or in another transaction than its writes: a
disable can then commit between the check and the command. A command reads with `ForShare`
inside the transaction that writes.

## `outboxClaimAssignments`

SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.

```ts
outboxClaimAssignments(
  targetAlias: string,
  claimId: string,
  claimedAt: string
): (sql: DatabaseOperations) => Statement.Fragment
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
- Side effects: none: it builds a fragment, and the aggregate's UPDATE writes the row.
- Source: [packages/database/src/outbox-lifecycle.ts:141](../../packages/database/src/outbox-lifecycle.ts#L141)

**How it works**

The fragment sets `status = 'Processing'`, the claim's `claim_id` and `claimed_at`, increments
`attempts` from the row that `targetAlias` names, and clears `last_failure_tag`. The aggregate
keeps the rest of its claim UPDATE: candidate selection, predecessor ordering, row locks, and
the RETURNING list. Attempts count claims; no other transition changes them.

**Use**

```ts
sql`UPDATE economy_receipt_outbox AS claimed SET ${outboxClaimAssignments(sql, "claimed", claimId, claimedAt)} FROM candidate WHERE claimed.effect_id = candidate.effect_id`;
```

**Avoid**

Writing the claim columns by hand: a copy can miss the attempt count or keep the last
failure tag, and it copies the column protocol that every outbox table shares. Put this SET
list in every claim UPDATE.

## `markOutboxDelivered`

Settles the claimed row as Delivered, with delivery evidence when the table records it.

```ts
markOutboxDelivered(
  table: OutboxTable,
  claim: OutboxClaim,
  evidence?: OutboxDeliveryEvidence
): (sql: DatabaseOperations) => Effect.Effect<void, OutboxClaimLost | SqlError>
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
- Side effects: Writes the outbox row that the claim still owns.
- Source: [packages/database/src/outbox-lifecycle.ts:188](../../packages/database/src/outbox-lifecycle.ts#L188)

**How it works**

One UPDATE matches the row's `effect_id`, `status = 'Processing'`, and the claim's `claim_id`.
It sets `Delivered`, clears the claim and `last_failure_tag`, writes `delivered_at` and
`provider_reference` when `evidence` carries them, and replaces `payload_json` with `{}` when
`table.terminalPayload` is `Scrub`. When no row matches, stale recovery or another claim owns
the row, so it changes nothing and fails with `OutboxClaimLost`.

**Use**

```ts
Database.use((sql) => markOutboxDelivered(sql, receiptOutbox, claim));
```

**Avoid**

Updating the status by `effect_id` alone, or reporting a delivery after
`OutboxClaimLost`: the row belongs to another claim, whose outcome would be overwritten. Handle
`OutboxClaimLost` as a lost race, not as a success.

## `markOutboxFailed`

Settles the claimed row as Failed with its failure tag, so a later claim retries it.

```ts
markOutboxFailed(
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): (sql: DatabaseOperations) => Effect.Effect<void, OutboxClaimLost | SqlError>
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
- Side effects: Writes the outbox row that the claim still owns.
- Source: [packages/database/src/outbox-lifecycle.ts:247](../../packages/database/src/outbox-lifecycle.ts#L247)

**How it works**

Under the same claim fence as `markOutboxDelivered`, it sets `Failed` and `last_failure_tag`,
clears the claim, and keeps `payload_json`, because a later claim delivers the same envelope.
When the claim no longer owns the row, it changes nothing and fails with `OutboxClaimLost`.

**Use**

```ts
Database.use((sql) => markOutboxFailed(sql, receiptOutbox, claim, failureTag));
```

**Avoid**

Failing a row that no retry can deliver, such as an envelope that does not decode: a
later claim takes it again. Quarantine it with `quarantineOutboxClaim`.

## `quarantineOutboxClaim`

Settles the claimed row as Quarantined, a terminal status, with its failure tag.

```ts
quarantineOutboxClaim(
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): (sql: DatabaseOperations) => Effect.Effect<void, OutboxClaimLost | SqlError>
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
- Side effects: Writes the outbox row that the claim still owns.
- Source: [packages/database/src/outbox-lifecycle.ts:291](../../packages/database/src/outbox-lifecycle.ts#L291)

**How it works**

Under the same claim fence as `markOutboxDelivered`, it sets `Quarantined` and
`last_failure_tag`, clears the claim, and replaces `payload_json` with `{}` when
`table.terminalPayload` is `Scrub`. No claim selects a quarantined row again. When the claim no
longer owns the row, it changes nothing and fails with `OutboxClaimLost`.

**Use**

```ts
quarantineOutboxClaim(sql, notificationOutbox, { effectId, claimId }, failureTag);
```

**Avoid**

Quarantining a failure that a retry can overcome, such as a provider outage: the effect
is then never delivered. Mark it failed with `markOutboxFailed`.

## `releaseOutboxClaim`

Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.

```ts
releaseOutboxClaim(
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string
): (sql: DatabaseOperations) => Effect.Effect<void, SqlError>
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
- Side effects: Writes the outbox row when the claim still owns it.
- Source: [packages/database/src/outbox-lifecycle.ts:343](../../packages/database/src/outbox-lifecycle.ts#L343)

**How it works**

A worker that is interrupted before the provider answers releases its claim. Under the same
claim fence as `markOutboxDelivered`, it sets `Pending` with the failure tag and clears the
claim, so the next claim delivers the row. When the claim no longer owns the row, it succeeds
without a change, because stale recovery or another claim has already moved the row.

**Use**

```ts
releaseOutboxClaim(sql, invitationOutbox, claim, "InterruptedRecruitmentInvitationClaim");
```

**Avoid**

Releasing a claim after the provider answered: the next claim sends the effect again.
Settle an answered delivery with `markOutboxDelivered` or `markOutboxFailed`.

## `recoverStaleOutboxClaims`

Recovers every Processing row claimed before `claimedBefore`.

```ts
recoverStaleOutboxClaims(
  table: OutboxTable,
  claimedBefore: string,
  recovery: OutboxStaleRecovery
): (sql: DatabaseOperations) => Effect.Effect<number, SqlError>
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
- Side effects: Writes every stale Processing row of the table.
- Source: [packages/database/src/outbox-lifecycle.ts:393](../../packages/database/src/outbox-lifecycle.ts#L393)

**How it works**

One UPDATE moves each `Processing` row whose `claimed_at` lies before `claimedBefore` to
`recovery.status`, `Pending` or `Failed`, with `recovery.failureTag`, clears its claim, and
answers the number of rows it recovered. The worker of such a claim counts as gone; if it still
runs, its settlement fails with `OutboxClaimLost`.

**Use**

```ts
recoverStaleOutboxClaims(sql, invitationOutbox, claimedBefore, { status: "Failed", failureTag: "StaleClaimRecovered" });
```

**Avoid**

A cutoff that a live claim can still reach, such as one closer to now than the longest
provider call: the row goes to a second claim, which delivers the effect again. Derive
`claimedBefore` from the worker's stale-claim window, as now minus `staleClaimMilliseconds`.
