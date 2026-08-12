# Live design spec 0017 — tutor D1 event-store proof

> **Summary:** One maintainer journey, implemented and proven locally on the canonical line, applies one deterministic schema migration to one disposable local Miniflare D1 binding, seeds the accepted 0014 stream, appends `InterviewConducted` as version 4 through the accepted `ConductInterview` transition, replays through the accepted pure fold, and records fail-closed duplicate, stale, race, rollback, trigger, BLOB, and replay-integrity observations. It is a local proving capsule only. It does not create a Worker, route, provider resource, remote database, production authority, or second tutor domain model. Lifecycle remains `Building` until the frozen/open one-to-one PR gate.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0017` |
| Status | `accepted` — product-lead accepted the intent on 2026-08-11 and reviewed this lifecycle/evidence revision. The implementation and local deterministic proof are complete on the canonical line; no provider, remote, production, or operator authority is granted. |
| Lifecycle | `Building` — canonical implementation and local evidence are complete, but no frozen/open one-to-one implementation PR exists; **not `Experienceable`, not `Conforming`, not `Release-ready`, and not `Operating`** |
| Base checkpoint | `a8dafe618907dfd623718802fdaf5712d55f70d4` |
| Base parent | `33c37975a9eef8628a3b88ae1cbcf2230755234f` |
| Authoring branch | `spec/0017-tutor-d1-event-store-proof` |
| Authoring worktree | `/tmp/mono-web-tutor-d1-spec-0017-20260811` |
| Accepted persistence authority | `/srv/share/projects/vektorprogrammet/docs/decisions/0002-tutor-event-log-persistence.md`; SHA-256 `94a2dbe93d353ddf98af784d3d6a66903c69631f8adc656c07f98a329491c830` |
| Accepted predecessor | 0014 accepted tracer specification and implementation at integration commit `a8dafe618907dfd623718802fdaf5712d55f70d4` |
| Independent specification review | `agent://TutorD1ProofSpecReview0017` — PASS at reviewed spec HEAD `988ed2a0600046167e9b7a6e01a6768f714c446a` |
| Product-lead acceptance | Accepted 2026-08-11 for the intent and this docs-only lifecycle/evidence revision. The product lead remains read-only to implementation and grants no external authority. |
| Implementation source candidate | `7ddca9eb18c307f7c6baf47134793eda5c299db6` (parent `d04f237b3f3ec6adb0200fca874773976460d477`) under `TutorD1ProofImpl0017`; this candidate is provenance, not the canonical authority. |
| Canonical D1 integration | `9a166a327a21924537a3a3ac23ede88619b64c98` (parent `e214c872841a90279e6525354ebe1f50232105fa`); canonical implementation paths are integrated and reviewed. |
| Canonical final head | `ab95b5d36f515d1b60945b9d77a17a7519281493` (parent `beff9154e8efb94c641b6cd6f8d65384ae0110f8`); `beff915` is the canonical provenance repair. |
| Implementation review | PASS — `agent://TutorD1AcceptanceCode0017` at the source candidate and `agent://CanonicalRepairCodeReview1718` at canonical `ab95b5d36f515d1b60945b9d77a17a7519281493`. The prior BLOCKED review of `4c79fbae8a6d734e44443b1d5a1f7115b4a5ff84` is superseded historical evidence. |
| Local deterministic evidence | PASS — `agent://CanonicalRepairRuntime1718` at canonical `ab95b5d36f515d1b60945b9d77a17a7519281493`; 23 cases, 110896 evidence bytes, SHA-256 `81d2a752d34c01e6a09e5e0f54c2d56d528a45b51551087583fb07ffa2456985`, repeated digest identical. `agent://TutorD1AcceptanceRuntime0017` recorded superseded source-candidate evidence: 23 cases, 110684 bytes, SHA-256 `e5899fb8ff687f3108c3d2211af997ddb2cc2ce80c7ebe37b58ce76649c4a909`. |
| Evidence destination | Sanitized evidence is recorded by the named runtime agents and remains destined for the Evidence section of a future frozen one-to-one PR or approved handoff; no generated evidence file is committed. |
| Current claim | Implementation and local deterministic evidence are complete and integrated at the named canonical commits. All linked blocking Drift is closed. This spec remains `Building` because no frozen/open one-to-one PR exists; it makes no `Experienceable`, `Conforming`, `Release-ready`, `Operating`, provider, remote, production, route, or operator claim. |

This file is the only artifact changed by this docs-only lifecycle/evidence revision. The implementation and runtime evidence named above already exist on the canonical line. No new implementation, package, lock, test, build, install, formatter, linter, provider, remote, data, credential, or deployment action is part of this revision.
The authoring worktree must remain clean after the spec-only commit. This revision records implementation provenance and independently observed local evidence; it does not grant implementation, provider, remote, production, or operator authority.

## 1. Authority, decision boundary, and semantic inventory

### 1.1 One normative home per fact

This spec routes facts to their authorities. It does not amend them or grant authority that they do not grant.

| Concern | Authority | Use and boundary in this spec |
|---|---|---|
| Program order, Receipt-first order, per-context persistence, and operator boundary | [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md), especially §§2–5 and 7–10; durable locator `/srv/share/projects/vektorprogrammet/docs/product-lead-charter.md` | Keeps this persistence proof separate from Worker replacement and keeps Receipt first. The charter grants no external capability. |
| Lifecycle state, capsule, evidence, and `Drift` | [`docs/agentic-development-lifecycle.md`](../../docs/agentic-development-lifecycle.md), especially §§2 and 4–12; durable locator `/srv/share/projects/vektorprogrammet/docs/agentic-development-lifecycle.md` | This spec is `Building` with implementation and local deterministic evidence complete at canonical `ab95b5d36f515d1b60945b9d77a17a7519281493`. All linked blocking Drift is closed. `Experienceable` and `Conforming` remain unavailable until a frozen/open one-to-one PR and its lifecycle gates exist. |
| Domain terms and laws | [`docs/domain-model.md`](../../docs/domain-model.md), §§1.3–1.5 and 2.1–2.2; durable locator `/srv/share/projects/vektorprogrammet/docs/domain-model.md` | Keeps `Person`, `Cycle = Department × Semester`, tutor events, `T-INT-1`, `S-INT-1`, `T-INT-2`, and `R-APP-1` in the existing domain model. This spec does not add a state machine or law. |
| Persistence decision | Accepted ADR 0002 at the exact SHA-256 in Metadata | Defines the three tables, global command ledger, stream-scoped event identity, CAS batch, replay checks, BLOB rules, remote boundary, and §9 successor cases. |
| Event envelope and pure transition contract | `design-specs/0014-tutor-event-envelope-tracer.md` and `packages/domain/src/tutor/**` at base commit `a8dafe618907dfd623718802fdaf5712d55f70d4` | Defines the closed command/event schemas, exact fixture, duplicate precedence, fold, projection, descriptor, and deterministic evidence. The D1 adapter persists these values; it does not redefine them. |
| Effect API capability | Local `/srv/share/projects/effect` source, exact beta.107 facts in §5.2 | Source inspection, not memory or a web snippet, is the API authority. The direct D1 path is `D1Client.batch`; generic transaction/journal/migrator paths are forbidden. |
| Miniflare behavior | Future local proof observation and its pinned package source/lock entry | A local observation proves only the named local binding behavior. It cannot establish remote D1, provider, production, route, or operator facts. |
| Operator authority | Operator approval and action record described by the lifecycle | None is requested or granted. No external action is allowed by this spec. |

The accepted ADR remains the architecture decision. This live spec is the one-journey successor that can later be accepted as a bounded implementation capsule. A link or source hash is provenance, not a second authority.

### 1.2 Semantic inventory

The proof must keep these meanings distinct:

| Value or operation | Semantic role | Required handling |
|---|---|---|
| Unknown `ConductInterview` input | External representation/assertion | Decode with the closed accepted 0014 schema and reject excess or malformed fields. Never cast, default, or silently drop. |
| `command_id` | One global tutor-context idempotency identity | Read `command_receipts` by this key alone before stream, version, terminal, or transition checks. Its generation format remains open; this proof uses the accepted synthetic value. |
| `(person_id, department_id, semester_year, semester_term)` | Exact `(Person, Cycle)` stream identity | Use the four columns everywhere. Do not introduce a `stream_id` surrogate or a department/semester substitute. |
| `event_id` | 0014 stream-scoped event identity | Keep the composite stream key. Do not claim or invent a global event-ID scheme. |
| `stream_version` | In-stream order authority | Require `1, 2, 3, ...` with no gap, rewind, or duplicate. |
| `envelope_bytes` | Canonical persisted event fact | Decode and re-encode exactly before fold; indexed columns must agree with the envelope. |
| `stream_heads` | Mutable CAS/order gate | Check against the folded event log. A mismatch is integrity `Drift`; `ConductInterview` never repairs it. |
| `command_receipts` | Immutable prior accepted observation | It supports idempotency and exact duplicate response. It is not domain state and never owns projection/status. |
| Pure 0014 fold | Sole projection/state owner | Fold decoded events; derive the 0014 projection and evidence from the fold. The database has no status or projection table. |
| Descriptor | Inert post-commit observation | Compute its bytes before the batch, keep it private, and expose it only after the batch commits. Never interpret or deliver it. |
| Evidence | Deterministic derived artifact | Render canonical UTF-8 bytes and SHA-256 twice from two clean identical local runs. It is a reproducibility receipt, not proof beyond its named scope. |

