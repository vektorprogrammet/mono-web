# Live design spec 0014 — tutor event-envelope tracer

> **Summary:** One Stage-2 maintainer journey for a pure in-memory `ConductInterview` tracer. It decodes one strict command, folds one `(Person, Cycle)` stream through `ApplicationReceived → InterviewInvited → InterviewAccepted`, accepts `InterviewConducted(scores)` once, returns a typed descriptor-only post-commit effect, rejects malformed and stale input, makes duplicate command handling idempotent, and emits a byte-stable projection/evidence record. It is an accepted design contract, not implementation, persistence, public preview, or operator authority.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0014` |
| Status | `accepted` — product-lead accepted 2026-08-11; implementation accepted/integrated at `a8dafe618907dfd623718802fdaf5712d55f70d4`; no persistence, provider, or external authority |
| Lifecycle | `Conforming` — 2026-08-11; not `Release-ready` or `Operating` |
| Base checkpoint | `mono-web` commit `f55fc050efecd03895b08f5417324c414c44dcf4` |
| Worktree for this spec | `/tmp/mono-web-tutor-event-spec-0014-20260811` |
| Review | `agent://TutorEventSpecReview0014` — PASS at reviewed spec HEAD `11ef4463` |
| Intended lane | Stage 2 — tutor event-envelope work |
| Owner | Tutor event-lane feature lead; product lead remains read-only to production code |
| Product-lead acceptance | Accepted 2026-08-11 at reviewed spec HEAD `11ef4463`; this grants no implementation, persistence, external-effect, provider, public-preview, or operator authority |
| Implementation owner/task | `TutorEventImpl0014` |
| Implementation branch | `impl/0014-tutor-event-envelope-tracer` |
| Implementation worktree | `/tmp/mono-web-tutor-event-impl-0014-20260811` |
| Implementation base | Ready state commit `40986855c21243ebcfa1f6470e782e13ed8320ef` |
| Implementation commit | `a8dafe618907dfd623718802fdaf5712d55f70d4` — accepted/integrated implementation |
| Code review | `agent://TutorEventCodeReview0014` — PASS at `a8dafe618907dfd623718802fdaf5712d55f70d4` |
| Runtime verification | `agent://TutorEventRuntimeVerify0014` — PASS at `a8dafe618907dfd623718802fdaf5712d55f70d4` |
| Integration checkout | `/tmp/mono-web-stage1-conforming-20260810` at `d735e3f8ccd33a684bc8e6f6fbcc95b7f6c78ee9`; clean tracked tree |
| Journey count | One future maintainer journey; one bounded implementation PR; one blind-first verifier |
| Evidence destination | Sanitized Evidence section of the future one-to-one PR or approved handoff; no repository evidence file |
| Authority boundary | No database, migration, Symfony, HTTP, UI, provider, public route, credential, data, or deployment authority |

This accepted spec records implementation integration at `a8dafe618907dfd623718802fdaf5712d55f70d4` and objective code/runtime review. It grants no persistence, provider, external-effect, public-preview, or operator authority; the implementation remains bounded by the capsule below.

## 1. Goal, constraints, and values

### Goal

Give one future domain maintainer a repeatable local journey that:

1. constructs a fixed synthetic `(Person, Cycle)` stream with the canonical initial events;
2. decodes an unknown `ConductInterview` command through a closed runtime schema;
3. accepts one lawful `InterviewConducted(scores)` transition and its descriptor-only post-commit effect;
4. rejects malformed, stale, terminal, out-of-order, and cross-stream input with typed reasons;
5. returns the same result without a second event or effect for an identical command ID; and
6. renders one canonical projection and evidence byte sequence with provenance.

This is the smallest tracer that exercises the accepted tutor event-sourcing direction without choosing persistence or an external effect interpreter.

### Constraints

