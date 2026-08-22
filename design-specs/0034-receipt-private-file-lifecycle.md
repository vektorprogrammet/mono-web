# Design spec 0034 - Receipt private file lifecycle

> **Summary:** A maintainer submits, revises, and withdraws Receipts against disposable PostgreSQL, drains their durable file requests through a recording private-file Service, injects an interruption, resumes delivery, and receives deterministic evidence that promotion precedes deletion, retries are idempotent, and no committed current file disappears.

## Metadata

| Field              | Value                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Goal               | Complete the local durable private-file tracer for the Receipt authority capsule                                     |
| Lifecycle state    | Frozen and accepted for local implementation; not accepted for production access or cutover                          |
| Journey            | Maintainer runs one Receipt file-lifecycle proof and reads its deterministic evidence                                |
| Dependency         | ADR 0004; ADR 0005; design spec 0033; Receipt authority implementation at `463d98c88e3ac89cbe6c4de28e449e69eca0a532` |
| Source authority   | Accepted Receipt laws and file protocol in ADR 0005                                                                  |
| Target runtime     | Effect v4 portable program plus disposable PostgreSQL and recording-only private-file interpreter                    |
| External authority | None                                                                                                                 |

## 1. Goal

Complete one local, executable Receipt file-lifecycle journey without a provider or production data:

1. stage a validated private-file identity in a recording adapter;
2. submit a Receipt and commit its promote request atomically with state, command receipt, and audit;
3. claim and deliver the durable request;
4. replay delivery without duplicating the file effect;
5. revise the pending Receipt with a replacement file;
6. prove the replacement is promoted before the prior file is deleted;
7. inject a typed delivery failure and preserve retryable durable state;
8. resume delivery and reach the same final observation as an uninterrupted run;
9. withdraw the Receipt and retain a durable deletion fact;
10. emit deterministic, schema-shaped evidence with no file bytes or payment-account plaintext.

This is a maintainer journey. It proves local protocol and persistence behavior. It does not prove a browser journey, production object storage, authorized reads, deployment, migration, or cutover.

## 2. Authority and ownership

```text
Receipt command
  -> ReceiptAuthority
       -> one PostgreSQL transaction
            state + command receipt + ordered outbox + audit

Durable outbox request
  -> Receipt file-delivery program
       -> ReceiptFileService
            recording adapter in this slice
       -> PostgreSQL delivery receipt
```

`ReceiptAuthority` remains the sole owner of Receipt state transitions. The delivery program may change only outbox delivery state. It must not change Receipt status, revision, ownership, amount, payment details, or file identity.

`ReceiptFileService` owns the semantic private-file operations. Provider SDKs and raw filesystem APIs are runtime-adapter concerns and do not enter the domain contract.

## 3. File identity

A file request carries the complete immutable identity required to prevent ambiguous promotion or deletion:

- staging reference (`fileRef`);
- committed object key (`objectKey`);
- media type;
- positive byte length;
- lowercase SHA-256 digest;
- Receipt ID, command ID, effect ID, and effect type.

For this slice, `fileRef` names the staged private object and `objectKey` names the committed private object. They must not be equal. The recording adapter contains metadata only; it never records file bytes.

Two Receipts cannot own the same committed object key or staging reference. A replacement is different when any immutable file-identity field differs. A replacement command emits, in order:

1. promote the replacement;
2. write the audit request;
3. delete the prior exact identity.

A delete request is exact-identity guarded. It is idempotent when the object is already absent. It fails closed when the object key exists with a different digest or immutable identity.

## 4. Durable delivery protocol

Each outbox row has one of these states:

```text
Pending -> Processing -> Delivered
             |
             +-> Failed -> Processing
```

A worker claim records a caller-supplied claim ID and claim instant in PostgreSQL before interpreting the effect. Claims are exclusive. A completion or failure update must match the active claim ID.

A failed delivery records a redacted typed reason and remains retryable. A separately invoked recovery operation may return an explicitly named stale claim to `Failed`; it never guesses from ambient time. The caller supplies the cutoff instant.

Effects for one command are claimable only in ordinal order. Later effects remain blocked until every earlier effect for that command is `Delivered`.

The file Service is idempotent by `effectId`. Repeating an accepted promote or delete returns the same success without a second mutation. Reusing an effect ID with different canonical request bytes fails as a conflict.

