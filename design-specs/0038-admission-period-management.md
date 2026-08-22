# Design spec 0038 — Admission-period management

> **Summary:** An authenticated active team leader opens and closes one admission window for their department and a selected semester. The native Effect/PostgreSQL authority enforces department scope, one window per department and semester, ordered instants, optimistic revision, replay, and public eligibility projection. One real browser journey proves that opening enables public application eligibility and closing disables new applications without changing existing applications. No Symfony, provider, production data, or deployment is involved.

## Metadata

| Field | Value |
|---|---|
| Goal | Replace admission-window runtime authority and unlock the public applicant journey |
| Status | Frozen and accepted for local implementation; no production cutover authority |
| Depends on | ADR 0004; ADR 0005; design specs 0028–0032; canonical head `75dcc36` |
| Actors | Authenticated active team leader scoped to one department; authenticated active global admin |
| Journey authority | `intent://journey:admission-period:manage:v1`; existing parity projection `intent://journey:parity:admission_operations:v1` |
| Environment | Loopback HTTP, disposable PostgreSQL, real Chromium |

## Source authority and corrections

The legacy implementation establishes department, semester, start/end instants, optional information meeting, public application gating, and the create/edit surfaces. It does **not** establish several claims in migration prose: the database has no department/semester unique constraint; create/edit do not enforce `endDate > startDate`; legacy active checks disagree at exact boundaries; and the window is mutable. This contract preserves the user capability while making one canonical law explicit instead of reproducing those contradictions.

For this slice, one window per department and semester and `startAt < endAt` are domain laws. Eligibility is the half-open interval `startAt <= now < endAt` and also requires the linked semester to contain `now` using the same half-open rule. Closing is an explicit revisioned change to `endAt`; it does not delete the window. Information-meeting management and destructive deletion are outside this journey and remain parity rows, not silently completed work.

## User journey

1. A team leader signs in and opens **Opptaksperioder**.
2. The dashboard lists only the leader's department windows and shows semester, start, end, eligibility, and revision. A global admin may list all departments.
3. The actor opens a create form, selects a semester, enters start and end instants, and submits a stable caller-generated `commandId`.
4. The HTTP adapter derives actor and scope from the authenticated token. The caller supplies no authoritative department for a department-scoped actor; a global admin must select a department explicitly.
5. `AdmissionPeriodAuthority` creates one window transactionally. The projection refreshes from PostgreSQL and shows it as eligible when the fixed proof clock lies within both windows.
6. The public admission projection reports that department as accepting applications. A public application command can resolve the same window identity.
7. The leader edits the end instant with `expectedRevision` and a new stable `commandId`, closing the window before the proof clock.
8. A fresh private and public read shows the window as ineligible. A new public application is rejected, while a previously stored application still references the unchanged admission-period identity.

## Model and authority

```text
AdmissionPeriod = {
  id, departmentId, semesterId,
  startAt, endAt,
  revision, lastCommandId
}

Message
  = CreateAdmissionPeriod(commandId, semesterId, startAt, endAt, departmentId?)
  | ReviseAdmissionPeriod(commandId, admissionPeriodId, expectedRevision, startAt, endAt)

Observation
  = Created(period)
  | Revised(period)
  | Replayed(originalObservation)
  | Rejected(reason)
```

The database is the truth model. The Effect program is open over an admission-period repository, clock, command-receipt store, and audit/outbox interpreter. The PostgreSQL Layer owns transactional locking and persistence. Derived eligibility is never stored.

## Laws

| Law | Required behavior |
|---|---|
| Ordered window | `startAt < endAt`; equal or reversed values are rejected |
| Semester containment | start and end must lie within the linked semester window |
| Uniqueness | exactly one admission period per `(departmentId, semesterId)` |
| Scope | department leaders can read/write only their token-derived department; global admins may select/read all |
| Revision | create starts at 0; each accepted revision increments exactly once |
| Replay | identical `commandId` + canonical bytes returns the original observation without another write/effect |
| Conflict | reused `commandId` with different bytes is rejected |
| Concurrency | two revisions at one expected revision yield exactly one winner |
| Eligibility | `semester.startAt <= now < semester.endAt && period.startAt <= now < period.endAt` |
| Historical stability | closing/revising never changes period identity or existing application references |