- The stream key is exactly `(Person, Cycle)`. `Cycle` is explicit `Department × Semester`; a department, semester, admission-period, interview, account, or database ID is not a substitute for the tuple.
- The only event names in this slice are the domain-model names `ApplicationReceived`, `InterviewInvited`, `InterviewAccepted`, and `InterviewConducted(scores)`. Do not invent wire aliases or a second status machine.
- The transition is pure and immutable. In-memory state may be a returned value containing readonly events and command receipts; it is not a source of record, cache, queue, outbox, `Ref`, service, or persistence adapter.
- Runtime input is `unknown`. Closed schemas decode it with excess properties rejected. Type assertions, permissive parsing, defaulting a missing score, and silently dropping unknown fields are forbidden.
- `ConductInterview` must carry complete scores and one answer for every fixed synthetic schema question. Numeric score bounds and the `Suitability` vocabulary must remain the domain-model-derived boundary; the fixture uses the current contract's `0..10` numeric shape and `Ja | Kanskje | Nei` enum only as a bounded input example, not as a new law.
- `expectedVersion` is mandatory. A command whose expected stream version differs from the current version fails closed as stale and cannot append an event or descriptor.
- A post-commit effect is a typed immutable descriptor only. The tracer never sends mail/SMS/Slack, performs I/O, invokes a provider, starts a worker, or interprets the descriptor.
- IDs, times, schema versions, command order, JSON key order, and evidence bytes are fixed. Do not read a clock, random source, environment, network, database, or public preview.
- The current public preview `p001` is synthetic and separate. This tracer neither calls it nor grants public/provider authority.

### Values

- **Domain language first:** event and law names route to [`docs/domain-model.md`](../../docs/domain-model.md); this file does not redefine that authority.
- **Fail closed:** invalid representation, stale state, illegal transition, duplicate conflict, and stream mismatch are visible typed failures.
- **One owner per meaning:** the event fold owns state; the projection owns status; the evidence renderer owns canonical bytes; consumers do not re-derive any of them.
- **Evidence over implication:** a passing unit scenario proves only its named in-memory case, not a backend, database, deployment, or user journey.
- **Reversible and disposable:** all state is synthetic, local, and returned in memory; rollback is deleting the implementation PR, not undoing data.

## 2. Authority and current baseline

One link routes each fact; this spec does not copy normative law or process text.

| Concern | Authority and use in this slice |
|---|---|
| Program order and lead boundary | [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md) §§1, 4–7, 9, 12. Stage 2 tutor event work waits for the team-to-department evidence lane; the product lead remains read-only. |
| Lifecycle, capsule, evidence, Drift | [`docs/agentic-development-lifecycle.md`](../../docs/agentic-development-lifecycle.md) §§2, 4–6, 8–12. `Specified` is a complete candidate, not implementation authorization. |
| Domain meaning | [`docs/domain-model.md`](../../docs/domain-model.md) §§1.1, 1.3–1.4, 2.1–2.2, 7. The tutor chain is event-sourced first; `Cycle`, canonical events, projections, and `T-*`/`S-*`/`R-*` laws remain authoritative there. |
| Stage-0 topology/effect boundary | [`docs/decisions/0001-cloudflare-topology-and-migration-architecture.md`](../../docs/decisions/0001-cloudflare-topology-and-migration-architecture.md) §§1, 7, 9, 12, 14–15. An event descriptor is not provider authority; persistence and external effects remain context decisions. |
| Exact Effect capability source | The official local Effect source is `/srv/share/projects/effect`; this is `../effect` relative to the Vektorprogrammet workspace root `/srv/share/projects/vektorprogrammet`, not relative to the `/tmp` implementation worktree. The future writer MUST inspect that source before coding. This spec relies only on the exact signatures for `Schema.Struct`/`Schema.Union`/`Schema.Array`, `Schema.decodeUnknownEffect` (or `decodeUnknownExit`) with `ParseOptions.onExcessProperty = "error"`, and `Effect.gen`/`Effect.succeed`/`Effect.fail`/`Effect.runSyncExit`. No web snippet, v3 translation, unstable persistence module, or copied signature is authority. |
| Current package baseline | At `f55fc050efecd03895b08f5417324c414c44dcf4`, `packages/domain/package.json` declares `effect` `4.0.0-beta.107`; existing `packages/domain/src/**` is a separate conformance lane and is read-only here. No accepted `packages/domain/src/tutor/**` tracer exists at this checkpoint. |