The event log is canonical fact. The fold is warranted derived state. Reads, receipts, and evidence are projections or observations with references back to the event transition; none becomes a second domain model.

## 2. Goal, values, constraints, and non-goals

### 2.1 Goal

Give one future maintainer one executable, deterministic, local journey that:

1. starts from the accepted 0014 synthetic stream and exact version-three head token;
2. applies one D1 schema migration without explicit transaction delimiters;
3. seeds the three accepted 0014 events and their version-three head as fixture setup, outside `ConductInterview`;
4. decodes and accepts the exact 0014 `ConductInterviewV1` command as `InterviewConducted` version 4 through one direct `D1Client.batch`;
5. reads the global command ledger before stream validation and classifies exact and changed duplicates correctly;
6. replays the four persisted envelopes through the pure accepted 0014 fold and compares the projection with the in-memory result;
7. demonstrates malformed, missing-head, head/event divergence, stale, terminal, same-version race, multi-advance race, foreign-key/unique rollback, trigger, BLOB, decoder, gap, correlation, and index-consistency failures; and
8. renders two byte-identical evidence documents with equal SHA-256 digests, including the exact local limits and no-provider boundary.

The journey must never accept a fifth event. `InterviewConducted` is terminal under 0014. Replay-only setup may load four canonical rows, but it must not claim a fifth lawful append.

### 2.2 Values

- **Accepted semantics first:** reuse 0014 schemas, event names, command identity, fold, projection, descriptor, and canonicalization. Storage is an adapter, not a new domain model.
- **One authority per meaning:** event rows own facts; the pure fold owns status/derived state; the global ledger owns idempotent prior observations; the head is an order gate checked against the log.
- **Fail closed:** malformed input, missing head, terminal transition, stale token, duplicate conflict, unknown decoder, BLOB mismatch, row/index mismatch, gap, correlation mismatch, trigger bypass, SQL surprise, or provider boundary breach stops the proof or returns the accepted typed result. It never guesses or repairs.
- **Atomic append:** the head update, event insert, and receipt insert are one D1 batch. A failed statement leaves no partial append from that batch.
- **Deterministic evidence:** no current clock, random source, ambient environment, network, credential, production row, PII, absolute path, or unbounded error text enters the evidence.
- **Disposable and reversible:** local Miniflare state is the only mutable runtime state. A failed proof deletes or discards that state and records the failure in the future PR/handoff. No remote restore or route rollback is needed.

### 2.3 Constraints

- The only semantic stream is `(PersonId, Cycle)` where `Cycle = Department × Semester`.
- The accepted 0014 sequence remains `ApplicationReceived → InterviewInvited → InterviewAccepted → InterviewConducted(scores)`.
- `ApplicationReceived` and version-zero head creation are not part of `ConductInterview`; the proof seeds the version-three state explicitly.
- `command_id` is globally unique within the tutor context. `event_id` remains stream-scoped. No global event-ID decision is made.
- Duplicate lookup is global and primary: compare canonical command bytes, not only the SHA-256 index aid.
- All append statements use numbered SQLite placeholders `?NNN`, bind arrays in the exact ADR order, and map batch result indexes `0`, `1`, and `2` without reordering.
- BLOB values are actual bytes. The adapter binds `ArrayBuffer`/`ArrayBufferView`, normalizes returned `number[]` to `Uint8Array`, rejects other runtime types, and applies fatal UTF-8 decode plus exact re-encode.
- The adapter uses `D1Client.batch` directly. It does not call `SqlClient.withTransaction`, `SqlEventJournal`, or generic `Migrator` on this beta.107 D1 path.
- Migration/import SQL omits `BEGIN TRANSACTION` and `COMMIT`; D1 implicit handling is the only permitted transaction boundary for this proof.
- Miniflare is local and disposable. No `wrangler --remote`, Alchemy, Cloudflare API, remote binding, credential, Hyperdrive, Durable Object, Worker route, production database, production data, public preview, or deployment is permitted.

### 2.4 Non-goals

This spec does not:

- implement or modify the D1 adapter, migration, local harness, package, lockfile, or any production source;
- create a D1 database, Worker, route, binding, migration table, remote resource, provider plan, deployment, credential, or operator action;
- replace Symfony/MySQL before an explicit future authority transition or create a dual-write phase;
- define stream creation, `ApplicationReceived`, version-zero head creation, global event-ID generation, global command-ID generation format, retention, archival, deletion, legal data obligations, backfill, quarantine, export/import, Time Travel, session bookmarks, remote replica consistency, or cutover;
- add a status table, projection table, receipt-derived state machine, generic event journal, outbox, effect ledger, queue, retry policy, or external descriptor interpreter;
- broaden the four-event 0014 trace to all tutor outcomes or all event types; or
- use a deployment log, code review, package install, local process banner, or narrative as event-store, domain, provider, production, route, or operator proof.

## 3. Accepted 0014 contract and exact synthetic fixture

### 3.1 Stream and event contract

The stream key is exactly:

```text
Stream = (PersonId, Cycle)
Cycle  = Department × Semester
```

Persist it as:

```text
(person_id, department_id, semester_year, semester_term)
```

The accepted event names and sequence are:

```text
v1 ApplicationReceived
v2 InterviewInvited
v3 InterviewAccepted
v4 InterviewConducted(scores)
```

`status` is a pure fold projection. It is never an event field and never a table. The only laws exercised are the accepted 0014 bounded laws: `T-INT-1`, `S-INT-1`, `T-INT-2`, and `R-APP-1`. Wider tutor events and outcomes remain successors.

### 3.2 Fixed fixture values

All values are UTF-8, synthetic, PII-free, and fixed. The future proof must not substitute current time, random IDs, generated UUIDs, environment values, or production values.

| Name | Exact value |
|---|---|
| `fixtureId` | `tutor-event-envelope-0014` |
| `personId` | `person-synth-0014` |
| `departmentId` | `department-synth-0014` |
| `semester` | `{ year: 2026, term: "Vår" }` |
| `correlationId` | `corr-0014-tutor` |
| `seed event 1` | `evt-0014-001`, `streamVersion=1`, `ApplicationReceived`, `occurredAt=2026-08-11T09:00:00Z`, `causationId=tutor-event-envelope-0014` |
| `seed event 2` | `evt-0014-002`, `streamVersion=2`, `InterviewInvited`, `occurredAt=2026-08-11T09:01:00Z`, `causationId=tutor-event-envelope-0014` |
| `seed event 3` | `evt-0014-003`, `streamVersion=3`, `InterviewAccepted`, `occurredAt=2026-08-11T09:02:00Z`, `causationId=tutor-event-envelope-0014` |
| `seed head` | exact stream tuple, `current_version=3`, `last_command_id=tutor-event-envelope-0014` |
| `accepted commandId` | `cmd-0014-conduct` |
| `accepted expectedVersion` | `3` |
| `accepted scores` | `(explanatoryPower=8, roleModel=9, suitability=7, suitableAssistant="Ja")` |
| `accepted answers` | `{ "q-0014-a": "answer-a", "q-0014-b": "answer-b" }` |
| `accepted eventId` | `evt-0014-004` |
| `accepted event type` | `InterviewConducted` |
| `accepted event version` | `4` |
| `accepted occurredAt/conductedAt` | `2026-08-11T09:03:00Z` |
| `accepted event causationId` | `cmd-0014-conduct` |
| `accepted event correlationId` | `corr-0014-tutor` |
| `malformed commandId` | `cmd-0014-malformed` |
| `stale commandId` | `cmd-0014-stale` |
| `terminal commandId` | `cmd-0014-terminal` |
| `other-stream personId` | `person-synth-0014-other` |
| `missing-head personId` | `person-synth-0017-missing-head` |
| `race command IDs` | `cmd-0017-race-a`, `cmd-0017-race-b` |
| `multi-advance command IDs` | `cmd-0017-advance-a`, `cmd-0017-advance-b` |

The first three `causationId` values are the fixture ID, so the exact seed head token is `tutor-event-envelope-0014`, not the accepted command ID. For every non-empty valid stream, the head token must equal the last event `causation_id`; this is the ADR invariant.

The exact accepted command, after closed-schema decode and canonical JSON sorting, is semantically:

```json
{
  "schemaVersion": 1,
  "commandId": "cmd-0014-conduct",
  "correlationId": "corr-0014-tutor",
  "stream": {
    "personId": "person-synth-0014",
    "cycle": {
      "departmentId": "department-synth-0014",
      "semester": { "year": 2026, "term": "Vår" }
    }
  },
  "expectedVersion": 3,
  "scores": {
    "explanatoryPower": 8,
    "roleModel": 9,
    "suitability": 7,
    "suitableAssistant": "Ja",
    "answers": { "q-0014-a": "answer-a", "q-0014-b": "answer-b" }
  }
}
```

Canonical command bytes are produced after decode by the accepted 0014 canonicalizer. The implementation compares complete bytes in `command_receipts.command_bytes`; `command_sha256` is an index aid and is not sufficient for duplicate equality.

### 3.3 Accepted result and descriptor

The accepted append produces only version 4 and the accepted 0014 projection:

```text
projectionVersion = 1
streamVersion     = 4
status            = completed
eventTypes        = [ApplicationReceived, InterviewInvited,
                     InterviewAccepted, InterviewConducted]
conductedAt       = 2026-08-11T09:03:00Z
lawRefs           = [T-INT-1, S-INT-1, T-INT-2, R-APP-1]
```

The inert descriptor is exactly the accepted 0014 shape:

