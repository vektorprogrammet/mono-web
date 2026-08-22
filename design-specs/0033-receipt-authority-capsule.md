# Design spec 0033 - Receipt authority capsule

> **Summary:** An assistant submits a receipt. An authorized economy approver refunds or rejects it. One native Economy authority owns every accepted Receipt transition, its durable effects, and its user-visible projections. A deterministic importer moves accepted legacy facts and quarantines every invalid or ambiguous row. Current pending edit and delete behavior enters only after the domain model records its laws.

## Metadata

| Field | Value |
|---|---|
| Goal | First complete native authority capsule candidate |
| Lifecycle state | Frozen and accepted for local implementation; not accepted for production access or cutover |
| Capsule | Actor x Economy x Receipt lifecycle x Receipt durable edges |
| Dependency | ADR 0004; ADR 0005; accepted Receipt journey; semantic identity map; migration ledger; measured Receipt closure |
| Source authority | Legacy production snapshot plus named file inventory; legacy stays read-only |
| Target runtime | Effect v4 program behind protocol adapters |
| Durable authority | PostgreSQL through a semantic persistence Service |
| File authority | Private object store through a semantic file Service; R2 remains an unauthorized provider proposal |
| Cutover authority | Operator-owned route and writer cutover plan |

## 1. Goal

Build one vertical Receipt capability that can replace all Receipt writers without split authority.

The slice includes these user actions:

1. An assistant submits a receipt with a positive NOK amount, date, description, payment-account snapshot, and file.
2. The owner changes a pending receipt and can replace its file.
3. The owner withdraws a pending receipt into an immutable terminal state.
4. An authorized economy approver refunds or rejects a pending receipt.
5. The assistant and approver read projections derived from the same authority.

The slice also includes the migration and effect closure that those actions require.

## 2. Non-goals

This slice does not:

- migrate another bounded context;
- replace account authentication;
- use Symfony routes or Doctrine entities as the native domain model;
- preserve a legacy security defect as intended behavior;
- send a real email, Slack message, or provider request before operator authority;
- read or change production data without operator authority;
- deploy, publish, change DNS, or cut over routes;
- select Cloudflare topology merely because the program can run there;
- prove all legacy retirement gates.

## 3. Source evidence

The following sources define or reveal the current closure:

| Source | Evidence |
|---|---|
| `docs/domain-model.md`, Receipt machine | `Pending -> Refunded` and `Pending -> Rejected`; terminal states absorb; amount is positive; a file is required; submission time is immutable; visual ID is unique by construction. |
| `docs/domain-model.md`, bounded-context map | Economy owns Receipt. Department is an explicit tenancy edge. Person survives Account deletion. |
| `docs/decisions/0004-authority-capsule-native-migration.md` | `Update` is the only transition authority. State, command receipt, and outbox commit together. Import is total. Cutover has one writer. |
| `docs/decisions/0003-capability-service-migration-seam.md` | The named seams are Assistant x Economy x SubmitReceipt and Approver x Economy x ResolveReceipt. The complete transitive effect closure is part of the capability. |
| `mono-web/apps/server/src/App/Operations/Api/State/ReceiptCreateProcessor.php` | Current submit can upload a file, write Doctrine state, and dispatch a created event. |
| `mono-web/apps/server/src/App/Operations/Api/State/ReceiptEditProcessor.php` | Current edit deletes and replaces files outside one database transaction. |
| `mono-web/apps/server/src/App/Operations/Api/State/ReceiptDeleteProcessor.php` | Current delete changes both file and database state. |
| `mono-web/apps/server/src/App/Operations/Api/State/AdminReceiptStatusProcessor.php` | Current resolve derives department access, changes status, sets refund time, and dispatches effects. |
| `mono-web/apps/server/src/App/Operations/Controller/ReceiptController.php` | Twig routes are independent writers for create, edit, status, and delete. |
| `mono-web/apps/server/src/App/Operations/Infrastructure/Subscriber/ReceiptSubscriber.php` | Receipt events cause economy email, owner email, logging, and flash observations. |
| `mono-web/apps/server/src/App/Admission/Infrastructure/EmailSender.php` | Receipt mail can contain account number, owner data, amount, dates, description, visual ID, and a file URL. |
| `mono-web/apps/server/src/App/Support/Infrastructure/FileUploader.php` | Current file authority is a local folder and absolute paths. File operations are not transactionally coupled to Doctrine. |
| `mono-web/packages/sdk/src/domains/receipts.ts` | Current SDK paths and multipart methods drift from the canonical API resources. |