The writer must re-check the exact beta.107 source at `/srv/share/projects/effect` (`../effect` from the Vektorprogrammet workspace root); that path is not relative to the implementation worktree, and its observed version is not a license to assume signatures across beta releases.

## 3. Canonical tutor contract exercised here

### Stream and events

The write stream is an append-only sequence keyed by:

```text
(PersonId, Cycle)
Cycle = { departmentId: DepartmentId, semester: { year: Year, term: Vår | Høst } }
```

For this tracer, the only accepted sequence is:

```text
v1 ApplicationReceived
  → v2 InterviewInvited
  → v3 InterviewAccepted
  → v4 InterviewConducted(scores)
```

The first three events are a fixed fixture, not a command API. The fourth is produced only by `ConductInterview` from the represented `Accepted` state. `status` is a projection over events, never a stored event field.

### Laws and transition boundary

| Canonical law | Observable rule in this tracer | Limit |
|---|---|---|
| `T-INT-1` | Conduct only from `Accepted`; the submission has all four score components and one answer per schema question. | Exact score vocabulary/bounds remain derived from the domain boundary; no new law is introduced here. |
| `S-INT-1` | `InterviewConducted(scores)` structurally carries complete score data, closed `Suitability`, and `conductedAt`. | This fixture does not prove all interview-schema variants. |
| `T-INT-2` | `Conducted` is terminal; a second conduct is rejected and cannot reopen or overwrite it. | `Cancelled` is not implemented in this tracer. |
| `R-APP-1` | The projection moves `received → invited → accepted → completed` for this stream. | Placement/assignment is not present, so no `assigned` claim is made. |

`R-APP-2`, `InterviewCancelled`, `Placed`, `Cancelled`, `PeriodExpired`, `PriorEvidenceAttached`, rescheduling, drafts, reminders, response-token expiry, authorization, and all wider tutor rulings are explicit successors. They are not hidden assumptions or implied by this four-event trace.

### Pure transition result

The implementation exposes one pure boundary with equivalent semantics to:

```text
conductInterview(state, unknownCommand)
  → Effect<AcceptedResult | DuplicateResult, DecodeError | StaleState | InvalidTransition | DuplicateConflict | StreamMismatch>
```

The exact TypeScript names are implementation detail; the tagged failure distinctions and observable fields are contract. The function returns a new state/result and never mutates its input.

## 4. Envelope, command, and descriptor contract

### Event envelope

Every event is a closed `EventEnvelopeV1` with these fields:

| Field | Contract |
|---|---|
| `schemaVersion` | Literal `1`; envelope schema version, not a domain-law version. |
| `eventId` | Stable synthetic identity, unique in the trace; no UUID/random generation. |
| `stream` | `{ personId, cycle: { departmentId, semester: { year, term } } }`; exact `(Person, Cycle)` identity. |
| `streamVersion` | Positive contiguous integer beginning at `1`; array position and version must agree. It is the sole in-stream order authority. |
| `eventType` | One of the four canonical names above. |
| `payload` | Closed event-specific value. Initial events use `{}`; `InterviewConducted` carries `scores` including `conductedAt`. |
| `occurredAt` | Fixed UTC RFC 3339 value supplied by the fixture; ordering is checked within the stream but no global time order is claimed. |
| `causationId` | ID of the command/fixture input that caused this event. It is a reference, not executable authority. |
| `correlationId` | One stable journey ID shared by the fixture trace and its derived evidence. |

An envelope with a different stream, schema version, event name, duplicate ID, missing version, gap, rewind, or non-contiguous order is rejected before projection. Event identity, stream order, causation, correlation, and schema version are distinct fields and must not be collapsed into one ID.

### Conduct command

`ConductInterviewV1` is also closed and contains:

```text
{
  schemaVersion: 1,
  commandId,
  correlationId,
  stream: (Person, Cycle),
  expectedVersion: 3,
  scores: {
    explanatoryPower: 0..10,
    roleModel: 0..10,
    suitability: 0..10,
    suitableAssistant: Ja | Kanskje | Nei,
    answers: { "q-0014-a": string, "q-0014-b": string }
  }
}
```

