# Receipt developer guide

## Purpose and ownership

Receipt owns claim decisions, approval, private-file references, and evidence of external settlement through the `Economy` service.
The [expense contract](../../../../docs/system.md#expense-reimbursement) owns business meaning.
The [architecture](../../../../docs/architecture.md#domain-services) owns dependency direction.

Approval leaves a claim `Approved`. It does not prove payment.
Settlement records evidence of an external action. The program does not execute a payment.
Settlement evidence does not introduce a `Paid` lifecycle state.

[Organization](../organization/authority.ts) supplies current Person and scope facts.
The native backend owns authentication, HTTP preconditions, private storage, and delivery composition.
The database adapter owns locks, command receipts, audit, and durable outbox work.
Dashboard roles and visible controls do not grant authority.

Reviewed migration has a separate [review contract](review.ts) and [import implementation](../../../database/src/receipt/reviewed-cohort.ts).
An import creates no grants, native human audit events, notifications, or settlement evidence.
Local examples and rehearsals do not authorize production access, provider changes, deployment, or cutover.

## Use it

The package export maps define the supported receipt imports:

| Import                                        | Use                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@vektorprogrammet/domain/receipt`            | Public schemas, decisions, failures, `Economy`, `ReceiptFileService`, and `ReceiptAuxiliaryEffects`. |
| `@vektorprogrammet/database/receipt/postgres` | `EconomyLive` and the exported file-read, recovery, and reviewed-import boundaries.                  |

The [domain export map](../../package.json) and [database export map](../../../database/package.json) own these paths.
The [domain barrel](index.ts) and [database barrel](../../../database/src/receipt/postgres-index.ts) own their exact exports.
An exported recording adapter remains a test tool, not a durable storage implementation.
Consumers must not import private PostgreSQL modules or write receipt tables directly.

The [service declaration](service.ts) owns operation signatures, Effect requirements, and transaction-specific witnesses.
The [schemas](schema.ts) own amounts, dates, identities, revisions, file metadata, and settlement evidence.
The [HTTP contract](../../../http-api/src/receipts.ts) owns transport requests and responses.
Browser consumers use `@vektorprogrammet/sdk` or `@vektorprogrammet/sdk/effect`, not the database Layer.
The [SDK export map](../../../sdk/package.json) owns these generated consumer entry points.

### Run the executable example

Use the repository's declared Bun toolchain and frozen dependencies.
From the repository root, run:

```bash
bun run --cwd packages/domain check-types
bun run packages/domain/examples/receipt.ts
```

The [example](../../examples/receipt.ts) uses the supported domain entry point, Effect, and Node assertions.
The [domain compiler configuration](../../tsconfig.json) explicitly includes its directory.
The linked file is the executable source. This guide does not duplicate its code.

The example produces a Pending proposal, rejects owner approval without scope, and produces an Approved proposal for a synthetic approver.
It then rejects a stale revision and checks the public encoding for private-field omission.

`decideReceipt` returns a proposal with an observation, audit action, and requested effects.
It does not authenticate an actor, resolve current grants, commit SQL, store bytes, deliver notifications, or record settlement.
Synthetic actors exercise decision rules, not authenticated access controls.
The example uses no Service substitute and makes no persistence claim.
It requires no credentials, browser, database, provider, or temporary files.

## Contract

### Authority

An Effect requirement supplies a dependency, not permission.
An authenticated principal identifies a Person and one authorization instant. It does not carry trusted grants from the client.

[Authority resolution](../../../database/src/receipt/authority-postgres.ts) combines current Organization facts with receipt payment, approval, and settlement grants.
The [authority model](authority.ts) owns grant selection and denial behavior.
Submission requires a current payment authority. Multiple eligible departments require an explicit selection.
Approval scope does not grant settlement scope.

The owner can read their claim and private file, revise a Pending claim, or withdraw it.
A scoped approver can read the attachment and apply permitted review commands.
Finance readers and settlement writers require the separate current settlement scope.
The server conceals out-of-scope records. A missing result does not establish whether a record exists elsewhere.

The native HTTP boundary authenticates each read and binds owner identifiers to the authenticated principal.
`listOwnedReceipts` and owner evidence reads accept a Person identifier. The caller must bind that identifier to the authenticated owner.
Do not expose those arguments as arbitrary client-selected identities.

Every command resolves current authority inside the committing transaction, before replay.
`authorizeReceiptMutation` returns a witness for that transaction only.
`executeAuthorizedReceipt` cannot make a cached witness safe across transactions, retries, or requests.
Use `executeReceipt` for the complete domain transaction outside the native HTTP protocol.

### Results, privacy, and failures

A successful database command means committed business facts unless an enclosing caller transaction still owns commit.
It does not mean that file promotion or notification delivery succeeded.
The transaction result distinguishes replay from a new decision.
A replay returns the stored observation and the current receipt. These are not interchangeable snapshots.

The [public projections](projections.ts) separate owner, approver, settlement queue, and evidence views.
`Receipt.json` omits the payment-account ciphertext and private-file metadata.
Encode through the public schema. Raw `JSON.stringify(receipt)` does not enforce that omission.
Do not expose storage identities, payment ciphertext, provider secrets, or persistence causes in logs or responses.

| Failure category                                    | Caller action                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Decode or invalid transition                        | Correct the input or choose a command valid for the current state.                             |
| Stale revision or HTTP precondition                 | Read the fresh state before a new intentional command.                                         |
| Authority, owner, scope, or concealed absence       | Stop the operation. A different command identity does not grant access.                        |
| Conflicting command identity                        | Preserve the original identity and payload association. Do not reuse it for another operation. |
| Existing settlement or duplicate external reference | Reconcile the existing evidence. Do not create a second record.                                |
| Persistence or file failure                         | Preserve the cause privately and inspect the owned recovery boundary.                          |

The [failure unions](errors.ts), [file failures](file-errors.ts), and [HTTP mapping](../../../../apps/backend/src/receipt/http-problem.ts) own exact tags and statuses.
Settlement also rejects a settlement time after its recorded time.
Its immutable evidence binds the approved amount, destination fingerprint, external reference, actor, and revision.
The [settlement implementation](../../../database/src/receipt/settlement.ts) owns those checks and uniqueness rules.

## Compose it

`EconomyLive` captures `Database` during Layer acquisition.
Its business methods therefore do not request the database again.
Delivery also requires `ReceiptFileService` and `ReceiptAuxiliaryEffects` when the delivery effect runs.
The service does not own a listener, worker process, or independent connection pool.

The [native composition](../../../../apps/backend/src/main.ts) provides `EconomyLive` from the shared database Layer.
It supplies the [filesystem Layer](../../../../apps/backend/src/receipt/filesystem.ts) and [delivery Layer](../../../../apps/backend/src/receipt/delivery.ts).
The [R2 adapter](../../../../apps/backend/src/receipt/r2.ts) implements the same file-store contract for object storage but has no deployed composition.
A local native journey does not qualify object storage or a real notification provider.

The [receipt configuration](../../../../apps/backend/src/receipt/config.ts) owns file roots and intake limits.
The [backend configuration](../../../../apps/backend/src/config.ts) owns worker modes and polling.
The [delivery parser](../../../../apps/backend/src/receipt/delivery.ts) owns provider configuration and deadline validation.
The [recovery guide](../../../../docs/delivery-recovery.md#configuration) explains startup and shutdown requirements without another configuration surface.

Requests and the worker must use the same private storage roots.
Persistent roots, the database, and required secrets must survive a native process restart together.
The example does not supply encryption keys or demonstrate a durable mount.
Enabled workers require complete configuration before the listener starts.
Disabled background delivery preserves durable work. It is not a queue purge.

The native root owns worker supervision and shutdown.
It interrupts owned workers before runtime disposal and treats unexpected worker failure as a root failure.
A receipt, retry, or poll does not create a new operating-system process.
Abrupt process termination cannot guarantee JavaScript finalizers.

## How it works

```text
native command transaction
  current identity + authority -> HTTP command receipt / precondition
    -> Economy: command identity + locked state -> domain decision
    -> state + revision + domain command receipt + audit + outbox
  -> HTTP response receipt -> commit
post-commit delivery
  fenced claim -> private-file or notification interpreter -> completion
```

The [HTTP transaction owner](../../../../apps/backend/src/http-api/receipt-transaction.ts) retains response receipts and preconditions.
The [receipt HTTP commands](../../../../apps/backend/src/receipt/http-commands.ts) supply receipt-specific authority and execution.
The [database command implementation](../../../database/src/receipt/postgres.ts) preserves state, revision, command receipt, audit, and outbox in one transaction.
The [decision function](update.ts) owns legal lifecycle transitions.
HTTP responses do not replace domain command receipts.

### Files and interruption

SQL and private storage do not share a transaction.
The HTTP adapter stages accepted bytes before the business commit and queues promotion with the decision.
It removes newly created staging files when the command does not commit.
After commit, failed promotion remains durable work rather than grounds to repeat submission.

The filesystem adapter binds separate staging and committed identities to the command, digest, media type, and byte length.
It checks content identity on replay and checks committed bytes before a read.
The HTTP boundary authorizes metadata access before private-file I/O.
Private files have no public static URL.

Replacement promotes the new file before deletion of the previous file through ordered outbox work.
Withdrawal queues deletion. Neither action makes SQL and filesystem changes atomic.
Recovery must preserve retained staging bytes until promotion completes.

The filesystem adapter retains effect-identity digests under the private committed root instead of an in-memory history.
A marker reserves an effect identity. It does not establish completion of file I/O.
An exact retry checks storage again, while a conflicting digest fails even after restart.
Retain these markers with the private bytes during backup and restore.

An interrupted response does not establish whether the command committed.
Retry the same transport command identity with the same semantic payload to resolve an uncertain outcome.
A new identity represents a new command, not recovery of the original response.
Current authority still applies to replay.

### Replay and delivery recovery

Domain replay rejects a changed payload under an existing command identity.
An exact replay does not create another business audit event or outbox request.
HTTP replay returns the retained response only after current authority passes.
A new command with an old revision remains stale. Replay does not waive that precondition.

The [outbox adapter](../../../database/src/receipt/outbox.ts) claims eligible work with a durable claim identity.
It prevents later effects on the same receipt from passing an undelivered predecessor.
Completion and failure updates require the current claim identity.
A stale owner cannot complete a replacement claim.

The notification adapter persists the first-attempt envelope before network I/O.
Retries retain that envelope and the original effect identity despite later contact or provider configuration changes.
The provider must deduplicate the idempotency key.
A successful HTTP status means provider acknowledgment, not mailbox delivery.

Receipt provider rejection, timeout, and transport failure remain retryable outcomes.
A timeout does not prove that the provider received nothing.
The worker recovers stale claims and retries retained work without another business command.
Database errors and invalid durable envelopes stop the root worker rather than fabricate delivery success.
The [receipt recovery rules](../../../../docs/delivery-recovery.md#receipt-work) distinguish this behavior from password-reset ambiguity handling.

## Resource bounds

The following sources own the limits. This guide does not duplicate their numeric values.

| Boundary           | Canonical source and behavior                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File intake        | [Receipt configuration](../../../../apps/backend/src/receipt/config.ts) owns the maximum file size. The [bounded multipart reader](../../../http-api/src/receipt-upload.ts) limits actual transfer bytes before parsing. |
| Private files      | The [filesystem adapter](../../../../apps/backend/src/receipt/filesystem.ts) bounds staging and committed reads. Native downloads materialize bounded bytes and check their digest.                                      |
| Collections        | [Pagination declarations](pagination.ts) own the page size and cursor types. The [collection methods](service.ts) return bounded pages.                                                                                  |
| Delivery ownership | The [outbox adapter](../../../database/src/receipt/outbox.ts) bounds concurrent interpreters within the runtime and fences each durable claim.                                                                           |
| Provider calls     | The [delivery parser](../../../../apps/backend/src/receipt/delivery.ts) bounds deadlines. The [HTTP transport](../../../../apps/backend/src/delivery/http.ts) propagates cancellation without an internal retry loop.    |
| Recovery           | The [worker](../../../../apps/backend/src/receipt/worker.ts) owns stale-claim recovery and retry cadence. The [request drain](../../../../apps/backend/src/receipt/outbox-drain.ts) bounds work per invocation.          |
| Processes          | The [native root](../../../../apps/backend/src/main.ts) owns the worker lifetime. The [shared pool](../../../database/src/pg-pool.ts) owns database acquisition and release.                                             |

The shared delivery permit applies within one JavaScript process, before a durable claim.
Database claim fences still apply across processes.
Stale-claim enumeration has a per-pass result bound. Later passes retain responsibility for remaining claims.

Bounded concurrency, deadlines, and work per pass do not establish a finite lifetime retry budget.
Failed receipt delivery remains eligible at the worker cadence until it succeeds or an operator changes the underlying condition.
The queue does not discard failed business effects to meet a resource limit.

`ReceiptPage` contains `items` and an optional `nextCursor`. It has no total count.
The [pagination declarations](pagination.ts) own cursor validation and encoding. The [service declaration](service.ts) owns each collection method signature.
Owner and approval pages retain newest-submission-first order. Settlement pages retain oldest-approval-first order.
The receipt identifier breaks timestamp ties. A cursor is not a saved authorization result.
Each page resolves current read authority. Separate pages do not share a database snapshot.

Approval and settlement queries scan bounded candidate batches in one snapshot until they fill an authorized page or exhaust the candidates.
They return a cursor from a visible row, not from a hidden candidate.
Hidden leading batches do not hide later authorized records or expose hidden row identities through a continuation cursor.
These queries bound candidate-row materialization and result size. They do not guarantee a constant query count or execution time.
Current authority, rules, and grant projections remain complete. Their memory use scales with configured authority records.
The [OAuth list boundary](../authz/service-principal-grants.ts) retains all applicable exact-grant evidence, not only the first grant.

To continue the collection, pass the returned cursor through the same generated operation until `nextCursor` is absent.
Keep only the current result page in the dashboard Model.
Do not replace pagination with a hidden result cap or a misleading total count.

File-effect markers and durable failed work retain history on storage. A bound on transient memory does not limit retained business history.

Bounded native transfer is not allocation-free JavaScript. Multipart parsing, file reads, hashing, and SDK downloads still allocate or materialize data.
No claim here bounds third-party internals, provider memory, or the R2 runtime.
The real journey must record process and memory observations during operation and after cleanup.

## Change and check it

For a lifecycle change, update the schema, decision, transaction, projections, HTTP contract, SDK, and dashboard callers together.
For a settlement change, preserve separate authority and immutable external evidence.
For a storage change, preserve digest checks, private access, ordered promotion, and replay after restart.
For a delivery change, preserve claim fences, predecessor order, immutable envelopes, and provider idempotency.

Keep numeric limits in their canonical declarations rather than this guide.
Do not use a schema change, a recording adapter, or a successful compile as proof of database or provider behavior.

Run the focused decision and HTTP transaction checks from the repository root:

```bash
bun run --cwd packages/domain vitest run src/receipt/update.test.ts src/receipt/update.property.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd apps/backend vitest run src/receipt/http.test.ts src/http-api/receipt-transaction.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd packages/http-api generate:check
```

The decision checks defend legal transitions and invariants. They do not resolve live authority.
The HTTP checks cover the adapter contract with their declared test dependencies, not a continuous browser journey.
The generation check detects stale transport artifacts. It does not exercise delivery.

The [functional testing guide](../../../../docs/web-system-functional-testing.md) owns local journey commands and their evidence requirements.
The [delivery recovery guide](../../../../docs/delivery-recovery.md#local-proof) owns the disposable native recovery proof.
When the shared runtime slot is available, run the heavy journey.
Its PostgreSQL, browser, private files, and loopback provider remain local resources.
Source-bound observations must connect actors, commands, database facts, and exact private bytes.
Local loopback results do not prove provider deduplication, inbox delivery, production readiness, or payment.