```json
{
  "descriptorVersion": 1,
  "kind": "InterviewConductedDescriptor",
  "sourceEventId": "evt-0014-004",
  "causationId": "cmd-0014-conduct",
  "correlationId": "corr-0014-tutor",
  "idempotencyKey": "post-commit:evt-0014-004"
}
```

It has no destination, recipient, body, transport, provider, retry, queue, interpreter, or execution. A duplicate returns the stored descriptor as an observation; it does not create another effect request.

## 4. D1 schema migration

### 4.1 Migration identity and application

The future implementation capsule names this migration file:

```text
packages/domain/src/tutor/migrations/0001-tutor-event-store.sql
```

The stable migration ID is `0017-0001-tutor-event-store`. The exact UTF-8 SQL bytes, in the committed file order, are hashed in future evidence as `schemaHash`. The migration is applied once to the disposable local D1 binding, in the order shown below, without `BEGIN TRANSACTION` or `COMMIT`. The future writer must use the local binding operation actually exposed by the selected Miniflare version and record that operation; if it is not source-verified, stop in `Drift` rather than inventing a helper.

The following SQL is the required ADR 0002 schema. Equivalent SQLite syntax is acceptable only when the future proof establishes the same tables, type checks, primary keys, unique keys, foreign keys, trigger messages, and row behavior.

```sql
CREATE TABLE stream_heads (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  current_version INTEGER NOT NULL CHECK (current_version >= 0),
  last_command_id TEXT,
  PRIMARY KEY (person_id, department_id, semester_year, semester_term),
  CHECK (
    (current_version = 0 AND last_command_id IS NULL)
    OR (current_version > 0 AND last_command_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE tutor_events (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  event_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  event_type TEXT NOT NULL,
  envelope_bytes BLOB NOT NULL CHECK (typeof(envelope_bytes) = 'blob'),
  occurred_at TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  PRIMARY KEY (person_id, department_id, semester_year, semester_term, event_id),
  UNIQUE (person_id, department_id, semester_year, semester_term, stream_version),
  UNIQUE (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    stream_version,
    causation_id
  ),
  FOREIGN KEY (person_id, department_id, semester_year, semester_term)
    REFERENCES stream_heads (person_id, department_id, semester_year, semester_term)
) STRICT;

CREATE TABLE command_receipts (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  command_id TEXT NOT NULL,
  command_bytes BLOB NOT NULL CHECK (typeof(command_bytes) = 'blob'),
  command_sha256 TEXT NOT NULL,
  result_bytes BLOB NOT NULL CHECK (typeof(result_bytes) = 'blob'),
  descriptor_bytes BLOB NOT NULL CHECK (typeof(descriptor_bytes) = 'blob'),
  event_id TEXT NOT NULL,
  event_stream_version INTEGER NOT NULL CHECK (event_stream_version > 0),
  PRIMARY KEY (command_id),
  FOREIGN KEY (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    event_stream_version,
    command_id
  ) REFERENCES tutor_events (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    stream_version,
    causation_id
  )
) STRICT;

CREATE TRIGGER tutor_events_immutable_update
BEFORE UPDATE ON tutor_events
BEGIN
  SELECT RAISE(ABORT, 'tutor_events are immutable');
END;

CREATE TRIGGER tutor_events_immutable_delete
BEFORE DELETE ON tutor_events
BEGIN
  SELECT RAISE(ABORT, 'tutor_events are immutable');
END;

CREATE TRIGGER command_receipts_immutable_update
BEFORE UPDATE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are immutable');
END;

CREATE TRIGGER command_receipts_immutable_delete
BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are immutable');
END;
```

The schema deliberately has no status table, projection table, `stream_id` surrogate, global event-ID key, command status row, outbox, or effect ledger. `stream_heads` is mutable only through the CAS append and remains subject to the folded log checks. `tutor_events` and `command_receipts` are immutable after insertion. A head cannot be deleted while event rows reference it.

### 4.2 Constraint meanings

- `stream_heads` is the sole mutable order gate. Version zero requires a null token; every non-empty head requires a token.
- `tutor_events` keeps explicit stream columns, stream-scoped `event_id`, positive `stream_version`, positive `schema_version`, the event type, canonical complete envelope bytes, occurrence time, causation, and correlation.
- The event primary key is `(stream, event_id)`. The event unique version key is `(stream, stream_version)`. The third unique key prevents the same stream/event/version/causation tuple from being silently duplicated.
- `command_receipts.command_id` is the global tutor-context primary key. Its composite foreign key includes the command ID and points to `tutor_events.causation_id`; therefore a stale batch cannot attach a receipt to an older event that merely shares stream, event ID, and version.
- The event and receipt byte columns require SQLite `BLOB` storage. The adapter still validates runtime values and exact bytes; SQLite type checks alone are not a complete adapter proof.
- `envelope_bytes` is the canonical complete envelope. Separate indexed columns are query aids and must match the decoded envelope during replay.
- `result_bytes` is the canonical accepted observation and `descriptor_bytes` is the inert descriptor observation. Neither is domain state.

## 5. Adapter boundary and exact Effect beta.107 use

### 5.1 Owned adapter operations

The future capsule may expose a narrow tutor event-store service with these operations. Names are implementation detail; their semantics are not.

| Operation | Required behavior | Authority |
|---|---|---|
| `readStream(stream)` | Read the primary event rows in ascending `stream_version`, normalize/verify BLOBs, decode envelopes, and invoke the pure 0014 fold. Never derive status from SQL columns alone. | D1 event rows plus accepted fold |
| `findReceipt(commandId)` | Read `command_receipts` by global `command_id` alone from the primary. Return canonical command/result/descriptor bytes for comparison. | Global command ledger |
| `appendAccepted(command)` | Decode command, perform global ledger read, read head/events from primary, fold and validate, compute event/result/descriptor bytes, run exactly the three-statement batch, classify failure by a second primary ledger read, then expose observation only after commit. | Adapter plus D1 batch; domain meaning remains 0014 |

A local single D1 binding is treated as the primary for this proof. No replica, session bookmark, read cache, or read-after-write inference is used. The proof records this as a local limitation, not as remote consistency evidence.

### 5.2 Exact local Effect API facts

The future writer must re-open the local source before implementation. The observed source facts are:

- `/srv/share/projects/effect/packages/sql/d1/package.json` declares `@effect/sql-d1` version `4.0.0-beta.107`; file SHA-256 `e4e2ccecc5a7e11dd08892cd5cf7a15568a27767a51e2b7ff688e8444b98236a`.
- `/srv/share/projects/effect/packages/sql/d1/src/D1Client.ts` SHA-256 is `33d086b2b5599349e012f93241d40f079ff78d09ddea00857744217e39b8647e`.
- In that source, `D1Client.batch` is a service method returning a tuple of statement-success arrays in input order (lines 58–89). Its implementation compiles/binds each statement, calls the D1 binding's `db.batch(prepared)` directly, checks each response error, maps each response's `results || []`, and preserves index order (lines 130–188).
- The same source sets the D1 transaction acquirer to `Effect.die("transactions are not supported in D1")` (lines 315–327). Its `layer` constructor provides both `D1Client` and `SqlClient` (lines 388–402), but this proof uses the D1-specific batch method, not a generic SQL transaction.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/Statement.ts` SHA-256 is `d0217382c9cded3a4f143058461b96aecf18c0f2daedd7995e726831d7cc12f5`; the future writer must verify the beta.107 statement construction used to preserve literal numbered placeholders and bind order.
- `/srv/share/projects/effect/packages/effect/src/unstable/eventlog/SqlEventJournal.ts` SHA-256 is `e7912dad2892ce246a1143389d17b9d8277df2eb204b92c4e3808437c1d0b9a8`. Its generic schema/IDs/conflict behavior/transaction path do not implement this contract and are forbidden here.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/Migrator.ts` SHA-256 is `c94e7d36a4d253210e76e694bde656aeace439e541e503b9442e06bf95878de9`; its generic migration table and `SqlClient.withTransaction` path are forbidden here.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/SqlClient.ts` SHA-256 is `ec65f43418586cdf41c6389420da8f5b05000e88a017ddb4d77627e2b8b0ebfc`; its generic transaction surface is not a D1 capability.

These are source facts for beta.107 only. A later Effect version requires a new source review and a spec revision or explicit `Drift`; no API is inferred from a package name or remembered v3 example.

### 5.3 Strict BLOB adapter

The adapter must make the representation boundary observable and fail closed:

1. Encode canonical command, envelope, result, and descriptor JSON as UTF-8 bytes. Bind each byte value as an `ArrayBuffer` or `ArrayBufferView` accepted by the selected beta.107 statement path. Do not bind a JSON string, object, numeric array, or hash in place of bytes.
2. For a returned BLOB, accept a runtime byte representation only when the local binding actually returns one of the source-verified forms. Normalize a `number[]` whose entries are integers in `0..255` to `Uint8Array`. Normalize a returned `ArrayBuffer`/`ArrayBufferView` to a byte view without changing bytes. Reject strings, objects, arbitrary arrays, null, and any other runtime type with a typed integrity failure.
3. Decode persisted bytes with a fatal UTF-8 decoder. Re-encode the decoded value with UTF-8 and compare length and every byte to the original. A decoding error or byte mismatch is integrity `Drift`; do not fold, compare command content, or expose a receipt.
4. Compare complete canonical `command_bytes` before using `command_sha256`. A matching digest with different bytes is not an exact duplicate. A different digest is a conflict, but the implementation still preserves the complete-byte comparison evidence.
5. Verify SQLite `typeof(...) = 'blob'` for all four BLOB columns in schema/fault scenarios. A value that reaches the adapter as a string or object fails even if the database query can otherwise return it.

The proof must not silently rely on Bun `Buffer` coercion, JSON replacement characters, permissive UTF-8 decoding, or a transitive result transformer. Any source/API mismatch enters `Drift`.

## 6. Append protocol, primary reads, and batch order

### 6.1 Decode and global primary-ledger lookup

1. Decode unknown input with the closed 0014 `ConductInterviewV1` schema and excess-property error mode. Compute canonical command bytes only after decode. A malformed or excess-field command returns `DecodeError` and performs no database write.
2. Read the command ledger from the D1 primary by global command ID before reading the stream head, folding events, testing `expectedVersion`, or testing terminal state:

```sql
SELECT command_id, command_bytes, result_bytes, descriptor_bytes
FROM command_receipts
WHERE command_id = ?1;
```

The bind order is exactly `[commandId]`.

3. If a receipt exists and the complete stored `command_bytes` equal the decoded canonical bytes, return the stored observation and descriptor as an exact duplicate. This result wins even when the stream is now terminal or stale.
4. If a receipt exists and bytes differ, return `DuplicateCommandConflict` before stream validation, including when the changed command names another stream. The global command ID cannot be reused across streams.
5. Only an unseen command ID proceeds to head/event reads and pure validation.

### 6.2 Head, event read, and pure validation

Read the head from the primary with stream bind order `[personId, departmentId, semesterYear, semesterTerm]`. Read events with the exact replay query in §7. The head and event log must satisfy all of these before the batch:

- the head exists; otherwise return `EMPTY_STREAM` and write no row;
- the event rows all have the requested stream tuple;
- versions are contiguous from `1`, with no gap, duplicate, rewind, or terminal fifth event;
- event IDs are unique within the stream;
- `occurred_at` never moves backward;
- all envelopes have the accepted correlation ID and the command correlation matches the folded correlation;
- head `current_version` equals folded event count;
- for a non-empty stream, head `last_command_id` equals the last event `causation_id`;
- a version-zero head, if encountered in a future explicit stream setup, has a null token;
- `expectedVersion` equals the folded current version; and
- the transition is lawful under 0014 (`ConductInterview` only from `Accepted`, and `Conducted` is terminal).

A head/event mismatch is a typed integrity failure and lifecycle `Drift`. The append path never repairs the head or event log. A missing head is `EMPTY_STREAM`, not implicit stream creation. `ApplicationReceived` and version-zero creation remain a separate successor.

The adapter sets `expectedLastCommandId` to the last event `causation_id` and `newVersion = expectedVersion + 1`. It computes the v4 event, pure-fold projection, accepted observation, canonical result bytes, descriptor bytes, and receipt bytes before entering the batch. It keeps descriptor/result observations private until the batch commits. It reads no clock or random source.

### 6.3 Exact three-statement D1 batch

The future writer must preserve this SQL and placeholder numbering. Do not concatenate values into SQL. Do not replace `?NNN` with named placeholders.

```sql
-- Result index 0: compare and set the stream head and CAS token.
UPDATE stream_heads
SET current_version = current_version + 1,
    last_command_id = ?7