The two question IDs are synthetic fixture inputs used only to exercise `T-INT-1`'s completeness condition. A future accepted schema may replace them only through an explicit successor/revision; the writer must not silently broaden the answer map.

`commandId` is the idempotency identity. The in-memory receipt ledger stores the canonical command bytes and result for the current run. The same ID with byte-identical command content returns the original accepted result and descriptor without appending anything. The same ID with different content returns `DuplicateCommandConflict` and leaves state unchanged.
Processing order is part of the contract: decode the closed command first; then look up `commandId` in the ledger; an exact canonical-byte duplicate returns the stored result before stream, version, or transition checks; the same ID with different canonical bytes returns `DuplicateCommandConflict`; only an unseen ID proceeds to stream, stale-version, and transition validation. Thus duplicate idempotency is not masked by the terminal-state rejection.

### Descriptor-only post-commit effect

An accepted transition returns one immutable descriptor, equivalent to:

```text
{
  descriptorVersion: 1,
  kind: "InterviewConductedDescriptor",
  sourceEventId: "evt-0014-004",
  causationId: "cmd-0014-conduct",
  correlationId: "corr-0014-tutor",
  idempotencyKey: "post-commit:evt-0014-004"
}
```

There is no destination, recipient, body, provider, transport, retry, outbox, or effect execution. The descriptor is created only after the event is accepted into the returned in-memory state. A duplicate command returns the prior descriptor as observation, not a second effect request.

## 5. Exact synthetic journey

The future writer starts from the named base, verifies the worktree is clean, and runs one local fixture journey. No step contacts a socket, service, provider, database, or public preview.

### Fixed fixture

Use UTF-8, these exact PII-free values, and no current time:

```text
fixtureId       = "tutor-event-envelope-0014"
personId        = "person-synth-0014"
departmentId    = "department-synth-0014"
semester        = { year: 2026, term: "Vår" }
correlationId   = "corr-0014-tutor"
seed times      = 2026-08-11T09:00:00Z, 09:01:00Z, 09:02:00Z
conductedAt     = 2026-08-11T09:03:00Z
seed event IDs  = evt-0014-001, evt-0014-002, evt-0014-003
command ID      = cmd-0014-conduct
malformed ID     = cmd-0014-malformed
stale ID         = cmd-0014-stale
terminal ID      = cmd-0014-terminal
conducted ID     = evt-0014-004
```

The fixture scores are `(8, 9, 7, "Ja")` with answers `{ "q-0014-a": "answer-a", "q-0014-b": "answer-b" }`. These values are synthetic and carry no person, interview, school, account, or contact data.

### Steps and expected observations

| Step | Input/scenario | Required observation |
|---|---|---|
| 1 | Build exactly the three closed seed envelopes for the one stream, versions 1–3. | Folded state is `accepted`, projection is `accepted`, and no effect descriptor exists. Any gap, duplicate, or different stream is a typed rejection. |
| 2 | Decode the exact `ConductInterviewV1` command with `expectedVersion = 3`. | Runtime decoding succeeds only with the closed shape, literal schema version, exact stream, complete scores, and both answers. |
| 3 | Commit the command. | One v4 `InterviewConducted(scores)` envelope is appended; projection is `completed`; exactly one descriptor is returned; no external call occurs. |
| 4 | Submit malformed command ID `cmd-0014-malformed` with an extra field or missing answer. | `DecodeError` is observable; event count and descriptor count remain `4` and `1`. |
| 5 | Submit well-formed command ID `cmd-0014-stale` with `expectedVersion = 2` against the v4 state. | `StaleState` is observable; no event or descriptor is appended. |
| 6 | Submit distinct well-formed command ID `cmd-0014-terminal` at version 4. | `InvalidTransition` cites `T-INT-2`/terminal `Conducted`; state remains unchanged. |
| 7 | Submit the exact original command `cmd-0014-conduct` again. | `DuplicateResult` returns byte-identical prior accepted observation before terminal validation; event count remains `4`, descriptor count remains `1`. |
| 8 | Submit `cmd-0014-conduct` again with one score changed. | `DuplicateCommandConflict` is observable; state and evidence remain unchanged. |
| 9 | Render the projection/evidence twice from the same resulting state. | Canonical UTF-8 bytes and their SHA-256 digest are identical; provenance points to this spec ID, base commit, fixture ID, schema version, stream, event IDs, and source command ID. |