## Canonical capability contract

Native endpoints:

- `GET /api/admin/admission-periods` — scoped projection;
- `POST /api/admin/admission-periods` — strict JSON `{ commandId, semesterId, startAt, endAt, departmentId? }`;
- `POST /api/admin/admission-periods/:admissionPeriodId/revise` — strict JSON `{ commandId, expectedRevision, startAt, endAt }`;
- `GET /api/admission-periods/open` — public eligible-department projection.
- `POST /api/applications` — strict proof-slice JSON `{ commandId, applicantId, departmentId }`; resolves and stores the currently eligible admission-period identity.

Canonical SDK:

- `admissionPeriods.listForManagement()`;
- `admissionPeriods.create(input)`;
- `admissionPeriods.revise(admissionPeriodId, input)`;
- `admissionPeriods.listOpen()`.
- `applications.submit({ commandId, applicantId, departmentId })`.

No generic status setter, client-supplied actor/scope, hard delete, reopen shortcut, or legacy numeric CRUD is exposed by this capability. Timestamps are strict RFC 3339 instants and responses use stable string IDs.
The public application seam in this slice deliberately stores only `{ id, applicantId, admissionPeriodId }`. Applicant profile, field-of-study, notification, and duplicate-applicant behavior remain owned by later public-application work. This minimal native command exists because eligibility without an accepted and rejected application command would not prove the user-facing gate.

## Meaningful rejections

The API and browser journey must observe typed rejection for:

- missing/expired authentication;
- inactive actor;
- insufficient role or cross-department scope;
- unknown department, semester, or admission period;
- equal/reversed or out-of-semester instants;
- duplicate department/semester window;
- stale revision and concurrent conflict;
- malformed/excess JSON or non-RFC-3339 instant;
- replayed command ID with different bytes;
- durable PostgreSQL failure;
- public application when no eligible window exists.

Every rejected command leaves periods, revisions, command receipts, audit/outbox rows, and existing application references unchanged.

## Migration and compatibility

The implementation uses new native tables and explicit stable IDs. A deterministic importer may later map legacy numeric IDs and existing applications, but production import/cutover is not authorized here. Existing Symfony endpoints remain untouched. Existing accepted parity receipts remain evidence for their exact revisions only and do not prove this native journey.

The current PHP admission resources may be reused only as behavioral evidence. New dashboard code must use the canonical SDK and native API. The placeholder `/dashboard/opptaksperioder` becomes the management UI. Information-meeting editing and destructive deletion remain explicitly uncovered.

## Evidence and definition of done

One deterministic local runner starts disposable PostgreSQL, native API, dashboard, and Chromium, then emits secret-free evidence proving:

- department scope and global projection;
- accepted create and fresh PostgreSQL-backed list;
- public eligibility before close and ineligibility after close;
- accepted revision and exactly one revision increment;
- unchanged period identity and existing application reference after close;
- rejected new application after close;
- duplicate, invalid-window, cross-scope, stale, replay-conflict, malformed, and unauthenticated paths;
- identical replay with no duplicate durable rows/effects;
- concurrent revisions with one winner;
- audit/outbox ordering and zero duplicate effects;
- cleanup releases database and ports.

The journey is falsified if it renders fixture state, calls Symfony, trusts browser-supplied authority, stores eligibility, allows overlapping duplicate authority, deletes historical identity, permits two concurrent winners, bypasses the SDK, mocks PostgreSQL, leaks credentials or business data, or cannot clean up. Focused package gates and repository root `check-types`, `lint`, `build`, and `test` must pass on the committed artifact; unrelated pre-existing failures must be named with exact evidence.