WHERE person_id = ?1
  AND department_id = ?2
  AND semester_year = ?3
  AND semester_term = ?4
  AND current_version = ?5
  AND last_command_id IS ?6
RETURNING current_version, last_command_id;

-- Result index 1: insert the event only when the new head and token exist.
INSERT INTO tutor_events (
  person_id,
  department_id,
  semester_year,
  semester_term,
  event_id,
  stream_version,
  schema_version,
  event_type,
  envelope_bytes,
  occurred_at,
  causation_id,
  correlation_id
)
SELECT
  h.person_id,
  h.department_id,
  h.semester_year,
  h.semester_term,
  ?7,
  h.current_version,
  ?8,
  ?9,
  ?10,
  ?11,
  ?6,
  ?12
FROM stream_heads AS h
WHERE h.person_id = ?1
  AND h.department_id = ?2
  AND h.semester_year = ?3
  AND h.semester_term = ?4
  AND h.current_version = ?5
  AND h.last_command_id = ?6;

-- Result index 2: the FK requires the exact event and command causation.
INSERT INTO command_receipts (
  person_id,
  department_id,
  semester_year,
  semester_term,
  command_id,
  command_bytes,
  command_sha256,
  result_bytes,
  descriptor_bytes,
  event_id,
  event_stream_version
)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);
```

The bind arrays are part of the contract:

```text
Statement 0 / head CAS:
[personId, departmentId, semesterYear, semesterTerm,
 expectedVersion, expectedLastCommandId, commandId]

Statement 1 / event INSERT...SELECT:
[personId, departmentId, semesterYear, semesterTerm,
 newVersion, commandId, eventId, schemaVersion, eventType,
 envelopeBytes, occurredAt, correlationId]

Statement 2 / receipt insert:
[personId, departmentId, semesterYear, semesterTerm,
 commandId, commandBytes, commandSha256, resultBytes,
 descriptorBytes, eventId, newVersion]
```

The adapter maps the returned tuple by position:

```text
batch result 0 → head UPDATE ... RETURNING
batch result 1 → event INSERT ... SELECT
batch result 2 → command_receipts INSERT
```

It requires result `0` to contain exactly one row with `(current_version, last_command_id) = (newVersion, commandId)`. A stale version or token returns zero rows at result `0`; result `1` then inserts no event and result `2` fails the composite event-causation foreign key, so the D1 batch must roll back. The future proof records the actual local result arrays and does not infer affected-row counts from an `INSERT` result that has no `RETURNING`; it proves row existence and count with subsequent primary reads.

If another writer wins the same version, result `0` is stale. If a fixture race advances the head beyond `newVersion`, result `1` cannot select the required head and result `2` cannot satisfy its FK. If an older event has the same stream/event ID/version but a different causation ID, the receipt FK cannot attach to it. A duplicate global receipt, duplicate stream event ID, or duplicate stream version is a real constraint failure, never success. D1 must roll back the head and all earlier statements in this batch.

### 6.4 Failed-batch classification

After any batch error, do not retry the write first. Read the global command ledger again by `command_id` from the primary:

1. Receipt exists with identical command bytes → return the stored duplicate observation.
2. Receipt exists with different command bytes → return `DuplicateCommandConflict`, even if the competing receipt names another stream.
3. No receipt → read the stream head from the primary.
4. Head missing → return `EMPTY_STREAM`.
5. Head version or last-command token differs from preflight → return `StaleState`.
6. Head still matches, no receipt exists, and SQL/constraint failure remains → surface the typed failure and enter `Drift`; never hide it as stale or success.

Evidence for every failed batch records the command-ledger read, head observation, event count, receipt count, and before/after row counts. A valid race classification may observe a competing writer's rows; the proof separately identifies those rows and demonstrates that the failed batch itself added no head/event/receipt rows.

## 7. Replay and pure-fold ownership

### 7.1 Exact replay query

Replay uses the primary and this query/order:

```sql
SELECT
  person_id,
  department_id,
  semester_year,
  semester_term,
  event_id,
  stream_version,
  schema_version,
  event_type,
  envelope_bytes,
  occurred_at,
  causation_id,
  correlation_id
FROM tutor_events
WHERE person_id = ?1
  AND department_id = ?2
  AND semester_year = ?3
  AND semester_term = ?4