## 6. Deterministic projection and evidence

The projection is the sole owner of the derived observation:

```text
{
  projectionVersion: 1,
  stream: (Person, Cycle),
  streamVersion: 4,
  status: "completed",
  eventTypes: [
    "ApplicationReceived",
    "InterviewInvited",
    "InterviewAccepted",
    "InterviewConducted"
  ],
  conductedAt: "2026-08-11T09:03:00Z",
  lawRefs: ["T-INT-1", "S-INT-1", "T-INT-2", "R-APP-1"]
}
```

Evidence is a versioned canonical JSON document, encoded as UTF-8 with one trailing newline. Its top-level key order is fixed as `formatVersion`, `specId`, `baseCommit`, `fixtureId`, `schemaVersion`, `correlationId`, `stream`, `cases`, `projection`, `eventIds`, `effectDescriptors`, `provenance`. Object keys are recursively sorted within nested values; arrays retain semantic order. No generated timestamp, random ID, absolute path, environment dump, raw log, PII, or unbounded error text is permitted.

The future evidence record MUST include:

- canonical bytes and `sha256(canonicalBytes)`;
- base commit `f55fc050efecd03895b08f5417324c414c44dcf4`, spec ID `0014`, fixture ID, and local Effect source/version/hash used by the writer;
- accepted, rejected, stale, terminal, duplicate, and duplicate-conflict case statuses with typed reason tags;
- stream/event identity and order, command ID, causation/correlation IDs, schema versions, projection, and descriptor count; and
- the explicit limits that this proves only a pure in-memory tracer over synthetic input, not persistence, backend parity, authorization, delivery, UI, deployment, provider, public content, or production behavior.

A hash is a reproducibility receipt, not proof of domain conformance. The evidence destination is the future PR/handoff; this spec does not create an evidence artifact.

## 7. Scope, non-goals, dependencies, and conflicts

### Exact future implementation capsule

The future writer may mutate exactly these paths and no others:

- `packages/domain/src/tutor/**` — tutor envelope, command, pure fold/transition, projection, descriptor implementation, and executable tutor fixture/test harness;
- `packages/domain/package.json` — the `scripts.test` field only, preserving the existing team fixture command and sequencing the tutor fixture command (equivalent to `bun run src/main.ts --fixtures && bun run src/tutor/main.ts --fixtures`); no dependency, version, export, or other manifest key.
The existing root `test` script remains unchanged (`turbo test`), so package/root test runs both the existing team fixture harness and the tutor fixture harness. The root `bun.lock` remains unchanged. These are capsule restrictions, not mutable paths.

The implementation/tests/fixtures are all under `packages/domain/src/tutor/**`; there is no `src/tutor.test.ts`, separate test directory, new test runner, or new dependency. If the current package convention cannot run both harnesses through this script-only change, stop and request a reviewed capsule revision. Generated coverage, build output, cache, logs, and evidence are disposable and never committed.


### Non-goals

This slice does not include:

- any database, event store, migration, schema migration, ORM, repository, durable outbox, queue, workflow, retry, or persistence decision;
- Symfony, API/HTTP/RPC, SDK, homepage, dashboard, browser/UI, auth/authz, PII, public content, Worker, Hyperdrive, D1, R2, KV, Cloudflare, Alchemy, Wrangler, provider, route, deployment, DNS, credentials, or public preview work;
- execution or interpretation of the descriptor, email/SMS/Slack delivery, telemetry, or external effects;
- placement, school allocation, `AssistantHistory`, certificate, cancellation, expiration, prior-cycle evidence, reminder, reschedule, draft, response-token, or full `R-APP-2` outcome behavior;
- changing the domain model, adding a new law, claiming all tutor events or all contexts are event-sourced, or replacing the current Symfony/MySQL parity line; or
- changing `packages/domain/package.json` beyond the `scripts.test` field, changing any lockfile, root configuration, current S-DEP-2 code, public `p001`, or another live spec.