Notification and external audit requests remain recording-only in this slice. They use the same effect-ID idempotency rule so the proof can drain the complete Receipt outbox. No mail, provider, filesystem, or network call occurs.

## 5. Database conformance

Fresh and upgraded schemas must converge on the same Receipt constraints and indexes. The migration must:

- preserve one authoritative unique constraint for `(command_id, ordinal)`;
- preserve non-negative outbox ordinals on fresh and upgraded databases;
- never infer historical semantic order from effect IDs;
- reject empty domain identifiers and file identities where the semantic schema requires non-empty text;
- make committed object keys and staging references unique;
- retain the refund-state/refund-date invariant;
- decode dates and instants without depending on the session `DateStyle`;
- preserve integer øre without lossy JavaScript conversion.

Historical outbox rows without a trustworthy ordinal are a migration blocker. This slice fails rather than inventing their order.

## 6. Observable evidence

The proof emits one deterministic JSON object containing:

- contract ID `0034` and source revision;
- database kind `PostgreSQL`;
- provider, network, and production calls equal to zero;
- accepted submit, revise, withdraw, claim, deliver, fail, recover, and retry observations;
- exact ordered file events;
- current, deleted, staged, and conflicted recording-adapter identities;
- durable outbox state and attempt totals;
- concurrent command outcome totals;
- replay duplicate-effect total;
- rollback and stale-claim recovery results;
- a digest of canonical evidence.

The object excludes file bytes, payment-account plaintext, credentials, absolute paths, and raw provider errors.

Two runs from equivalent clean databases and inputs must emit identical canonical evidence except for an explicitly separated execution receipt. This proof uses caller-supplied instants and identifiers; it does not read ambient clock or randomness.

## 7. Required demonstrations

The tracer must demonstrate:

1. accepted submission commits one file promote request;
2. exact command replay creates no new state or outbox rows;
3. two concurrent uses of the same command ID produce one accepted transaction and one exact replay, or one typed conflict for different canonical bytes;
4. two concurrent resolves of one Receipt cannot both succeed;
5. replacement promotion is delivered before prior-file deletion becomes claimable;
6. injected promotion failure leaves the current file untouched;
7. stale claim recovery makes the same effect retryable;
8. repeated promotion and deletion are idempotent;
9. conflicting effect-ID reuse fails closed;
10. withdrawal records and delivers deletion without erasing the historical Receipt metadata;
11. database failure rolls back state, command receipt, outbox, and audit together;
12. migration rerun is idempotent and fresh/upgraded constraints are equivalent;
13. every import quarantine class has an observable fixture;
14. repeated reconciliation output is byte-identical.

## 8. Falsifiers

The slice is incomplete if any condition is true:

- a committed Receipt lacks its required durable file request;
- a file effect can be delivered without a durable outbox row;
- a replacement delete can run before replacement promotion succeeds;
- retry duplicates a file, notification, or audit mutation;
- a failed replacement removes the current file;
- a delete can remove a different immutable file identity;
- two workers own the same active claim;
- a later command ordinal overtakes an undelivered earlier ordinal;
- a crash leaves work permanently unclaimable;
- migration invents historical order;
- a provider-specific type enters the semantic contract;
- evidence contains file bytes, payment-account plaintext, secrets, or absolute paths;
- SQLite, D1, MySQL, or an in-memory database is used to claim PostgreSQL conformance;
- production or provider access occurs without separate operator authority.

## 9. Explicit non-goals and unresolved product decisions

This slice does not decide or implement:

- R2 or any other production object-store provider;
- provider resources, credentials, deployment, or networking;
- production data access, snapshot, import, writer freeze, route mutation, cutover, or retirement;
- browser upload or authorized file reads;
- upload size limits beyond positive byte length;
- read-token lifetime or audience;
- retention and garbage-collection windows;
- provider orphan policy;
- whether a withdrawn file is retained in production after its accepted deletion request;
- real mail or external audit delivery.

Those choices require later accepted product or operator records. This slice must not encode a default that pre-decides them.

## 10. Definition of done

The design is complete only when:

1. the semantic file Service, recording adapter, durable claimant, and proof exist;
2. the Receipt package focused tests and PostgreSQL proof pass;
3. root `check-types`, `lint`, `build`, and `test` pass from the exact candidate revision with the disposable PostgreSQL service available;
4. deterministic evidence demonstrates every required behavior in section 7;
5. an independent review finds no P0/P1 contract blocker;
6. the committed artifact is clean and contains no provider or production access.