ORDER BY stream_version ASC;
```

The bind order is exactly `[personId, departmentId, semesterYear, semesterTerm]`. The adapter verifies every returned row before passing it to `foldEvents`:

- versions are exactly `1, 2, 3, ...`;
- event IDs are unique in the stream;
- event stream fields equal the query stream;
- decoded envelope fields equal every indexed column, including event ID, version, schema version, type, occurrence, causation, and correlation;
- the event-log correlation rule from 0014 holds; correlation does not come from `stream_heads`;
- `(event_type, schema_version)` resolves through a versioned decoder registry;
- historical decoding/upcasting never rewrites the stored row; and
- unknown event types or schema versions fail closed.

The proof creates each persisted replay bad-row case by inserting one fresh row into a re-seeded local binding; it never mutates or deletes a persisted event. This applies to unknown event type/schema, version gap, `occurred_at` rewind, correlation mismatch, and indexed/envelope mismatch, including a decoded envelope whose stream differs from the indexed stream. The immutable triggers intentionally prevent mutation. Duplicate event ID/version and true cross-stream rows cannot be returned as a queried persisted row under the primary-key/unique constraints and stream query; supply those two cases as adapter row-array/fold-input cases and label that local capability limit in evidence. Every gap, duplicate, rewind, cross-stream, correlation, or index mismatch is not silently skipped.

### 7.2 Pure fold and projection

The future adapter calls the accepted 0014 pure `foldEvents`/`projectFoldedState` logic (or an equivalent source-preserving extraction) after bytes and indexed fields pass validation. It does not implement another fold in SQL, a repository class, a status table, or a read-time status derivation. The projection remains:

```text
fold(event envelopes) → FoldedState
FoldedState           → 0014 Projection
Projection            → canonical evidence
```

A receipt result is a stored prior observation for idempotency. It is not a projection source. Replay never interprets the descriptor. The event log provides facts, the pure fold provides state, and the evidence renderer provides canonical bytes and digest.

### 7.3 Compute-before/expose-after descriptor boundary

For a new accepted command, the adapter computes before the batch:

1. the v4 event envelope and canonical `envelope_bytes`;
2. the pure-fold projection and accepted observation;
3. the inert descriptor and canonical `descriptor_bytes`;
4. canonical `result_bytes`, `command_bytes`, and `command_sha256`; and
5. the three statements and exact bind arrays.

It exposes none of the accepted observation or descriptor as an effect request until all three batch statements commit and result `0` is verified. If the batch fails, it returns a typed failure or a classified prior receipt and exposes no newly computed descriptor. A successful exact duplicate returns stored bytes only as an idempotent observation. There is no effect interpreter in this capsule.

## 8. One local Miniflare proof journey

### 8.1 Runtime boundary and reset rule

The future proof runs one disposable local Miniflare D1 binding in one process. A loopback-only harness may be used when a local process boundary is necessary; bind only to `127.0.0.1` and do not expose a Worker route. An in-process binding is preferred. The proof must record the actual Miniflare version and binding setup from its package source/lock.

All cases below use this one disposable binding and deterministic synthetic values. A case that requires an intentionally inconsistent head/event or a race may reset/re-seed the same binding between cases or use a separately named synthetic stream in the same schema. Reset/discard is local state disposal, not a second database authority. No case creates a remote binding, uses production data, or claims a fifth lawful 0014 event.

Before each case that mutates fixture state, record bounded counts for `stream_heads`, `tutor_events`, and `command_receipts`. After the case, record counts and the canonical row identities. For intentional concurrent setup rows, distinguish the setup writer's rows from the candidate batch's rows and discard the entire binding at the end.

### 8.2 ADR §9 cases and required observations

The numbered cases are the accepted ADR §9 successor sequence. The future proof must execute all of them and retain sanitized observations in the eventual PR/handoff.

| ADR §9 case | Local operation | Required fail-closed observation |
|---:|---|---|
| 1 | Apply migration `0017-0001-tutor-event-store` once, with no `BEGIN TRANSACTION` or `COMMIT`. | All three `STRICT` tables, required checks/keys/FKs, and four immutable triggers exist. Record migration ID, SQL-byte `schemaHash`, applied order, and actual local binding operation. |
| 2 | Seed the exact 0014 stream: one head at `current_version=3`, `last_command_id=tutor-event-envelope-0014`, and v1–v3 rows with exact IDs/types/times/causation/correlation. | Seed rows are contiguous and fold to `accepted`; no receipt or descriptor exists. Head token equals v3 causation. |
| 3 | Treat head and v1–v3 rows as fixture setup. Do not invoke stream creation through `ConductInterview`. | The command path cannot create a missing head or version-zero state. Any attempt is `EMPTY_STREAM` with no write. |
| 4 | Decode exact command `cmd-0014-conduct`, compute v4 and descriptor privately, and run the three-statement batch. | Exactly one new v4 `InterviewConducted` row and one receipt commit; result index 0 is exactly `(4, cmd-0014-conduct)`; descriptor/observation become visible only after commit; no fifth event or external call. |
| 5 | Record the four-row persisted fixture. For a replay-only run, load exactly those four canonical rows as fixture data. | Persisted replay and the in-memory 0014 result have the same projection. No replay-only case accepts or invents v5 because `InterviewConducted` is terminal. |
| 6 | Submit `cmd-0014-malformed` with an excess field or missing answer. | Closed decode returns `DecodeError`; all three table counts and canonical rows remain unchanged. |
| 7 | Submit a well-formed command for `person-synth-0017-missing-head` (or another fixed stream with no head). | Global ledger miss followed by missing-head classification returns `EMPTY_STREAM`; no head, event, or receipt row is created. |
| 8 | Prepare a head/event divergence (for example, head version/token disagrees with the folded three rows) and invoke the append. | Adapter returns integrity failure and enters `Drift`; it does not repair the head or event rows and does not expose a descriptor. |
| 9 | Submit a well-formed command with stale `expectedVersion` or stale last-command token. | `StaleState`; no head, event, or receipt change. Evidence includes the preflight and post-failure head token/version. |
| 10 | Submit distinct `cmd-0014-terminal` at version 4 against the accepted four-row stream. | `InvalidTransition` with terminal `Conducted` / `T-INT-2`; no row or descriptor change. |
| 11 | Submit the exact original global ID `cmd-0014-conduct` and byte-identical canonical command again, after the stream is terminal. | Global primary-ledger read returns the stored result/descriptor before terminal validation as `DuplicateResult`; no second event, receipt, or descriptor. |
| 12 | Submit the same global `command_id` with changed canonical bytes, including a changed stream using `person-synth-0014-other`. | `DuplicateCommandConflict` before stream/version/terminal checks; no state change. It must not be accepted on the other stream. |
| 13 | Start two real local writers with the same stream and expected version (`cmd-0017-race-a` and `cmd-0017-race-b`). | Exactly one CAS wins and commits at most one event/receipt; the other is `StaleState` (or the prescribed ledger classification) with no partial rows. Row counts prove one accepted append, not two. |
| 14 | Exercise two multi-advance subcases from a preflight barrier: (a) a concurrent writer leaves an older same-stream/event/version row with a different causation token; (b) a protocol-only fixture writer advances the head beyond the candidate `newVersion` before the stale batch's statement 1/2 path. | The composite command-to-causation FK prevents receipt attachment to the older event; the batch rolls back. The beyond-version case does not create a fifth lawful 0014 event; it is a storage-race/integrity fixture and is discarded. Classify by the second primary ledger read and head token, never as success. |
| 15 | Force real constraint failures after preflight: a receipt primary-key conflict from a concurrent same-global-ID writer, and an event unique-key conflict from an intentionally injected local fixture row. | D1 rolls back the head update and every earlier statement in each candidate batch. The proof records FK/unique error, before/after head/event/receipt counts, second-ledger classification, and any competing setup rows separately. No uniqueness error becomes success. |
| 16 | Attempt `UPDATE` and `DELETE` on both `tutor_events` and `command_receipts`. | All four operations abort with exact trigger messages: `tutor_events are immutable` for event update/delete and `command_receipts are immutable` for receipt update/delete. Rows remain byte-identical. |
| 17 | Make the local binding return BLOB values as `number[]` in the adapter boundary. | Adapter normalizes to `Uint8Array`; fatal UTF-8 decode and exact UTF-8 re-encode preserve every byte; fold/replay succeeds only after the comparison. |
| 18 | Supply a wrong BLOB runtime type (string, object, null, or invalid array) through a real local result/adapter boundary. | Typed integrity failure and `Drift`; no fold, duplicate equality, descriptor exposure, or state mutation. |
| 19 | Capture the SQL text, numbered placeholders, bind arrays, and returned tuple for the accepted append and a stale batch. | Every statement uses `?NNN`; bind orders exactly match §6.3; result `0/1/2` maps to head/event/receipt; no named placeholder or reordered result is accepted. |
| 20 | Replay the persisted stream, then run isolated bad-row subcases. For persisted rows, re-seed and insert one fresh schema-reachable row for unknown `(event_type, schema_version)`, version gap, `occurred_at` rewind, correlation mismatch, or indexed/envelope mismatch (including a decoded envelope whose stream differs from the indexed stream). For duplicate event ID/version and true cross-stream rows, pass adapter row-array/fold-input values; PK/UNIQUE/query behavior makes those unpersistable as queried rows, so record the local limit. | Valid replay folds to the accepted 0014 projection. Every persisted bad row fails closed before projection; adapter duplicate/version and cross-stream cases fail closed at the fold boundary. Unknown decoder/schema is not guessed, and historical rows are never rewritten. |
| 21 | Render the complete sanitized evidence document twice from two clean identical local runs. | Canonical UTF-8 bytes, trailing newline, and SHA-256 digest are byte-identical. Evidence includes all case tags, counts, replay order, projection, descriptor count, source/version/hash facts, and explicit local/no-provider limits. |

The race and constraint cases are real D1 operations. A controlled barrier or fixture row is not a mock success: it arranges a known interleaving or database constraint and observes the actual local batch result. Any impossible local capability, unknown result shape, or source mismatch is a `Drift`, not a simulated pass.

### 8.3 Required final observations

At the end of the accepted path, the local database contains exactly one canonical stream with four event rows and one accepted receipt for `cmd-0014-conduct` (plus explicitly identified disposable setup rows only while a fault case is active). The replay projection is `completed`, the event list is `[evt-0014-001, evt-0014-002, evt-0014-003, evt-0014-004]`, the stream version is `4`, and the accepted descriptor count is `1`.

The future proof must not claim that these local rows are a live tutor authority. They are a local observation over synthetic data. The local binding is deleted/discarded after evidence capture.

## 9. Deterministic evidence contract

### 9.1 Evidence document

The eventual PR/handoff must contain one sanitized evidence document, not a committed generated evidence file. Its canonical JSON top-level key order is fixed as:

```text
formatVersion,
specId,
baseCommit,
adrSha256,
predecessorCommit,
fixtureId,
schemaMigrationId,
schemaHash,
localEffectVersion,
localEffectSourceHashes,
localMiniflareVersion,
correlationId,
stream,
seedHead,
seedEvents,
batch,
cases,
replay,
projection,
effectDescriptors,
rowCounts,
limits,
provenance
```

Encode as UTF-8 JSON with one trailing newline. Recursively sort object keys inside values while preserving the listed top-level order and semantic array order. Compute `sha256(canonicalBytes)` over the exact bytes. Do not include a generated timestamp, random ID, absolute path, environment dump, raw stack trace, credential, PII, or unbounded SQL/provider error.

The document records:

- spec ID `0017`, base commit `a8dafe618907dfd623718802fdaf5712d55f70d4`, accepted predecessor commit, ADR SHA-256, fixture ID, migration ID, SQL schema hash, and exact source/version/hash facts;
- the stream tuple, seed head token, seed event IDs/versions, accepted command/event/causation/correlation IDs, and descriptor count;
- statement SQL fingerprints or canonical SQL bytes, numbered bind order, result indexes, and the verified `(newVersion, commandId)` row;
- each ADR §9 case, result tag, typed reason, bounded before/after row counts, and whether rows were fixture setup, candidate batch, or competing writer;
- replay order, decoder/upcaster key, projection, law references, index/envelope checks, and explicit unknown-schema/gap/correlation/mismatch outcomes;
- two-run canonical byte lengths and equal SHA-256 digest; and
- local capability limits and forbidden surfaces.

### 9.2 Evidence scope

Evidence proves only the named local Miniflare D1 behavior and the accepted 0014 semantics exercised by the journey. It does not prove remote D1 SQL/result shape, primary/session consistency, replica behavior, D1 limits, migration service behavior, export/import, Time Travel, Hyperdrive, Durable Objects, Worker routing, provider behavior, production data, authorization, deployment, cutover, rollback ownership, or operator authority. A digest is a reproducibility receipt, not domain conformance proof.

## 10. Local Miniflare capability limits and exact no-provider boundary

### 10.1 What the local proof may establish

Subject to actual source/version evidence, one disposable local Miniflare D1 binding may establish only:

- this migration's local SQLite/D1 parsing and schema objects;
- local `STRICT`, BLOB type, primary-key, unique-key, foreign-key, and trigger behavior observed in the named scenario;
- local direct `D1Client.batch` result ordering and all-or-nothing behavior observed for the named statements;
- local primary-ledger read, head/event read, and replay over the local binding;
- local byte normalization, fatal UTF-8 equality, accepted 0014 fold, descriptor boundary, and deterministic evidence; and
- the local failure classifications produced by the future adapter for the listed cases.

The proof must record the selected Miniflare version and package/lock source. The current repository root has a Wrangler-transitive Miniflare edge; a transitive edge is not a direct dependency decision for the future adapter and is not proof of its API.

### 10.2 What it must not claim

A local Miniflare binding does not prove:

- remote D1 accepts this exact `UPDATE ... RETURNING`, `INSERT ... SELECT`, composite FK, `STRICT`, trigger, numbered-placeholder, BLOB, or batch result shape;
- a D1 replica, session, bookmark, cache, or read-after-write path exists or is safe;
- remote limits, concurrency scheduling, retry behavior, export/import, D1 migration tracking, Time Travel, backups, recovery, or provider availability;
- Hyperdrive, Durable Object, R2, KV, Alchemy, Wrangler remote mode, Cloudflare account state, Worker bindings, routes, public reachability, production data, or deployment behavior; or
- operator approval, cutover authority, rollback ownership, live tutor authority, or any external effect.

### 10.3 Exact no-provider boundary

The only allowed future runtime mutation is one disposable D1 database created by a local Miniflare binding in the named implementation worktree. The proof may use one loopback-only local process boundary at `127.0.0.1`; it must not expose a Worker route or public URL. The following are forbidden and are immediate `Drift`:

```text
wrangler --remote or any remote binding
Cloudflare API, Alchemy plan/apply, provider account, or cloud state
Hyperdrive, Durable Object, R2, KV, queues, service bindings, or a Worker route
credentials, secrets, production data, remote data, or PII
network fetch/socket to a provider or external service
migration, export, import, restore, cutover, deploy, or route action
```

No local proof may use a deployment log or provider response as evidence. If the selected local harness requires a network socket beyond the loopback process boundary, or if any provider/credential attempt occurs, stop the proof, preserve sanitized facts, and enter `Drift`.

## 11. Historical implementation capsule and current handoff

The following capsule is the historical implementation contract. Its named implementation is complete and integrated on the canonical line, but no frozen/open one-to-one PR exists.

Canonical provenance is `7ddca9eb18c307f7c6baf47134793eda5c299db6` (source candidate) → `9a166a327a21924537a3a3ac23ede88619b64c98` (canonical D1 integration) → `beff9154e8efb94c641b6cd6f8d65384ae0110f8` (provenance repair) → `ab95b5d36f515d1b60945b9d77a17a7519281493` (final head).

### 11.1 Historical writer role and one PR

- **Role:** one tutor-event persistence writer.
- **Objective:** implement the exact local journey in §8 and provide sanitized evidence in one one-to-one PR.
- **Suggested branch:** `impl/0017-tutor-d1-event-store-proof`; the feature lead records the actual branch/worktree/base when the PR capsule is frozen.
- **One-to-one rule:** one implementation PR, one blind-first verifier, no bundled Worker, route, provider, backfill, deployment, or unrelated domain change.
- **Superseded historical review:** `agent://TutorD1CodeReview0017` marked candidate `4c79fbae8a6d734e44443b1d5a1f7115b4a5ff84` **BLOCKED** for a resolver-derived lock-graph repair. The repair and review are closed by the canonical chain and the PASS reviews named in Metadata.