Route existence is evidence of a call site. It is not proof of lawful behavior.

## 4. Semantic boundary

```text
Authenticated command + explicit actor scope + expected revision
                              |
                              v
                   Economy Receipt Update
                       /             \
              typed rejection     accepted decision
                                      |
                              one DB transaction
                +---------------------+--------------------+
                |                     |                    |
           Receipt state        command receipt       durable outbox
                |                                          |
                v                                          v
        deterministic views                       effect interpreters
        personal / approver                  file / mail / audit-log
```

Protocol adapters decode commands and encode observations. They do not decide transitions.

## 5. Authoritative model

### 5.1 Receipt state

A Receipt has:

- opaque `ReceiptId`;
- immutable owner `PersonId`;
- immutable scope `DepartmentId`;
- unique `VisualId`;
- positive `Money` in integer øre and currency `NOK`;
- non-empty description with at most 5,000 characters;
- receipt date;
- immutable submission time;
- `Pending`, `Refunded`, `Rejected`, or `Withdrawn` status;
- refund time only for `Refunded`;
- immutable encrypted payment-account snapshot;
- one current private `ReceiptFileRef`;
- revision for conditional updates.

The implementation must not use floating-point money.

### 5.2 Messages

| Message | Actor | Accepted transition |
|---|---|---|
| `SubmitReceipt` | Active assistant in an explicit department | No receipt -> `Pending` |
| `RevisePendingReceipt` | Receipt owner | `Pending` -> changed `Pending`; increment revision |
| `WithdrawPendingReceipt` | Receipt owner | `Pending` -> `Withdrawn`; increment revision |
| `ResolveReceipt.Refund` | Economy approver in Receipt scope | `Pending` -> `Refunded`; set refund time |
| `ResolveReceipt.Reject` | Economy approver in Receipt scope | `Pending` -> `Rejected` |

Department approvers act only in their department. A global Economy approver acts across departments. Terminal states cannot reopen. A rejected expense is resubmitted as a new Receipt.

A retry with the same command ID and the same canonical command returns the stored observation. The same command ID with different bytes is rejected.

### 5.3 Rejections

The model returns typed rejections for:

- unauthenticated actor;
- inactive actor;
- actor outside the department scope;
- owner mismatch;
- missing receipt;
- stale revision;
- invalid amount, description, date, or file reference;
- transition from a terminal state;
- command replay with different content;
- unavailable durable authority.

`Rejected -> Pending`, status self-transitions, and arbitrary status setters are not lawful native transitions.

## 6. Durable edges

One transaction commits:

1. Receipt state or the withdrawal fact;
2. the exact command receipt and returned observation;
3. immutable outbox requests;
4. revision and audit provenance.

The minimum outbox effects are:

- receipt-submitted economy notification;
- receipt-refunded owner notification;
- receipt-rejected owner notification;
- receipt audit-log record;
- file promote, replacement, or deletion work where the selected file protocol requires it.

Session flash messages are adapter observations. They are not durable domain effects.

The file design must make these states unrepresentable or recoverable by construction:

- committed Receipt points to a missing file;
- failed replacement deletes the current file;
- failed withdrawal leaves an unowned file forever;
- one retry duplicates a file or notification.

## 7. Import and reconciliation

The importer is a total function:

```text
LegacyReceiptRow + identity map + file inventory
  -> NativeReceiptFact
   | QuarantinedLegacyReceipt
```

Each result records:

- source repository and revision;
- snapshot identity, source primary key, and recorded source watermark;
- source row digest;
- transformation revision;
- stable target semantic identity;
- destination identity;
- accepted fact or explicit quarantine reason;
- per-row reconciliation result.

The importer preserves accepted source values. It never sends notifications.

It quarantines at least:

- unresolved owner or Person mapping;
- missing or ambiguous Department mapping;
- missing or duplicate visual ID;
- invalid, non-positive, or imprecise amount;
- invalid or oversized description;
- missing or contradictory dates;
- unknown status;
- status and refund-time contradiction;
- missing, unsafe, unreadable, or unsupported file;
- source identity collision;
- historical fact that cannot be represented without invention.

