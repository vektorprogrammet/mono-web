# sql-lifecycle

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access. The [index](../constructs.md) lists every category.

## `lockApplicationDecisionWithSql`

Fences this application's decision-sensitive writes in the caller's transaction.

```ts
lockApplicationDecisionWithSql(
  sql: DatabaseOperations,
  applicationId: PublicApplicationId
): Effect.Effect<void, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `applicationId: PublicApplicationId`
- Output: `Effect.Effect<void, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Waits for application row custody and increments its fence version until commit or rollback.
- Source: [packages/database/src/admissions/evidence.ts:28](../../packages/database/src/admissions/evidence.ts#L28)

**How it works**

Updates the application-owned version through the same SQL owner used by decision,
correction and window backstops. Unlike a row lock alone, this invalidates old snapshots.

**Use**

```ts
yield* lockApplicationDecisionWithSql(sql, applicationId);
```

**Avoid**

Calling outside the transaction that writes, or acquiring it before applicant custody.

## `readApplicationAdmissionEvidenceWithSql`

Reads decoded admission evidence from the application's own period and semester.

```ts
readApplicationAdmissionEvidenceWithSql(
  sql: DatabaseOperations,
  applicationId: PublicApplicationId,
  departmentId: DepartmentId,
  options: { readonly lock: boolean }
): Effect.Effect<ApplicationAdmissionEvidence, SqlError | Schema.SchemaError | AdmissionOutcomeFailure>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `applicationId: PublicApplicationId`
  - `departmentId: DepartmentId`
  - `options: { readonly lock: boolean }`
- Output: `Effect.Effect<ApplicationAdmissionEvidence, SqlError | Schema.SchemaError | AdmissionOutcomeFailure>`
- Errors: `SqlError | Schema.SchemaError | AdmissionOutcomeFailure`
- Requirements: none
- Side effects: Reads evidence and, on writes, acquires versioned application custody until transaction end.
- Source: [packages/database/src/admissions/evidence.ts:51](../../packages/database/src/admissions/evidence.ts#L51)

**How it works**

The SQL view owns live versus frozen citation selection and the public outcome projection.
Historical uncited decisions retain their outcome and never acquire a current assessment citation.
The caller owns authority, applicant custody and the transaction; lock=true takes the common fence.

**Use**

```ts
const evidence = yield* readApplicationAdmissionEvidenceWithSql(sql, applicationId, departmentId, { lock: true });
```

**Avoid**

Treating a department selector as authority or observing eligibility before a lock wait.

## `withNativeAuthProvisioning`

Runs one explicit native provisioning attempt through Better Auth's public endpoint context API.

```ts
withNativeAuthProvisioning<A>(
  context: Awaited<AuthEngine["$context"]>,
  task: () => Promise<A>
): Effect.Effect<A, Cause.UnknownError>
```

- Inputs:
  - `context: Awaited<AuthEngine["$context"]>`
  - `task: () => Promise<A>`
- Output: `Effect.Effect<A, Cause.UnknownError>`
- Errors: `Cause.UnknownError`
- Requirements: none
- Side effects: Executes the caller's supported Better Auth write and scopes its private authority.
- Source: [packages/database/src/auth-engine.ts:373](../../packages/database/src/auth-engine.ts#L373)

**How it works**

Only this helper mints the private marker. Hooks require both its identity and live
owner registration; copied contexts, lookalike keys and request contexts grant no authority.
The marker ends on success, failure or interruption. Better Auth's Promise writes have no
cancellation ABI: interruption revokes later hook admission but does not certify rollback
of an operation already accepted by its adapter. This helper retries nothing.

**Use**

```ts
yield* withNativeAuthProvisioning(context, () => context.internalAdapter.linkAccount(account));
```

**Avoid**

Passing request-sourced authority or treating cancellation as a transaction receipt.

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
- Side effects: Reads `auth."user"`; with `ForShare` it holds a share lock on the row until the transaction ends.
- Source: [packages/database/src/identity-access.ts:38](../../packages/database/src/identity-access.ts#L38)

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
- Source: [packages/database/src/outbox-lifecycle.ts:144](../../packages/database/src/outbox-lifecycle.ts#L144)

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
- Source: [packages/database/src/outbox-lifecycle.ts:176](../../packages/database/src/outbox-lifecycle.ts#L176)

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
- Source: [packages/database/src/outbox-lifecycle.ts:220](../../packages/database/src/outbox-lifecycle.ts#L220)

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
- Source: [packages/database/src/outbox-lifecycle.ts:249](../../packages/database/src/outbox-lifecycle.ts#L249)

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
- Source: [packages/database/src/outbox-lifecycle.ts:286](../../packages/database/src/outbox-lifecycle.ts#L286)

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
- Source: [packages/database/src/outbox-lifecycle.ts:321](../../packages/database/src/outbox-lifecycle.ts#L321)

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

## `nativePgLayer`

Builds the native SQL layer with an explicit host-owned connection limit.

```ts
nativePgLayer(
  config: NativePgPoolConfig
): Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, Schema.SchemaError | SqlError>
```

- Inputs: `config: NativePgPoolConfig`
- Output: `Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, Schema.SchemaError | SqlError>`
- Errors: `Schema.SchemaError | SqlError`
- Requirements: none
- Side effects: Opens native PostgreSQL sessions only after the layer runs.
- Source: [packages/database/src/pg-pool.ts:70](../../packages/database/src/pg-pool.ts#L70)

**How it works**

The caller owns the layer scope. The native driver owns acquisition, transaction reservation,
cancellation, and release. Each checkout is exclusive. The driver can queue waiting fibers,
so this limit bounds connections, not admitted work. Prepared statements require an explicit
choice for a compatible pooler. An absent connectionTTL preserves unlimited connection reuse.
Building the layer performs no work. Its scope closes its native pool on every exit.
EX-0034: native admission policy is patched at the upstream boundary. Omitted or false preserves
the caller mask; explicit acquisitionInterruptible true interrupts only top-level admission.
Explicit shutdownTimeout owns the graceful wait, then a 100ms real-close acknowledgement bound;
no close event is a defect, not a successful disposal or transaction-outcome receipt.

**Use**

```ts
const sql = nativePgLayer({ url, maxConnections: 2, prepare: false });
```

**Avoid**

Providing a new layer for each service or enabling multiplexing on a cancellable path.

## `AuthPoolLive`

Builds the supported Better Auth pool with its own host-supplied capacity.

```ts
AuthPoolLive(
  config: { readonly postgresUrl: string },
  options: AuthPoolOptions
): Layer.Layer<AuthPgPool, Schema.SchemaError>
```

- Inputs:
  - `config: { readonly postgresUrl: string }`
  - `options: AuthPoolOptions`
- Output: `Layer.Layer<AuthPgPool, Schema.SchemaError>`
- Errors: `Schema.SchemaError`
- Requirements: none
- Side effects: Opens supported pg sessions only when the auth adapter uses the layer.
- Source: [packages/database/src/pg-pool.ts:120](../../packages/database/src/pg-pool.ts#L120)

**How it works**

This layer owns only the node-postgres pool. It never provides native SqlClient.
The host provides it separately from Database. Native callback fibers close before
the pool, and pool diagnostic fibers remain owned until the pool closes.
A client deadline does not prove PostgreSQL cancellation or a committed outcome.

**Use**

```ts
const authPool = AuthPoolLive(config, {
  maxConnections: 2,
  applicationName: "vektorprogrammet-worker-auth",
  pipeline: true,
  connectTimeoutMilliseconds: 2_000,
  queryTimeoutMilliseconds: 1_000,
});
```

**Avoid**

Providing this layer to a delivery-only event or sharing it with native Effect SQL.

## `executePostgresMigration`

Executes parsed statements sequentially on the provided native SQL client.

```ts
executePostgresMigration(
  source: string
): Effect.Effect<void, SqlError | DatabaseMigrationExecutionError, SqlClient.SqlClient>
```

- Inputs: `source: string`
- Output: `Effect.Effect<void, SqlError | DatabaseMigrationExecutionError, SqlClient.SqlClient>`
- Errors: `SqlError | DatabaseMigrationExecutionError`
- Requirements: `SqlClient.SqlClient`
- Side effects: Executes original statement bytes when the Effect runs.
- Source: [packages/database/src/postgres-migration-statements.ts:84](../../packages/database/src/postgres-migration-statements.ts#L84)

**How it works**

The caller (normally Migrator) owns the transaction. Construction is suspended;
this operation never commits, opens another pool, or retries. SQL errors remain
typed. Interruption stops subsequent statements and the owner rolls back.

**Use**

```ts
yield* sql.withTransaction(executePostgresMigration(source));
```

**Avoid**

Running it outside the migration owner's transaction or on a new pool.