### 11.2 Future owned and forbidden paths

| Future path/resource | Capsule disposition | Exact reason |
|---|---|---|
| `packages/domain/src/tutor/**` | Owned | D1 adapter, schema migration file, local proof runner, BLOB boundary, replay bridge, and sanitized fixture harness stay beside accepted 0014 tutor code. No other domain source or second model. |
| `packages/domain/package.json` | Owned only for the two named direct dependency keys and the proof-script key | The candidate may add only direct `@effect/sql-d1` beta.107 and `miniflare` `4.20260706.0` edges plus the §11.3 proof script, with no other manifest/package dependency edges and all unrelated keys preserved. |
| `bun.lock` | Owned only for the exact resolver-derived lock update for the two named direct dependencies | Bun may mechanically re-hoist the exact graph described in §11.3, including its named transitive roots, only when every pre-existing consumer remains resolvable and the exact diff is recorded/reviewed. No unrelated manual refresh is allowed. |
| `packages/domain/src/index.ts`, root `package.json`, root scripts/config, other packages/apps, and all existing 0014 files outside the successor changes | Read-only | No public API, root graph, unrelated domain, server, SDK, UI, or implementation authority is needed for this local proof. |
| `docs/decisions/0002-tutor-event-log-persistence.md`, charter, lifecycle, domain model, and 0014 spec | Read-only authority | A conflict is `Drift`; the writer must not edit the easiest authority. |
| `/srv/share/projects/effect/**` | Read-only external source authority | Verify source/hash; never vendor, patch, install, or modify it. |
| Miniflare state, logs, caches, generated evidence | Disposable | Delete/discard before handoff. No generated evidence file is committed. |
| Provider, remote, production, route, credentials, data, deployment, and operator resources | Forbidden | No authority or boundary in this capsule. |

### 11.3 Future direct dependency and lock contract

The future implementation may import only the named direct dependencies. The Bun resolver may emit the exact mechanically derived transitive lock graph described below; code and manifest dependency edges must not rely on undeclared direct packages:

- Add direct runtime dependency `@effect/sql-d1` at exact `4.0.0-beta.107` only if the adapter imports `D1Client`/`D1Client.layer` from that package. This is direct because the implementation owns the D1 API capability and must pin the source-verified beta; a Wrangler or another package's transitive dependency is not an acceptable API edge.
- Add direct development/proof dependency `miniflare` at the source-verified local Effect edge `4.20260706.0` if the proof imports Miniflare to create its local D1 binding. The local Effect `packages/sql/d1/package.json` declares `^4.20260706.0`, and `/srv/share/projects/effect/pnpm-lock.yaml` resolves `miniflare@4.20260706.0` with integrity `sha512-UiqGo9Es/D7kJvDVpjhTQ/M2ppCSCsRc5EEKec6i4BvnCkFCRaZHRmFkMHzLhlg+daSZ+zvBaycWmgLZHn/1tQ==`. This is a dependency rationale, not evidence that the current mono-web root lock already provides that edge. If a source-verified implementation avoids importing Miniflare directly, it must document the alternative and must not add an unnecessary direct edge.
- Add one package proof script, `proof:d1`, targeting the local proof runner, and sequence it after the existing team and 0014 tutor fixture commands in `packages/domain/package.json`'s `test` script only if the accepted future runner is part of the package test gate. No other manifest key, version, export, or script may change.
- Update `bun.lock` only with the exact resolver output required by those two direct dependencies and the proof script. The permitted mechanical graph may re-hoist `miniflare` `5.20260804.0-alpha` to `4.20260706.0` and add/re-root its `sharp`, `undici`, `@emnapi`, and `@img` transitive roots while preserving every pre-existing consumer version in nested entries. This is allowed only when the manifest's direct dependency changes remain exactly `@effect/sql-d1` `4.0.0-beta.107` and `miniflare` `4.20260706.0`, no other manifest/package dependency edge changes, every pre-existing consumer version remains resolvable, the exact transitive diff is recorded and independently reviewed, and no unrelated manual lock refresh occurs.
- Do not add generic `@effect/sql`, `SqlEventJournal`, `Migrator`, a second ORM, a provider SDK, a Worker package, or a remote D1 client.

