# sql-lock

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Transaction-scoped PostgreSQL advisory locks under registered keys. The [index](../constructs.md) lists every category.

## `AdvisoryLockKey`

The registered advisory-lock keys, one constructor per namespace.

```ts
const AdvisoryLockKey: AdvisoryLockKeys
```

- Inputs: none
- Output: `AdvisoryLockKeys`
- Errors: none
- Requirements: none
- Side effects: none: it builds key text, and `lockAdvisory` takes the lock.
- Source: [packages/database/src/advisory-lock.ts:125](../../packages/database/src/advisory-lock.ts#L125)

**How it works**

Each member builds the key text of one namespace, and `AdvisoryLockKeys` names the writers that
share it. `lockAdvisory` hashes the text with `hashtextextended(key, 0)`, so two writers exclude
each other exactly when they build the same bytes. A bare namespace hashes its identifier
without a prefix, so the bare namespaces share one key space. The SQL writers that the module
documentation lists hash the same text inside migrations.

**Use**

```ts
yield* lockAdvisory(sql, AdvisoryLockKey.receiptCommand(command.commandId));
```

**Avoid**

Writing key text by hand, in SQL or in TypeScript, or changing the bytes of a member:
another spelling ends mutual exclusion with every writer of the old bytes, and
`anti-slop/no-raw-advisory-lock-sql` rejects hand-written advisory-lock SQL. Add a member for a
new namespace; a change to an existing one is a lock migration.

## `lockAdvisory`

Waits for the advisory lock on `key` until the current transaction ends.

```ts
lockAdvisory(
  sql: DatabaseOperations,
  key: AdvisoryLockKey,
  mode: AdvisoryLockMode = "exclusive"
): Effect.Effect<void, SqlError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `key: AdvisoryLockKey`
  - `mode: AdvisoryLockMode = "exclusive"`
- Output: `Effect.Effect<void, SqlError>`
- Errors: `SqlError`
- Requirements: none
- Side effects: Holds a PostgreSQL advisory lock until the transaction ends, and waits while another transaction holds a conflicting one.
- Source: [packages/database/src/advisory-lock.ts:203](../../packages/database/src/advisory-lock.ts#L203)

**How it works**

It runs `pg_advisory_xact_lock(hashtextextended(key, 0))`, or `pg_advisory_xact_lock_shared`
when `mode` is `shared`: shared holders exclude only exclusive holders, and an exclusive holder
excludes both. PostgreSQL releases a transaction-level lock at commit or rollback, and outside a
transaction after the statement, so the lock serializes only what runs inside the same
`withTransaction`. Writers that take several locks take them in one order, such as the
administrator set before any person lock, so that two of them cannot deadlock.

**Use**

```ts
yield* lockAdvisory(sql, AdvisoryLockKey.contentArticle(articleId));
```

**Avoid**

Calling it outside `withTransaction`, where the lock ends with its own statement and
guards nothing, and hand-written `pg_advisory_xact_lock` SQL, which
`anti-slop/no-raw-advisory-lock-sql` rejects. Lock first inside the transaction that writes.

## `lockPersonAuthorization`

Serializes one person's protected command with person-keyed authority writers.

```ts
lockPersonAuthorization(
  sql: DatabaseOperations,
  personId: PersonId
): Effect.Effect<void, OrganizationPersistenceError>
```

- Inputs:
  - `sql: DatabaseOperations`
  - `personId: PersonId`
- Output: `Effect.Effect<void, OrganizationPersistenceError>`
- Errors: `OrganizationPersistenceError`
- Requirements: none
- Side effects: Holds the person's advisory lock until the transaction ends, and waits while another transaction holds it.
- Source: [packages/database/src/organization/authority-postgres.ts:66](../../packages/database/src/organization/authority-postgres.ts#L66)

**How it works**

It takes the exclusive transaction lock on `AdvisoryLockKey.personAuthorization(personId)`,
the key that the SQL guards of migrations 0037, 0038, and 0060 hash, and maps a SQL failure to
`OrganizationPersistenceError`. A command takes it before it resolves the person's authority,
so no grant, session, or credential change of that person commits between the authority read
and the command's writes. A command that locks several people locks them in sorted order,
after the administrator set when it changes that set.

**Use**

```ts
yield* lockPersonAuthorization(sql, actorPersonId);
```

**Avoid**

Resolving authority before the lock, or outside the committing transaction: a grant
that ends between the read and the write then authorizes the command. Lock first, inside the
transaction that writes.
