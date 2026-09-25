# Substitutes developer guide

## Purpose and ownership

Substitutes owns the admission-backed substitute pool, weekday preferences, language preference, and the canonical application year of study.
[The intended system](../../../../docs/system.md) owns business meaning.
[The architecture](../../../../docs/architecture.md#ownership) owns dependency direction.

The pool entry identifies an application, not an assignment or a school-service outcome.
[Placements](../../../placements/README.md) owns affiliation, assignments, absence, offers, responses, acknowledgements, attendance, and dated service decisions.
Its coverage query joins an active pool entry through the application and applicant account link to a Person.
It also checks scope, active affiliation, weekday availability, and assignment conflicts.
Pool activation alone does not establish coverage or attendance.

Substitutes does not own authentication, transport preconditions, response receipts, or notification delivery.
It does not add a second coverage lifecycle.

## Use it

The existing export maps define two supported imports:

- `@vektorprogrammet/domain/substitutes`: schemas, decisions, failures, and the `Substitutes` service key.
- `@vektorprogrammet/database/substitutes`: the `SubstitutesLive` database Layer.

Low-level query, lock, and mutation helpers are private implementation details.
Consumers must not import `postgres.ts` or write its tables directly.
The [public service declaration](service.ts) records method guarantees, typed failures, and callback requirements.
The [schemas](schema.ts) define accepted values and results.
The [HTTP contract](../../../http-api/src/substitutes.ts) remains the transport reference.

### Run the executable example

Use the repository's declared Bun toolchain and frozen dependencies.
From the repository root, run:

```bash
bun run --cwd packages/database check-types
bun run packages/database/src/substitutes/examples.ts
```

The [example](../../../database/src/substitutes/examples.ts) uses only supported imports.
It composes the real Layer with a disposable PGlite database.
It reads an empty pool for a known semester without an admission period.
It then checks `scope.invalid` for an unknown semester.

The linked file is the executable source; this guide does not duplicate its implementation.

The example requires no credentials, browser, PostgreSQL process, or provider.
It demonstrates composition and query behavior, not authenticated authority or PostgreSQL concurrency.
The synthetic scope does not authenticate a person.
An HTTP caller must resolve current authority before reading that scope.

This guide uses the accepted module-guide structure and links to the exact executable source.
It does not introduce a documentation website, generator, or parallel API inventory.

## Contract

`SubstitutesLive` captures the caller's `Database` during Layer acquisition.
The public operations therefore do not request `Database` again.
A command's precondition callback retains its own Effect requirements and typed failures.
An Effect requirement grants no authority.

| Concern              | Guarantee and caller responsibility                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Read authority       | The caller authenticates and authorizes each read in its current snapshot.                                       |
| Candidate visibility | `readPool` includes inactive candidates. The transport omits them for read-only members.                         |
| Entry visibility     | The caller restricts inactive entry reads to managers.                                                           |
| Command authority    | Resolve current authority inside the committing transaction, before receipt lookup or replay.                    |
| Preconditions        | `execute` supplies the locked, fresh entry to the transport callback before the domain decision.                 |
| Atomicity            | Preferences, canonical application changes, and the response receipt share the caller's transaction.             |
| Success              | The returned entry precedes caller commit. It is not an offer, acknowledgement, or attendance record.            |
| Domain failure       | `SubstituteFailure` preserves the existing code and status. Correct the command or scope before another attempt. |
| Persistence failure  | `SubstitutePersistenceError` distinguishes transaction conflicts from internal failures. Keep its cause private. |

The [HTTP adapter](../../../../apps/backend/src/substitutes/http.ts) is the production composition example.
Its ETag represents the whole joined entry, not only the preference revision.
A canonical name or application-year change can therefore invalidate an old command.
The transport retains `If-Match`, idempotency identity, conditional reads, and stored response replay.
The service does not interpret HTTP headers.

## Compose it

The example merges `DatabaseTest()` with `SubstitutesLive.pipe(Layer.provide(database))`.
Production uses the same pattern with the shared database Layer in [backend composition](../../../../apps/backend/src/main.ts).

A command caller must keep authentication, current authorization, receipt preparation, execution, and receipt completion inside one transaction.
A successful read or cached authority result cannot authorize a later command.
Use the existing [HTTP transaction owner](../../../../apps/backend/src/http-api/receipt-transaction.ts) rather than a second receipt protocol.

The service acquires no pool, port, worker, or transaction of its own.
The database Layer owns acquisition and release.
The example's `Effect.provide` scope releases PGlite, and its `finally` block removes signal listeners.
Abrupt process termination does not run JavaScript finalizers.

## How it works

```text
caller transaction: current authority -> receipt lookup
  -> Substitutes: application row lock -> fresh canonical entry
    -> transport precondition -> domain transition decision
    -> preference write + canonical application write -> returned entry
  -> response receipt -> commit
```

The [domain policy](policy.ts) owns legal command rejection.
Fresh activation rejects an active entry.
Edit and deactivation reject an inactive entry.
Deactivation preserves preferences and the application.
Activation and edit update the application year, not the applicant profile year.

The [service implementation](../../../database/src/substitutes/service.ts) owns the complete command sequence and pool selection.
The [database adapter](../../../database/src/substitutes/postgres.ts) owns SQL projections, ordering, joins, codecs, and locks.
Its `SqlSchema` requests and results reuse the domain field schemas.
No HTTP caller assembles lock, read, and mutation steps.

### Retry and interruption

Substitutes installs no retry policy and performs no provider I/O.
The existing transport transaction owner retains its current conflict behavior.
A caller must resolve authority again after a rollback, not reuse the previous result.

An interruption does not prove that a command failed to commit.
If a response is missing, use the same transport command identity to resolve the uncertain outcome.
Do not create a new identity merely because a response did not arrive.

### Coverage and delivery

Placements consumes the pool through its existing eligibility query.
An addressed Person accepts an offer; a coordinator then acknowledges coverage.
Neither action records attendance or completes the commitment.
The coordinator records actual attendees and a service decision separately.
A covered absence closure references that decision's occurrence and the coverage acknowledgement.

The [Placements dispatch worker](../../../../apps/backend/src/placements/dispatch-notification.ts) owns notification attempts and recovery.
A failed notification does not roll back a committed offer.
Delivery success is distinct from acceptance and attendance.
Local loopback recovery does not prove delivery through a real provider.

## Change and check it

For a command change, update the schema, domain decision, and complete service operation together.
For a query change, preserve canonical joins, inactive-entry concealment, and the full-entry ETag contract.
For a new runtime, supply the service from that runtime's existing database Layer.

Run the focused transaction checks:

```bash
bun run --cwd packages/database vitest run src/substitutes/service.test.ts --no-file-parallelism --maxWorkers=1
```

They defend precondition ordering, callback failure propagation, caller rollback, legal transitions, and canonical application ownership.
Each case initializes its own business state.
These PGlite checks do not prove PostgreSQL lock contention or HTTP authority.

Run the existing continuous browser gate with PostgreSQL and Chromium available:

```bash
bun run tools/e2e/placement-check.ts --golden-school-service
```

The gate requires committed, clean source and disposable local resources.
Its source-owned checkpoints first preserve the ordinary school-service journey.
They then activate, edit, deactivate, and reactivate the linked candidate through pool controls.
The same journey observes eligibility changes, assignment conflict, wrong recipient, stale commands, and notification recovery.
It ends with acceptance, coordinator acknowledgement, actual substitute attendance, occurrence-linked closure, and a fresh read.
An independent PostgreSQL connection checks persisted facts after each checkpoint.
The runner records source-bound receipts and removes owned processes, database storage, and credential manifests.
See the [functional testing guide](../../../../docs/web-system-functional-testing.md#local-school-service-gate) for evidence limits and fail-closed controls.