The exact mechanically resolver-derived graph above is an explicit capsule exception, not arbitrary lock authority. If any condition is not met, stop at `Drift` and request a capsule revision; do not silently broaden the manifest or lock paths.
If package resolution cannot provide the exact source-verified API without the named direct edges and this exact reviewed resolver graph, stop at `Drift` and request a capsule revision. Do not silently broaden the package or lock paths.

### 11.4 Future handoff contents

Before the future writer starts, the feature lead must hand off:

1. this accepted spec, the exact product-lead acceptance record, and the unchanged ADR/0014 authority references;
2. a fresh worktree, branch, and base commit recorded in the PR;
3. the allowed/forbidden path table and direct dependency/lock decision;
4. the exact fixture/head token and the numbered §8 scenarios;
5. the local Effect beta.107 source/version/hash facts and a source-verified Miniflare version/capability record;
6. the no-provider boundary and absence of operator authorization;
7. the evidence destination, sanitization rules, deterministic canonicalization, and rollback/discard path; and
8. a named blind-first verifier who receives the frozen spec and evidence before author rationale.

The current handoff reports source candidate `7ddca9e`, canonical integration `9a166a3`, provenance repair `beff915`, final head `ab95b5d`, final parent `beff915`, changed paths, package/lock edges, local proof evidence, closed Drift, and clean tracked/ignored status. It must not present this local proof as remote, provider, production, Worker, route, cutover, or operator evidence.

## 12. Entry gate and definition of done

### 12.1 Current lifecycle disposition

Implementation and local deterministic evidence are complete at canonical final head `ab95b5d36f515d1b60945b9d77a17a7519281493`, whose parent is `beff9154e8efb94c641b6cd6f8d65384ae0110f8`. The implementation source candidate was `7ddca9eb18c307f7c6baf47134793eda5c299db6`; canonical D1 integration is `9a166a327a21924537a3a3ac23ede88619b64c98`.

- Product-lead acceptance covers the intent and this lifecycle/evidence revision. It does not accept implementation as a provider, remote, production, or operator action.
- The canonical implementation paths are `packages/domain/src/tutor/d1-proof.ts`, `packages/domain/src/tutor/d1.ts`, `packages/domain/src/tutor/migrations/0001-tutor-event-store.sql`, `packages/domain/package.json`, and the resolver-derived `bun.lock` update.
- The proof passed 23 cases twice with byte-identical canonical evidence at `ab95b5d36f515d1b60945b9d77a17a7519281493`: 110896 bytes and SHA-256 `81d2a752d34c01e6a09e5e0f54c2d56d528a45b51551087583fb07ffa2456985`.
- Runtime PASS is recorded by `agent://CanonicalRepairRuntime1718` at canonical `ab95b5d36f515d1b60945b9d77a17a7519281493`. Superseded source-candidate runtime evidence from `agent://TutorD1AcceptanceRuntime0017` was 23 cases, 110684 bytes, SHA-256 `e5899fb8ff687f3108c3d2211af997ddb2cc2ce80c7ebe37b58ce76649c4a909`.
- All linked blocking Drift, including the prior resolver-derived lock-graph review blocker, is closed. The prior `4c79fbae...` BLOCKED review remains historical and is superseded.
- No frozen/open one-to-one PR exists. Therefore the lifecycle remains `Building`; it is not `Experienceable`, `Conforming`, `Release-ready`, or `Operating`.
- No provider, remote, production, route, Worker, data, credential, deployment, or operator authority is granted.

`Building` is current for the completed canonical implementation and evidence capsule. `Experienceable` requires the lifecycle authority's frozen/open one-to-one PR gate; `Conforming` is forbidden without that gate and independent verification of the PR.

### 12.2 Definition of done for the eventual PR

The future PR is complete only when:

- only the future owned paths changed, with any package/lock edits limited to §11.3 and justified in the PR;
- the exact migration runs without explicit `BEGIN TRANSACTION`/`COMMIT` and produces the required schema/triggers;
- the exact seed and head token fold to the accepted 0014 state;
- `ConductInterview` appends v4 once through the numbered three-statement D1 batch and exposes its descriptor only after commit;
- global ledger lookup precedes stream/version/terminal validation; exact duplicate and changed cross-stream duplicate have the accepted outcomes;
- same-version and multi-advance races, FK/unique failures, and stale/terminal/missing-head/divergence cases prove no partial candidate batch remains;
- trigger messages, BLOB normalization, fatal decode/re-encode, persisted unknown schema/type, gap, `occurred_at` rewind, correlation, and indexed/envelope mismatch (including decoded envelope stream mismatch), plus adapter row-array/fold-input duplicate event ID/version and cross-stream cases with their explicit local limit, all fail closed;
- replay uses the pure accepted fold and returns the accepted projection without a status/projection table or second model;
- two clean identical local runs render byte-identical canonical evidence and SHA-256 digest with sanitized provenance and limits;
- the proof uses one disposable local Miniflare D1 binding and no provider/remote/production/Worker/route/credential/data effect;
- all temporary state/logs/cache/generated files are removed or ignored; the worktree is clean; and
- an independent blind-first verifier passes the named journey with no linked `Drift`.

This docs-only spec task intentionally performs none of the eventual test/build/install/formatter/linter/runtime checks. The absence of such checks here is not implementation evidence.

## 13. Falsifiers

Any condition below is a falsifier. The future writer stops the lane, preserves sanitized evidence, and enters `Drift`; it does not weaken the contract.

### 13.1 Accepted resolver-derived lock exception

The implementation-review blocker is resolved only for this exact mechanical resolver outcome: direct manifest dependency changes are limited to `@effect/sql-d1` `4.0.0-beta.107` and `miniflare` `4.20260706.0`; no other manifest/package dependency edge changes; every pre-existing consumer version remains resolvable in nested lock entries; the exact `miniflare` `5.20260804.0-alpha` → `4.20260706.0` re-hoist and `sharp`/`undici`/`@emnapi`/`@img` transitive-root diff is recorded and reviewed; and no unrelated manual refresh is present. This exception does not authorize any other lock graph, package edge, provider, remote, runtime, or deployment action.

| Falsifier | Required response |
|---|---|
| A second live writer or dual-write path targets MySQL and D1. | Stop. Reject the capsule; current Symfony/MySQL remains pre-cutover authority. |
| A route, Worker, provider, credential, remote binding, production data, or public preview is touched by the local proof. | Discard the proof and enter `Drift`; repeat only with one disposable local Miniflare D1 binding. |
| `command_receipts` is stream-scoped or lookup occurs after stream/version/terminal validation. | Reject the schema/order; restore global command-ID lookup first. |
| Same global command ID with identical bytes is accepted a second time, or is rejected because the stream is terminal. | Reject duplicate precedence; return stored observation before terminal checks. |
| Same global command ID with changed bytes, including changed stream, is accepted. | Reject idempotency; return `DuplicateCommandConflict` with no state change. |
| Event IDs are treated as globally unique or a global event-ID format is invented. | Enter `Drift`; retain composite stream/event identity and defer global event-ID decision. |
| A missing head is created by `ConductInterview`. | Reject the command path; return `EMPTY_STREAM` and keep stream creation separate. |
| Head version/token disagrees with the folded event log and the append repairs it. | Enter `Drift`; stop and preserve the inconsistent rows. |
| A stale CAS leaves an event or receipt, or a zero-row CAS commits without the FK rollback. | Reject the batch protocol; prove complete rollback before any further work. |
| Statement 0 omits expected version or expected `last_command_id`, or Statement 1 omits the new head/version/token predicates. | Reject the CAS and its race evidence. |
| Multi-advance or older-event race attaches a receipt to an event with another causation ID. | Reject the composite FK proof; require rollback and second-ledger classification. |
| Any uniqueness or foreign-key failure is converted into success or hidden as a duplicate without the required ledger read. | Reject the adapter; surface the constraint and enter `Drift` when unclassified. |
| Batch statements, binds, or result indexes are reordered; named placeholders appear; result shape is guessed without observation. | Reject the adapter and re-record exact numbered SQL/bind/result evidence. |
| Descriptor bytes are computed after the batch, exposed before commit, interpreted during replay, or given a destination/provider. | Stop the effect lane; keep descriptor inert and commit-gated. |
| A status/projection table or receipt-derived status owner is added. | Reject the schema; pure 0014 fold remains sole projection owner. |
| Replay accepts unknown schema/type, a persisted gap/rewind/correlation/indexed-envelope mismatch (including decoded envelope stream mismatch), or adapter row-array/fold-input duplicate event ID/version/cross-stream input. | Fail closed and enter `Drift`; do not guess historical payloads or repair rows, and retain the explicit local persistence/query limit. |
| BLOB columns accept strings/objects, `number[]` is not normalized, invalid UTF-8 is replaced, or re-encode bytes differ. | Reject the adapter; return typed integrity failure before fold/byte equality. |
| Immutable event/receipt update or delete succeeds, or trigger messages differ without recorded equivalent proof. | Reject the migration and restore both `RAISE(ABORT)` trigger behaviors. |
| Migration/import includes `BEGIN TRANSACTION` or `COMMIT`, uses generic `Migrator`, or D1 calls `SqlClient.withTransaction`. | Reject the implementation; use D1-compatible implicit migration and direct `D1Client.batch`. |
| Generic `SqlEventJournal` supplies schema, generated IDs, conflict-hiding inserts, handler ordering, or transaction semantics. | Reject the implementation; do not create a second persistence contract. |
| Local Miniflare output is presented as remote D1, session, replica, provider, deployment, Worker, route, production, or operator proof. | Reject the claim and retain only the named local observation. |
| Two identical runs differ in canonical evidence bytes/digest, key order, event order, provenance, or limits. | Reject deterministic evidence; remove clock/random/environment/path leakage. |
| A package or lock edge is added manually beyond the two named direct dependencies, any condition of the exact resolver-derived graph exception is false, or an unrelated manual lock refresh occurs. | Stop at `Drift`; retain only the exact reviewed mechanical graph and request a capsule revision. |
| Writer changes an authority, broadens paths, edits unrelated source, or hides a source/API disagreement. | Stop at the capsule boundary and enter `Drift`; product lead routes the correction. |
| A deployment/log/review/install result is presented as journey, domain, persistence, provider, or production proof. | Reject the evidence boundary and request the named scenario observation. |

