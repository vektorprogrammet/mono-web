# test-harness

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend. The [index](../constructs.md) lists every category.

## `ReceiptE2EBarrierArrival`

`false` for unprobed requests; `true` once all three lanes are synchronized.

```ts
type ReceiptE2EBarrierArrival = Effect.Effect<boolean, Problem<"request.malformed"> | Cause.TimeoutError>
```

- Inputs: none
- Output: `Effect.Effect<boolean, Problem<"request.malformed"> | Cause.TimeoutError>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/e2e-support.ts:17](../../apps/backend/src/receipt/e2e-support.ts#L17)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `selectDatabaseMigration`

Selects the registered migration `id` and the migrations that run before it; an absent id throws and names the nearest registered ids.

```ts
selectDatabaseMigration(id: DatabaseMigrationId): DatabaseMigrationSelection
```

- Inputs: `id: DatabaseMigrationId`
- Output: `DatabaseMigrationSelection`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/migrations.ts:692](../../packages/database/src/migrations.ts#L692)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `journeyClock`

A journey clock at a reference instant that the caller pins.

```ts
journeyClock(reference: string): JourneyClock
```

- Inputs: `reference: string`
- Output: `JourneyClock`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/e2e/journey-clock.ts:32](../../tools/e2e/journey-clock.ts#L32)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `admissionJourneyClock`

The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.

```ts
admissionJourneyClock(): JourneyClock
```

- Inputs: none
- Output: `JourneyClock`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/e2e/journey-clock.ts:52](../../tools/e2e/journey-clock.ts#L52)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `localBackendEnvironment`

The environment of a disposable local native backend for one composition.

```ts
localBackendEnvironment(composition: LocalBackendComposition)
```

- Inputs: `composition: LocalBackendComposition`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/e2e/local-backend-environment.ts:25](../../tools/e2e/local-backend-environment.ts#L25)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `selectedPostgresMajor`

The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.

```ts
const selectedPostgresMajor
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:94](../../tools/postgres/index.ts#L94)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `postgresProgram`

Absolute path of a client program of the selected PostgreSQL major.

```ts
postgresProgram(program: PostgresProgram): string
```

- Inputs: `program: PostgresProgram`
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:160](../../tools/postgres/index.ts#L160)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `postgresVersion`

The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.

```ts
postgresVersion(): string
```

- Inputs: none
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:168](../../tools/postgres/index.ts#L168)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `loopbackPortFree`

Whether a listener can bind `port` on loopback now.

```ts
loopbackPortFree(port: number)
```

- Inputs: `port: number`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:211](../../tools/postgres/index.ts#L211)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `reserveLoopbackPorts`

Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.

```ts
reserveLoopbackPorts(count: number): Promise<ReadonlyArray<number>>
```

- Inputs: `count: number`
- Output: `Promise<ReadonlyArray<number>>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:243](../../tools/postgres/index.ts#L243)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `startDisposablePostgres`

Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.

```ts
startDisposablePostgres(options: DisposablePostgresOptions = {}): Promise<DisposablePostgres>
```

- Inputs: `options: DisposablePostgresOptions = {}`
- Output: `Promise<DisposablePostgres>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:436](../../tools/postgres/index.ts#L436)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `withDisposablePostgres`

Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres` starts, and removes the cluster when `use` settles, also when it fails.

```ts
withDisposablePostgres<A>(
  database: string,
  use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>
): Promise<A>
```

- Inputs:
  - `database: string`
  - `use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>`
- Output: `Promise<A>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [tools/postgres/index.ts:648](../../tools/postgres/index.ts#L648)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
