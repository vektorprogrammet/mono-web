# sql-lock

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Transaction-scoped PostgreSQL advisory locks under registered keys. The [index](../constructs.md) lists every category.

## `AdvisoryLockKey`

The registered advisory-lock keys, one constructor per namespace.

```ts
const AdvisoryLockKey
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/advisory-lock.ts:40](../../packages/database/src/advisory-lock.ts#L40)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/advisory-lock.ts:128](../../packages/database/src/advisory-lock.ts#L128)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/organization/authority-postgres.ts:46](../../packages/database/src/organization/authority-postgres.ts#L46)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
