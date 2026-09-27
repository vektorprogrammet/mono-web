# test-harness

[//]: # "constructs: generated from the @construct tags and their JSDoc by just docs generate; do not edit"

Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend. The [index](../constructs.md) lists every category.

## `selectDatabaseMigration`

Selects the registered migration `id` and the migrations that run before it.

```ts
selectDatabaseMigration(id: DatabaseMigrationId): DatabaseMigrationSelection
```

- Inputs: `id: DatabaseMigrationId`
- Output: `DatabaseMigrationSelection`
- Errors: none
- Throws: An `Error` that names the nearest registered ids, when `id` is not registered, which only a caller that bypasses the id type reaches.
- Requirements: none
- Side effects: none
- Source: [packages/database/src/migrations.ts:710](../../packages/database/src/migrations.ts#L710)

**How it works**

It finds `id` in the migration registry, whose order is the order in which the migrations
apply. `preceding` replays the history up to the migration, and `[...preceding, migration]`
replays it through the migration, so an upgrade proof seeds the previous schema without
counting positions. The id type admits only registered ids, so a misspelt id fails the type
check.

**Use**

```ts
const { migration, preceding } = selectDatabaseMigration("26_declarative-rule-reconciliation");
```

**Avoid**

Selecting a migration by its position, such as `databaseMigrationDefinitions[25]`: a
migration that another branch registers shifts the positions after it. Select it by id.

## `journeyClock`

A journey clock at a reference instant that the caller pins.

```ts
journeyClock(reference: string): JourneyClock
```

- Inputs: `reference: string`
- Output: `JourneyClock`
- Errors: none
- Throws: An `Error` when `reference` is not an instant that `Date.parse` reads.
- Requirements: none
- Side effects: none
- Source: [tools/e2e/journey-clock.ts:50](../../tools/e2e/journey-clock.ts#L50)

**How it works**

`now` is the reference in the form that `Date#toISOString` writes, and `fromNow(days, minutes)`
adds whole days and minutes to it, or subtracts them for negative offsets. Seeds, drivers, and
specs that take their instants from one clock agree with each other on any date.

**Use**

```ts
const clock = journeyClock("2031-09-15T12:00:00.000Z");
```

**Avoid**

Writing a window bound, such as the end of an admission period, as a literal instant:
the journey fails once the real clock passes it, and `anti-slop/no-literal-window-instant`
rejects it. Derive the bound with `clock.fromNow(days)`.

## `admissionJourneyClock`

The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.

```ts
admissionJourneyClock(): JourneyClock
```

- Inputs: none
- Output: `JourneyClock`
- Errors: none
- Throws: An `Error` when `ADMISSION_FIXED_NOW` is set to text that `Date.parse` does not read.
- Requirements: none
- Side effects: Reads `ADMISSION_FIXED_NOW` from the environment, and the current time when it is unset.
- Source: [tools/e2e/journey-clock.ts:89](../../tools/e2e/journey-clock.ts#L89)

**How it works**

It reads `ADMISSION_FIXED_NOW` at each call, the variable that the backend's admission clock
reads, and gives a `journeyClock` at that instant, or at the current time when it is unset. So
the fixture instants of a journey lie where the backend it starts sees them.

**Use**

```ts
const { fromNow: fromJourneyNow } = admissionJourneyClock();
```

**Avoid**

Taking fixture instants from `new Date()` while the backend runs with
`ADMISSION_FIXED_NOW`: the seeded windows then lie outside the backend's time. Take them from
this clock whenever the backend reads the admission clock.

## `localBackendEnvironment`

The environment of a disposable local native backend for one composition.

```ts
localBackendEnvironment(composition: LocalBackendComposition): LocalBackendEnvironment
```

- Inputs: `composition: LocalBackendComposition`
- Output: `LocalBackendEnvironment`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [tools/e2e/local-backend-environment.ts:58](../../tools/e2e/local-backend-environment.ts#L58)

**How it works**

It takes `BACKEND_HOST` and `BACKEND_PORT` from `backendOrigin`, which is also the OAuth
issuer, trusts `dashboardOrigin` as the first-party origin, points the backend at
`postgresUrl`, selects the `local` identity deployment, and disables public application,
password reset, and receipt delivery, so the backend calls no provider.

**Use**

```ts
const environment = { ...process.env, ...localBackendEnvironment({ backendOrigin, dashboardOrigin, postgresUrl, betterAuthSecret }) };
```

**Avoid**

Copying these variables into a runner: a setting that the backend starts to require
then breaks every copy but this one. Spread this record, and add only the settings of the
journey.

## `postgresProgram`

Absolute path of a client program of the selected PostgreSQL major.

```ts
postgresProgram(program: PostgresProgram): string
```

- Inputs: `program: PostgresProgram`
- Output: `string`
- Errors: none
- Throws: An `Error` that names the selected major and what `PATH` provides, when the first `postgres` on `PATH` is missing or of another major.
- Requirements: none
- Side effects: Reads `PATH` and runs `postgres --version` at the first resolution of the process.
- Source: [tools/postgres/index.ts:178](../../tools/postgres/index.ts#L178)

**How it works**

The first `postgres` on `PATH` decides the installation, and it must be of the major that
`VEKTOR_POSTGRES_MAJOR` selects from `engines.postgresql` in the root manifest. The
installation is resolved once per process, and the path names `program` in its directory. The
cluster programs are not in `PostgresProgram`, because only `startDisposablePostgres` runs them.

**Use**

```ts
await execFileAsync(postgresProgram("psql"), ["-h", "127.0.0.1", "-p", String(port), "-c", sql]);
```

**Avoid**

Running `psql`, `pg_dump`, or `pg_restore` by bare name: `PATH` can hold a client of
another major than the cluster, whose dump or restore then fails or differs. Run the path that
this returns.

## `postgresVersion`

The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.

```ts
postgresVersion(): string
```

- Inputs: none
- Output: `string`
- Errors: none
- Throws: An `Error` when the first `postgres` on `PATH` is missing or of another major, as `postgresProgram` throws.
- Requirements: none
- Side effects: Reads `PATH` and runs `postgres --version` at the first resolution of the process.
- Source: [tools/postgres/index.ts:203](../../tools/postgres/index.ts#L203)

**How it works**

It resolves the installation as `postgresProgram` does, once per process, and answers the
version line that the resolution read. It starts no server.

**Use**

```ts
const toolchain = { bun: process.versions.bun, postgres: postgresVersion() };
```

**Avoid**

Reading the version from a started cluster only: a run that fails before its cluster
starts then names no toolchain in its evidence. Record `postgresVersion()` instead.

## `loopbackPortFree`

Whether a listener can bind `port` on loopback now.

```ts
loopbackPortFree(port: number): Promise<boolean>
```

- Inputs: `port: number`
- Output: `Promise<boolean>`
- Errors: none
- Requirements: none
- Side effects: Binds `port` on loopback for the moment of the probe.
- Source: [tools/postgres/index.ts:260](../../tools/postgres/index.ts#L260)

**How it works**

It listens on `127.0.0.1:port` with an exclusive bind, closes again, and answers false when the
bind fails. A journey checks with it that a fixed port is free before its server binds it, and
that its reserved ports are free again after teardown. It reserves nothing: it answers for a
port that the caller names, and another process can bind the port after it answers.

**Use**

```ts
if (!(await loopbackPortFree(port))) throw new Error(`port ${port} is still bound`);
```

**Avoid**

Choosing the port of a server with it: another bind can take the port before the server
binds it. Reserve the ports of a journey with `reserveLoopbackPorts`.

## `reserveLoopbackPorts`

Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.

```ts
reserveLoopbackPorts(count: number): Promise<ReadonlyArray<number>>
```

- Inputs: `count: number`
- Output: `Promise<ReadonlyArray<number>>`
- Errors: none
- Throws: Rejects with an `Error` when no port of the range is free.
- Requirements: none
- Side effects: Binds each drawn port on loopback for the moment of its probe, and keeps the reserved ports in the process, so that no later reservation returns them.
- Source: [tools/postgres/index.ts:309](../../tools/postgres/index.ts#L309)

**How it works**

It draws each port at random from 20000 to 32767, below the kernel's ephemeral range, where
only a process that names a port binds it. A drawn port counts when `loopbackPortFree` answers
true and no earlier reservation of this process returned it. A probe that listens on port 0
learns a port in the ephemeral range instead, where the run's next probe, a child, or another
process can take it before its server binds it.

**Use**

```ts
const [dashboardPort, backendPort, postgresPort] = await reserveLoopbackPorts(3);
```

**Avoid**

Listening on port 0 and closing to learn a free port: another bind can take it before
the server does, and `anti-slop/no-port-probe` rejects such a probe in journey code.

## `startDisposablePostgres`

Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.

```ts
startDisposablePostgres(options: DisposablePostgresOptions = {}): Promise<DisposablePostgres>
```

- Inputs: `options: DisposablePostgresOptions = {}`
- Output: `Promise<DisposablePostgres>`
- Errors: none
- Throws: Rejects with an `Error` that carries the server log, when `initdb`, the server, or `createdb` fails, or when the server accepts no connection within 60 seconds. It removes the cluster first.
- Requirements: none
- Side effects: Creates the cluster directory, starts the server and its sentinel, and binds a loopback port and a Unix socket until `stop`.
- Source: [tools/postgres/index.ts:525](../../tools/postgres/index.ts#L525)

**How it works**

It runs `initdb` in a new directory and starts `postgres` on the port of `options.port`, or on
one that it reserves as `reserveLoopbackPorts` does. It resolves once `pg_isready` reports that
the server accepts connections, and `options.database` exists when it names one. The cluster
carries its address and `url`, `createDatabase`, `outage`, which stops and restarts the server
around a callback, and `unexpectedExit`. `stop` removes the cluster, and a sentinel in its own
session removes it when this process exits without `stop`, also on a signal or SIGKILL.

**Use**

```ts
const postgres = await startDisposablePostgres({ port: postgresPort, database: "journey" });
```

**Avoid**

Running `initdb`, `pg_ctl`, `postgres`, or `createdb` yourself, or taking an open port
for readiness: a server that starts up answers on its port and rejects every session.
`anti-slop/no-hand-rolled-postgres` rejects the cluster programs outside this construct.

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
- Throws: Rejects when the cluster does not start, as `startDisposablePostgres` rejects, and with the failure of `use`.
- Requirements: none
- Side effects: Starts and removes a disposable cluster, as `startDisposablePostgres` does.
- Source: [tools/postgres/index.ts:755](../../tools/postgres/index.ts#L755)

**How it works**

`use` receives the connection URL of `database` as a `Redacted` value, so a log of it shows no
URL. The cluster stops in a `finally`, so the promise settles as `use` settled, after the
cluster is gone.

**Use**

```ts
void withDisposablePostgres("rule_reconciliation_proof", (databaseUrl) => Effect.runPromise(program(databaseUrl)));
```

**Avoid**

Starting a cluster without a `finally` that stops it: a failed assertion leaves the
cluster running until the process exits. Scope the cluster to `use`.