No default value, coercion, guessed department, or silently dropped row can pass import.

## 8. Projections and adapters

The authority derives:

- assistant receipt list;
- approver department-scoped list;
- status totals and refund statistics needed by accepted consumers;
- one fresh command observation for each accepted write.

The canonical SDK exposes messages, observations, and typed rejections. It does not expose Symfony route shapes or Doctrine status setters.

HTTP, RPC, SSR actions, and CLI import are adapters over the same program.

## 9. Cutover boundary

Native writer activation is not safe while any old writer can mutate the same Receipt edge family.

The cutover plan must account for:

- API create, edit, delete, and admin status processors;
- Twig create, edit, admin edit, status, and delete actions;
- user/account deletion cascades;
- local receipt-file writes and deletes;
- every SDK and browser consumer;
- read projections, statistics, and widgets;
- event subscribers and provider effects.

Cutover order:

1. take an operator-approved consistent source snapshot and record its watermark, preferably a binlog position;
2. run import and quarantine;
3. resolve every quarantine with accepted intent;
4. run native shadow reads and compare projections;
5. freeze every bounded legacy writer;
6. import the final delta from the recorded watermark and reconcile;
7. activate one native writer;
8. route every consumer to canonical adapters;
9. prove accepted journeys and effects;
10. retain legacy rows read-only for audit;
11. retire old routes only with operator authority.

There is no normal dual-write phase.

## 10. Delivery sequence

### Tracer bullet

Use disposable PostgreSQL with the accepted schema and recording-only file, mail, and audit interpreters. Make no provider call.

The tracer bullet must demonstrate:

1. runtime decoding of `SubmitReceipt`;
2. one accepted submission;
3. one invalid-amount rejection;
4. one authorized refund;
5. one unauthorized-scope rejection;
6. state, command receipt, and outbox in one transaction;
7. deterministic assistant and approver projections;
8. one exact-command retry with no duplicate state or effects;
9. one conflicting replay rejection;
10. one imported row and one quarantined row with provenance;
11. one accepted revision and one accepted withdrawal;
12. one terminal-state rejection.

### Expansion

After the tracer bullet passes:

1. add conditional-write concurrency proof;
2. add the private file protocol and failure recovery;
3. add real SDK and dashboard adapters;
4. add sanitized production-shaped import evidence under operator authority;
5. add provider interpreters only through separate accepted decisions;
6. prepare the operator-owned cutover packet.

## 11. Verification

The slice requires:

- property tests for every state law and replay invariant;
- database integration tests for transaction rollback, unique keys, checks, and conditional writes;
- import fixtures for every quarantine class;
- deterministic reconciliation output from repeated runs;
- fault injection at every file, database, mail, and audit boundary;
- browser journeys for assistant submit and approver refund/reject, plus revise/withdraw only after their domain laws are accepted;
- one exact revision evidence receipt per accepted journey;
- independent review of the complete durable and effect closure;
- a clean-checkout project gate at the exact candidate revision.

Tests must use user-visible observations and durable facts. They must not assert source text.

## 12. Falsifiers

The slice is not complete if any condition is true:

- two writers can change one Receipt edge family;
- a route or UI control owns a business transition;
- a terminal Receipt can reopen or change status;
- two concurrent resolves both succeed;
- money uses a floating-point representation;
- a retry duplicates state, files, mail, or audit effects;
- state commits without its command receipt or required outbox requests;
- a committed Receipt has no recoverable file;
- import guesses, coerces, drops, or sends an effect;
- Department scope is inferred from a mutable field-of-study relation without accepted policy;
- account deletion removes Person or Receipt history;
- a provider call occurs without operator authority;
- a browser passes against a fixture while the real adapter remains unproved;
- a legacy writer remains active after native cutover;
- rollback requires reconstructing overwritten source data.

## 13. Accepted decisions and external authority

ADR 0005 accepts the Receipt transition laws, Economy approval scope, NOK minor-unit representation, immutable encrypted payment-account snapshot, file quarantine policy, terminal rejected state, PostgreSQL authority, and private object-store boundary.

The operator must separately authorize:

- production snapshot access;
- secrets and provider credentials;
- provider resource creation;
- deployment and route mutation;
- bounded write freeze and cutover;
- legacy route retirement.
