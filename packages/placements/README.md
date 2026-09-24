# Placements developer guide

Placements owns volunteer affiliation, school placement, demand, rosters, and dated school-service commands.
This guide serves consumers of the package and maintainers of its implementation.
The [module documentation roadmap](../../docs/module-developer-documentation.md) defines the documentation contract.

## Purpose and ownership

The [intended system](../../docs/system.md#school-demand-and-placement) owns business meaning.
Its [dated service rules](../../docs/system.md#dated-school-service) define valid outcomes.
The [architecture](../../docs/architecture.md#ownership) owns dependency direction and runtime responsibilities.

Placements does not own sign-in, HTTP preconditions, HTTP response receipts, or provider configuration.
The server entry point also exposes reviewed assignment-import helpers.
Those helpers are migration tools, not a shortcut for ordinary user commands.
The reference lists them because the export map exposes them, not because this guide authorizes a migration.

The [package manifest](package.json) owns supported imports:

- `@vektorprogrammet/placements/contracts`: portable schemas, decisions, failures, and the service key.
- `@vektorprogrammet/placements/server`: database-backed composition, delivery operations, and cohort import.

There is no supported package-root import.
Private source links explain implementation. They do not authorize private imports or direct table integration.

## Use it

### Prerequisites

Use the toolchain from the [root manifest](../../package.json) and lockfile.
From the repository root, install dependencies with `bun install --frozen-lockfile`.
The commands below run from that root.
They need no credentials, external provider, PostgreSQL server, browser, or E2E CI branch.

### Run the examples

1. Run the application compiler check:

   ```bash
   bun run --cwd packages/placements check-types
   ```

2. Run both executable examples:

   ```bash
   bun run --cwd packages/placements docs:examples
   ```

The first example prints `Absent -> Pending; repeated Request rejected; Withdraw -> Inactive`.
It checks a legal transition, a rejected repeat, and recovery through withdrawal.
The helper returns `null` for a rejected transition. It does not write state or grant authority.

The second example prints `Empty scopes read; unknown department rejected with scope.invalid (422)`.
It composes the real Placements Layer with an empty, disposable PGlite database.
It checks a successful scope read and a typed failure for an unknown department.
A caller must select an existing scope before another attempt. Another attempt with the same missing scope does not recover it.

The following inclusions render the exact executable files.
In a Markdown source viewer, open [affiliation.ts](examples/affiliation.ts) and [read-scopes.ts](examples/read-scopes.ts).

{@includeCode ./examples/affiliation.ts}

{@includeCode ./examples/read-scopes.ts}

These examples do not prove HTTP authorization, PostgreSQL concurrency, business-write atomicity, or real-provider delivery.
The synthetic authority does not authenticate a real person.
PGlite evidence is embedded-database composition evidence, not production database acceptance.

### Generate the guide and API reference

Choose a new output directory outside the repository:

```bash
bun run --cwd packages/placements docs:generate /tmp/placements-guide
bun run --cwd packages/placements docs:check /tmp/placements-guide
```

Open `/tmp/placements-guide/index.html` in a local browser.
The generated navigation contains `contracts` and `server` modules, with signatures, source comments, and links to their declarations.
The reference contains only declarations reachable through the package export map.
It does not present private adapters as entry points.

Source links in generated HTML open raw file copies.
Markdown heading fragments work in repository viewers, not in the browser view of a raw Markdown file.
For a linked business rule, find its named heading in that source.

Generation refuses an existing output directory.
On failure, generation removes its new partial output directory.
The freshness check renders into a temporary directory and compares every generated file without changing the supplied output.
A stale or missing output causes a nonzero exit.
After a source change, generate into another new directory.
Generated output is local and untracked. No hosted documentation website is necessary.

## Contract

The [public service declaration](src/service.ts) owns API-specific guarantees and typed dependencies.
The generated `PlacementsOperations` reference renders those comments directly.
The [schemas](src/schema.ts) own accepted values and results.
The [policy declarations](src/policy.ts) own decision functions and failure codes.
This guide explains their relationship without maintaining a second signature list.

`PlacementsLive` captures `Database` when the Layer acquires its service.
Service operations therefore do not request `Database` again in their public requirements.
The precondition callback can add its own Effect requirements and typed failures.
An Effect requirement expresses composition, not permission to act for a person.

| Caller concern      | Contract and response                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority           | The caller authenticates and authorizes each operation. The service key is not an authority token.                                          |
| Command identity    | The transport derives `commandId` from its receipt identity. An arbitrary identifier does not provide HTTP replay protection.               |
| Precondition        | The callback compares the locked snapshot with the caller's transport precondition. It does not grant authority or perform business writes. |
| Domain rejection    | `PlacementFailure` supplies a tagged failure, code, and status. The caller corrects the relevant scope or command before another attempt.   |
| Persistence failure | `PlacementPersistenceError` distinguishes transaction conflicts from internal errors. Its cause stays internal.                             |
| Success             | `execute` returns a snapshot within the caller's transaction. This is not yet a commit or a provider acknowledgement.                       |

The [HTTP adapter](../../apps/backend/src/placements/http.ts) shows the complete production call boundary.
It resolves current authority and receipt identity before the service executes.
It evaluates the ETag precondition under the department lock.
A read preflight or a successful pure policy calculation does not replace this boundary.

## Compose it

The executable read example shows the minimum server Layer composition through public imports.
`DatabaseTest` owns its in-memory database, canonical migrations, and release finalizer.
`Effect.provide` scopes that Layer to the program.
The signal handler requests interruption. The `finally` block removes only the example's signal listeners.
No database directory, port, child process, credential, or provider request belongs to these examples.
Abrupt process termination, such as `SIGKILL`, does not run JavaScript finalizers.

Production composition differs from this fixture:

- [Database Layers](../database/src/layers.ts) supply the adapter and run migrations.
- [Backend composition](../../apps/backend/src/main.ts) shares the database Layer and supervises workers.
- [HTTP command transactions](../../apps/backend/src/http-api/receipt-transaction.ts) own authority preparation, receipt lookup, replay, and transaction completion.
- [Notification worker](../../apps/backend/src/placements/notification.ts) supplies the roster interpreter and recovery schedule.
- [Dispatch worker](../../apps/backend/src/placements/dispatch-notification.ts) supplies the dispatch interpreter and recovery schedule.

A new server caller must preserve those responsibilities rather than call `execute` without an authorized transaction.
The read example deliberately performs no mutation and requires no synthetic command receipt.

## How it works

```text
HTTP caller: current authority + receipt identity
  -> caller transaction and receipt lookup
    -> Placements: department lock
      -> snapshot -> transport precondition -> transition
      -> business facts + audit/history + required outbox work
    -> response receipt -> commit
  -> worker claim transaction -> interpreter -> delivery acknowledgement
```

The [service implementation](src/server/service.ts) chooses the mutation path and holds the department lock.
The [placement adapter](src/server/postgres.ts) and [coverage adapter](src/server/coverage.ts) implement reads and durable transitions.
Their table layouts are private implementation details.

The department lock keeps the checked snapshot and subsequent transition within one serialized department operation.
The caller transaction keeps business facts, audit/history, required notifications, and the response receipt together.
The [service checks](src/server/service.test.ts) cover rejected preconditions and rollback when the caller cannot finish its receipt.
The guide does not replace these behavioral checks with source-text assertions.

### Retry and interruption

The Placements service does not install a retry policy.
The HTTP adapter selects `serialization-once` in the [receipt transaction owner](../../apps/backend/src/http-api/receipt-transaction.ts).
That owner repeats preparation and execution after a retryable rollback, so authority must remain inside preparation.
Provider I/O must remain outside the business transaction.

The database adapter owns transaction finalization on Effect failure or interruption.
Interruption is not a guarantee that a command did not commit.
If the caller loses the response, the transport receipt protocol resolves the uncertain result.
A caller must not invent a new command identity merely because the first response is missing.

### Outbox and delivery

[Roster delivery](src/server/outbox.ts) and [dispatch delivery](src/server/dispatch-outbox.ts) claim durable work before invoking an interpreter.
They fence acknowledgement updates with the claim identity.
The worker can recover stale claims after interruption or process loss.
An interpreter can succeed before acknowledgement persists, so a later delivery attempt can repeat the external effect.
The provider boundary must handle the stable logical effect identity. These functions do not promise exactly-once external delivery.

A committed command means durable business state and required queued work.
An interpreter success means that interpreter returned successfully, not that a real provider satisfied a separate acceptance contract.
The [durable-effects rules](../../docs/system.md#durable-effects) remain authoritative.

## Change and check it

### Bounded reader exercise

An independent reader can perform these tasks without private implementation coaching:

1. Find this guide from the repository README.
2. Run the compiler and example commands in **Use it**.
3. Explain the repeated-request rejection and the missing-scope failure.
4. Generate the guide and locate `PlacementsOperations.execute` in the reference.
5. Identify the authority, transaction, and notification owners from the linked sources.

For a bounded change, use a disposable copy or a clean branch:

1. Add a sentence to the public `readOwnAffiliation` comment that clarifies its missing-department failure.
2. Run `check-types` and `docs:examples` with the commands above.
3. Run `docs:check` against the earlier output. Expect a nonzero stale-output result.
4. Generate into a new directory. Then run `docs:check` against it. Expect success.
5. Read the rendered comment beside the generated signature.
6. Restore the disposable source change. Remove only the directories from this exercise.

This exercise changes documentation, not the public API or business rules.
An agent reader is useful evidence for command completeness, but it does not prove comprehension by an unfamiliar human developer.

### Required checks and limits

| Change or failure                                        | Relevant check                                                       | Limit                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Broken public import or invalid TypeScript               | `bun run --cwd packages/placements check-types`                      | Compiler success does not prove runtime behavior.                        |
| Wrong example result or failure handling                 | `bun run --cwd packages/placements docs:examples`                    | The examples cover only their declared pure and PGlite paths.            |
| Changed declaration, comment, example, or generated file | `bun run --cwd packages/placements docs:check /tmp/placements-guide` | Freshness is not a review of explanatory meaning.                        |
| Broken guide link or API reference                       | Generation and its link validation                                   | External URL availability requires separate review.                      |
| Changed durable command behavior                         | Existing focused service checks and the golden command below         | A documentation-only change does not require another E2E implementation. |

The [local school-service gate](../../docs/web-system-functional-testing.md#local-school-service-gate) owns prerequisites for this accepted real-boundary command:

```bash
bun run test:golden-school-service
```

That command exercises real browser, HTTP, PostgreSQL, and loopback notification boundaries.
Its evidence does not establish real-provider acceptance or visual usability.
Documentation commands do not modify the golden runner.

### CI and retained artifacts

The Placements documentation job runs on main pushes and pull requests without provider credentials.
It checks the public examples with the application compiler, runs them, and generates the reference once.
TypeDoc checks guide links. The command also checks repository source paths, line numbers, and source URLs.
Local generation uses `file:` source links. CI generation uses immutable GitHub URLs with the exact source revision.
Inherited dependency signatures do not receive false repository source links.
CI artifacts include only generated files and tracked public files copied by TypeDoc.
Includes and copied media cannot traverse symlinks or read untracked or hidden paths.

From a clean checkout, run the CI command:

```bash
export PLACEMENTS_DOCS_EXPECTED_REVISION="$(git rev-parse HEAD)"
bun run --cwd packages/placements docs:ci /tmp/placements-ci-guide
```

Before you consume a retained CI artifact, check it against the expected checkout revision:

```bash
bun run --cwd packages/placements docs:accept /tmp/placements-ci-guide
```

Supply the expected revision from the checkout or trusted workflow, never from the artifact receipt.
The receipt binds complete output to that clean revision and an exact SHA-256 file inventory, including copied media.
The consumer rejects missing output, changed files, extra files, symlinks, incomplete receipts, dirty source, and revision drift.
This check does not regenerate documentation. A changed guide, example, or source commit rejects an earlier artifact.
The receipt is not a signature. Use artifacts from a trusted workflow; rewriting both files and receipt can defeat content hashes.

Use `docs:check` for retained **local** output from `docs:generate`, including uncommitted documentation edits.
It renders current source into a temporary directory and compares the full file inventory and content.
Local and CI artifacts have different source links and are not interchangeable.
Local checks do not prove hosted execution, artifact-service acceptance, branch-protection configuration, or remote URL availability.
The job can serve as a required check, but repository administrators must configure that policy separately.

### Tool choice

The [documentation tool manifest](../../tools/system-guide/package.json) pins TypeDoc and its compatible documentation-only TypeScript compiler.
The application and example compiler remains the version in the Placements manifest.
The separate parser compiler is not an application type-check substitute.

The bounded Effect docgen qualification used `@effect/docgen` 0.5.2 against the actual package sources and TypeScript 7.0.2.
Its installation reported an unsupported TypeScript peer range.
With version enforcement disabled, extraction failed on 26 undocumented barrel reexports.
This result does not establish that every docgen feature is incompatible with the runtime.
The pilot avoids duplicate barrel documentation and uses TypeDoc to follow the existing reexports instead.

TypeDoc generates the local reference, renders this guide, and includes the exact example files through its built-in include directive.
The [Placements documentation command](../../tools/system-guide/placements.ts) derives entry points from the export map and compares fresh output.
It does not parse TypeScript itself.
The existing [MDX system renderer](../../tools/system-guide/build.ts) remains unchanged for the system walkthrough.
The [HTTP generator](../http-api/scripts/generate-openapi.ts) remains the owner of HTTP reference artifacts.

## Cleanup and evidence

The examples release their embedded database on normal completion, failure, and requested interruption.
The freshness command removes its own temporary render directory in a `finally` block.
On SIGINT or SIGTERM, the documentation command finishes its current TypeDoc operation, fails, and removes its temporary output.
The CI command stops each compiler or example process group, even after its leader exits.
It allows one second after SIGTERM, then uses SIGKILL and checks removal for one more second.
A cleanup failure cannot produce successful documentation or replace the original subprocess failure.
SIGKILL of the documentation command itself cannot run this cleanup.
After successful generation, the output directory belongs to the caller. The tools never replace a pre-existing directory.
After review, remove only the generated directory that the command created for you.

Acceptance records belong outside tracked source.
A record must identify the source commit, exact tools, commands, negative checks, reader type, cleanup, and unverified boundaries.
Neither compiler success nor generated prose establishes semantic correctness.