## 14. Rollback, Drift, and lifecycle

### 14.1 Local rollback

The future proof uses disposable Miniflare state. On migration, SQL, adapter, replay, BLOB, race, or evidence failure:

1. stop the local proof;
2. preserve only sanitized input/output facts, source/version/hash facts, scenario ID, and bounded counts;
3. discard the local D1 binding and generated state/log/cache;
4. do not retry a failed write before the required primary ledger read;
5. notify the feature lead/product lead and owning source authority; and
6. enter `Drift` with the conflicting artifact, observation, owner, and return path.

There is no remote restore, database rollback, route change, or provider destroy in this capsule. The existing pre-cutover Symfony/MySQL authority is not changed by local state disposal.

### 14.2 Drift path

Enter `Drift` when an authority, domain law, Effect source/API, local D1 result, SQL constraint, migration result, replay result, Miniflare boundary, package edge, evidence digest, or operator boundary disagrees with this spec. Do not weaken a constraint to remove the entry. The product lead routes an intent disagreement back to `Specified`; an implementation correction returns to `Building` only after the accepted intent and base are stable. A predecessor or shared-resource Drift blocks this successor.

### 14.3 Lifecycle states

- **`Specified` (completed):** this file contains the one journey, authority routing, exact fixture, schema, batch protocol, replay, evidence, limits, capsule, entry gate, falsifiers, rollback, and handoff; product-lead acceptance and independent review are recorded at reviewed HEAD `988ed2a`.
- **`Ready` (historical and completed):** product-lead acceptance, predecessor confirmation, direct dependency decision, and evidence destination were recorded before implementation.
- **`Building` (current):** implementation and local deterministic evidence are complete at canonical final head `ab95b5d36f515d1b60945b9d77a17a7519281493`; all linked blocking Drift is closed, but no frozen/open one-to-one PR exists.
- **Building boundary:** the implementation and evidence remain inside the named local capsule; no provider, remote, production, route, Worker, deployment, or operator effect is allowed.
- **`Experienceable` (not entered):** requires the lifecycle authority's frozen/open one-to-one PR and its complete objective evidence.
- **`Conforming` (not entered and not claimed):** forbidden until that PR gate and independent verification exist.
- **`Release-ready`/`Operating` (not entered and not implied):** this local proof has no release, deployment, route, production, provider, or operator authority.

This spec is `Building` with implementation and deterministic local evidence complete. Acceptance, implementation review, runtime observation, and any future PR gate remain separate artifacts and roles.

## 15. Exact sources and dependency notes

### Repository and accepted predecessor sources

- `/srv/share/projects/vektorprogrammet/docs/decisions/0002-tutor-event-log-persistence.md`, accepted; SHA-256 `94a2dbe93d353ddf98af784d3d6a66903c69631f8adc656c07f98a329491c830`; §§3–9 supply stream identity, schema, append, replay, beta.107 boundary, and all 21 local successor cases.
- `design-specs/0014-tutor-event-envelope-tracer.md` at base commit `a8dafe618907dfd623718802fdaf5712d55f70d4`; base file SHA-256 `270315bb1e3727a3668b025e1a888f95b4247955ba28516a42a5d399c017539b`.
- Accepted 0014 core code at that base: `packages/domain/src/tutor/schema.ts` SHA-256 `e355c580c69e2eb50d04cfb32cb0e8561eeee12b369a84245c7fd3fc5b607f20`; `tracer.ts` SHA-256 `880eebeffb1aa4bed0a825fca03587e9b11507dd3accb31dc0ed1a1ed0805fad`; `fixture.ts` SHA-256 `246dd484c8ddd3d7adf18ddb0634635bf32c7555d468692228b64b1bce77cda2`; `evidence.ts` SHA-256 `f8ad64ff61fba02c27888690ed4de6327c83d50c6b0a683e07e3448bb8d0a3c9`.
- `/srv/share/projects/vektorprogrammet/docs/product-lead-charter.md`, `/srv/share/projects/vektorprogrammet/docs/agentic-development-lifecycle.md`, and `/srv/share/projects/vektorprogrammet/docs/domain-model.md` are the current authority locators; this file does not copy their normative text.

### Local Effect beta.107 sources

- `/srv/share/projects/effect/packages/sql/d1/package.json`, version `4.0.0-beta.107`, SHA-256 `e4e2ccecc5a7e11dd08892cd5cf7a15568a27767a51e2b7ff688e8444b98236a`.
- `/srv/share/projects/effect/packages/sql/d1/src/D1Client.ts`, SHA-256 `33d086b2b5599349e012f93241d40f079ff78d09ddea00857744217e39b8647e`; `D1Client.batch`/binding/result-order lines 58–89 and 130–188; unsupported transaction and `layer` lines 315–337 and 388–402.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/Statement.ts`, SHA-256 `d0217382c9cded3a4f143058461b96aecf18c0f2daedd7995e726831d7cc12f5`.
- `/srv/share/projects/effect/packages/effect/src/unstable/eventlog/SqlEventJournal.ts`, SHA-256 `e7912dad2892ce246a1143389d17b9d8277df2eb204b92c4e3808437c1d0b9a8`.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/Migrator.ts`, SHA-256 `c94e7d36a4d253210e76e694bde656aeace439e541e503b9442e06bf95878de9`.
- `/srv/share/projects/effect/packages/effect/src/unstable/sql/SqlClient.ts`, SHA-256 `ec65f43418586cdf41c6389420da8f5b05000e88a017ddb4d77627e2b8b0ebfc`.
- `/srv/share/projects/effect/pnpm-lock.yaml` local D1 development edge: `miniflare@4.20260706.0`, integrity `sha512-UiqGo9Es/D7kJvDVpjhTQ/M2ppCSCsRc5EEKec6i4BvnCkFCRaZHRmFkMHzLhlg+daSZ+zvBaycWmgLZHn/1tQ==`; this is not a current mono-web lock change.

### Official capability references routed by ADR 0002

- [Cloudflare D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/) — D1 batch/session documentation; remote proof remains out of scope.
- [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) — numbered/anonymous parameter boundary; this local spec requires numbered placeholders.
- [Cloudflare D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) — foreign-key behavior; local observation is not remote proof.
- [Cloudflare D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/) — local Miniflare separation; no remote mode here.
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) — ordered migration concept; this proof omits explicit transaction delimiters.
- [Cloudflare D1 export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) — explicit remote successors, not local claims.

No source above grants provider, remote, production, route, Worker, data, credential, or operator authority.

## 16. Current disposition and future handoff summary

Current disposition is **`Building` / canonical implementation complete at `ab95b5d36f515d1b60945b9d77a17a7519281493` (parent `beff9154e8efb94c641b6cd6f8d65384ae0110f8`) / 23-case local proof PASS / 110896 evidence bytes / SHA-256 `81d2a752d34c01e6a09e5e0f54c2d56d528a45b51551087583fb07ffa2456985` / all linked blocking Drift closed / no frozen-open one-to-one PR**.

The handoff record contains:

```text
source candidate 7ddca9eb18c307f7c6baf47134793eda5c299db6 (parent d04f237b3f3ec6adb0200fca874773976460d477)
canonical D1 integration 9a166a327a21924537a3a3ac23ede88619b64c98 (parent e214c872841a90279e6525354ebe1f50232105fa)
canonical provenance repair beff9154e8efb94c641b6cd6f8d65384ae0110f8
canonical final head ab95b5d36f515d1b60945b9d77a17a7519281493 (parent beff9154e8efb94c641b6cd6f8d65384ae0110f8)
changed paths: packages/domain/src/tutor/d1-proof.ts, packages/domain/src/tutor/d1.ts, packages/domain/src/tutor/migrations/0001-tutor-event-store.sql, packages/domain/package.json, bun.lock
proof: canonical runtime PASS at `ab95b5d36f515d1b60945b9d77a17a7519281493`: 23 cases; 110896 bytes; SHA-256 81d2a752d34c01e6a09e5e0f54c2d56d528a45b51551087583fb07ffa2456985; repeated digest identical
superseded source-candidate runtime: `agent://TutorD1AcceptanceRuntime0017`; 23 cases; 110684 bytes; SHA-256 e5899fb8ff687f3108c3d2211af997ddb2cc2ce80c7ebe37b58ce76649c4a909
code review PASS: TutorD1AcceptanceCode0017; CanonicalRepairCodeReview1718
linked blocking Drift: closed
external authority: none; no provider, remote, production, route, Worker, deployment, credential, data, or operator action
```

Before a one-to-one PR opens, the feature lead must freeze this spec, attach the sanitized evidence and named reviews, and record the PR's exact changed paths. Until then, no writer may call this capsule `Experienceable`, `Conforming`, `Release-ready`, or `Operating`, or treat it as D1/provider/remote/production/route authority.