### Dependencies and conflicts

- **Predecessor:** accepted [`0004-team-department-conformance-evidence.md`](./0004-team-department-conformance-evidence.md) is `Conforming`; its implementation capsule is **CLOSED/CONSUMED** at `bc7f459`, `897228e`, and `c90ec2d`, with independent review/runtime evidence at `c90ec2d`. This spec does not redispatch or edit 0004. The team-to-department evidence lane must exit before Stage 2 tutor event-envelope work.
- **Required authorities:** Stage-0 ADR 0001, the charter, lifecycle, domain model, and the closed/consumed 0004 disposition must remain resolvable at implementation start. A conflict enters `Drift`; it is not repaired by weakening this tracer.
- **Effect boundary:** the writer verifies only the exact local `/srv/share/projects/effect` (`../effect` from the Vektorprogrammet workspace root) source signatures used by this capsule. No dependency refresh or lock edge is authorized; the existing beta.107 package edge remains read-only.
- **Resource conflict:** `packages/domain/src/tutor/**` is disjoint from the consumed 0004 implementation/evidence ownership. No other writer may mutate this tutor path concurrently. Existing 0004 source/evidence and other domain source files remain outside this capsule; there is no root lock edge.
- **Separate lanes:** public synthetic preview `p001`, security, public content, SDK, persistence, and later tutor successors have independent specs and authority. They are not dependencies hidden by this tracer.

## 8. Falsifiers and definition of done

The implementation enters `Drift` if any condition succeeds when it should fail:

- an unknown field, missing field, wrong literal schema version, malformed score, wrong answer cardinality, or invalid stream decodes successfully;
- conduct from `Invited`, a stale expected version, a stream mismatch, an event gap/duplicate, or terminal `Conducted` appends an event;
- duplicate command content appends a second event or descriptor, or duplicate command ID with changed content is treated as success;
- a descriptor has a destination or is interpreted by a transport/provider; the tracer performs I/O or reads ambient time/randomness;
- projection/status is stored as an event or re-derived by a second owner;
- two identical runs produce different canonical evidence bytes/digests or omit provenance/limits; or
- a review, log, preview URL, package install, or deployment is presented as persistence, backend, domain-conformance, public, or production proof.

Done for the future implementation means: the exact tutor source/test/fixture capsule is the only changed implementation path; the sole manifest exception is `packages/domain/package.json` `scripts.test`, with no dependency or lock change; local Effect signatures are source-verified; the existing package/root test path runs both the team fixture harness and tutor fixture harness; the tutor harness observes every Step 1–9 outcome; typed failures preserve state; descriptor count is idempotent; projection and evidence bytes/digest are repeatable; sanitized provenance and limitations are retained; temporary outputs are removed; the worktree is clean; and no linked Drift remains. This candidate itself is not done-as-implementation and has no runtime evidence.

## 9. Rollout, rollback, and lifecycle gates

There is no rollout. The future PR is an in-memory library/test change with no route, release, provider, database, data, credential, or public effect. It may not be presented as a tutor backend or preview.

Rollback is a local revert or disposal of the one-to-one implementation PR/worktree. Since no durable state or external effect exists, no migration rollback, data restore, route switch, or provider destroy is needed. If a future successor adds persistence or an effect interpreter, it requires a new context decision, live spec, evidence, and operator-owned rollback; it cannot extend this capsule silently.

Lifecycle intent:

- **Specified:** this complete intent, authority routing, one journey, capsule, evidence contract, falsifiers, and limits are present.
- **Ready:** product-lead acceptance, predecessor confirmation, independent review, and the exact implementation task/worktree/base were recorded; this gate is superseded by the current `Conforming` state.
- **Building:** one writer in the named worktree changes only the allowed paths and records objective local evidence.
- **Experienceable/Conforming (current):** implementation accepted/integrated at `a8dafe618907dfd623718802fdaf5712d55f70d4`; code review `agent://TutorEventCodeReview0014` and runtime verification `agent://TutorEventRuntimeVerify0014` are PASS; no persistence, provider, external, public-preview, or operator authority is granted.
- **Release-ready/Operating:** not applicable to this pure tracer; any external or public action requires a later accepted spec and scoped operator authority.

## 10. Task capsule and Drift path

| Field | Capsule content |
|---|---|
| Spec ID/path | `0014`; `mono-web/design-specs/0014-tutor-event-envelope-tracer.md` |
| Role/objective | One future tutor-domain writer; realize the pure in-memory `ConductInterview` tracer and the exact Step 1–9 observations. |
| Base/worktree | Start at `f55fc050efecd03895b08f5417324c414c44dcf4` in a fresh isolated worktree; this spec's authoring worktree is `/tmp/mono-web-tutor-event-spec-0014-20260811`. Record the implementation worktree and clean checkpoint before mutation. |
| Allowed mutations | Exactly `packages/domain/src/tutor/**` plus `packages/domain/package.json` `scripts.test` only. The root `test` script and root `bun.lock` remain unchanged; implementation/tests/fixtures are executable under `src/tutor/**`; no test runner or dependency is added. |
| Forbidden mutations/effects | Every other source/config/manifest/lock/provider/data/UI/server path; any package manifest key other than `scripts.test`; persistence; migration; network; provider/public preview; credentials/PII; descriptor execution; edits to this spec or domain authority. |
| Dependencies/conflicts | Closed/consumed 0004 capsule at `bc7f459`/`897228e`/`c90ec2d`; team-to-department evidence exit; accepted Stage-0 ADR and domain/lifecycle/charter authorities; `/srv/share/projects/effect` (`../effect` from workspace root) source verification; exclusive disjoint ownership of `src/tutor/**`; no lock edge. |
| Context/law/interface refs | Domain model §§1.1, 1.3–1.4, 2.1–2.2 (`T-INT-1`, `S-INT-1`, `T-INT-2`, `R-APP-1`); charter §5; lifecycle §§4–6, 9, 12; ADR §§7, 9, 12, 14–15; accepted 0004 closure; exact local `/srv/share/projects/effect` source files selected by the writer. |
| Sensitive-data policy | Fixed synthetic technical IDs/times only; no names, emails, tokens, credentials, production rows, public URLs, or raw logs. Keep command/event payloads in memory and sanitize evidence. |
| Verification scenarios | Closed-schema malformed input; canonical seed fold; accepted conduct; stale version; terminal transition; duplicate and duplicate-conflict; envelope identity/order/causation/correlation/schema checks; descriptor non-execution; two-run canonical evidence byte/digest comparison; path review. |
| Exit criteria | Step 1–9 evidence recorded; the existing package/root test path runs both the team fixture harness and tutor fixture harness; package type check passes for the changed boundary; exact path/manifest capsule honored; root lock unchanged; clean worktree; no unresolved linked Drift; sanitized handoff ready for blind-first review. |
| Evidence destination | Sanitized Evidence section of the one-to-one PR or approved handoff; no committed evidence file. |
| Drift path | Stop on a falsifier, source/API mismatch, authority disagreement, unresolved score/schema ruling, path need, or unexpected effect. Notify product lead and owning authority; link the observation and return to `Specified` for intent change or `Building` for implementation correction. |
| Cleanup | Remove generated test/coverage/cache/log files and temporary fixtures; retain only sanitized deterministic evidence; confirm no external process, socket, credential, or untracked file remains. |
| Operator authorization | None required or permitted. Any external effect is out of capsule and requires a separate lifecycle-scoped operator record. |

### Successors, not assumptions

A later spec must explicitly decide how this in-memory trace connects to a durable event log, command authorization, event replay/import, complete tutor outcomes, event retention/versioning, schema evolution, external delivery, public APIs, persistence, and rollback. None is implied by the envelope shape or the descriptor in this slice.

### Drift log for this candidate

Implementation and runtime observations are recorded by the cited PASS reviews at integrated commit `a8dafe618907dfd623718802fdaf5712d55f70d4`. Initial disposition is **open/empty** for any new disagreement: record owner, artifact, claim, and lifecycle return path rather than editing it away.
