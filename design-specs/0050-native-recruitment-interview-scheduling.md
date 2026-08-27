# Design spec 0050 — native recruitment interview scheduling

## Metadata

| Field | Value |
|---|---|
| Status | Contract remains frozen; Amendment 0050.1 authorizes an evidence-harness correction only; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence remain pending |
| Revision | Amendment 0050.1 records observed native Identity evidence-harness drift; runtime evidence remains pending |
| Base | `dd2425f8ea21c2f61cdff9bb518a1e726d8dac64` (`dd2425f`) |
| Goal | Replace the Symfony scheduling seam with one native Recruitment transition and one full-Foldkit staff journey |
| Actors | Active department leader or assigned active interviewer |
| Route | `/dashboard/intervjuer` |
| Behavioral evidence | Design spec 0029 and the legacy Symfony scheduling implementation |
| Architecture | Design specs 0040, 0045.2, and 0049 |
| Operator boundary | No production data, remote provider, credential, deployment, or external notification effect |

## Amendment 0050.1 — native Identity evidence-harness correction

The integrated dashboard now uses native Better Auth session cookies through Identity. The old scheduling runner supplies a `jwt_token` cookie and legacy token maps instead. The backend now requires `BETTER_AUTH_SECRET`.

This drift concerns the evidence harness only. It does not change the frozen scheduling journey, actor or authority semantics, transaction or notification semantics, falsifiers, non-goals, or operator boundary.

This amendment authorizes one evidence-harness correction:

- Seed the two synthetic scheduling personas through the existing disposable `identity:seed` entrypoint.
- Pass a process-scoped Better Auth secret and `BETTER_AUTH_URL` to the disposable backend and dashboard processes.
- Authenticate each persona through the rendered native login form in real Chromium.
- Forward the resulting Better Auth session cookie on the browser journey.
- Record that the journey injects no bearer token.

The correction must not change product behavior, access policies, legacy routes, or production effects. It must not add a compatibility route, retain token-map authentication for this journey, or contact an external provider.

Runtime and acceptance evidence remain pending until the corrected harness produces the evidence required below.

## Problem

Applicant assignment creates a native `RecruitmentInterview`. The native model stops before scheduling.

The current `/dashboard/intervjuer` route still reads Symfony interviews. Its scheduling form also sends data to Symfony.

The legacy command trusts browser sender and recipient addresses. It stores a permanent plaintext response code.

The legacy server commits the schedule before it sends email and SMS. It has no replay or concurrency contract.

A direct endpoint replacement preserves these faults. This slice establishes one native scheduling authority instead.

## User journey

1. An active staff member signs in through the existing dashboard authentication seam.
2. The user opens `/dashboard/intervjuer`.
3. The Foldkit program reads the native scheduling board.
4. The board shows interviews that the user can schedule.
5. The user opens one unscheduled interview.
6. The form shows the applicant and assigned interviewer from authoritative projections.
7. The user enters a future instant, room, optional campus, optional map link, and a message.
8. The user submits one decoded `ScheduleInterview` command.
9. Recruitment stores the schedule, invitation, receipt, audit, and notification request in one transaction.
10. The transaction does not contact an email or SMS provider.
11. The Foldkit command reads the scheduling board again.
12. The board shows the stored schedule and `Pending` applicant-response state.
13. The interface reports the notification as queued unless delivery evidence states another result.

The command response is not final interface evidence. Only the fresh board observation can replace the board model.

## Authority graph

The scheduling journey uses this graph:

```text
Database
├─ Admissions ── Organization
├─ Organization
├─ Profile ── Organization
└─ Recruitment ── Admissions + Organization + Profile

Recruitment invitation outbox
└─ NotificationGateway interpreter
```

Recruitment owns the schedule, invitation, response state, command receipt, audit fact, and approved notification request.

Admissions owns the applicant email and phone. Profile owns the assigned interviewer contact projection.

The browser does not own sender, recipient, capability, actor, department, current state, or revision authority.

`NotificationGateway` owns delivery of an approved request. It does not own the scheduling transition.

Recruitment does not require `NotificationGateway`. The durable outbox separates the two authorities.

## State model

Scheduling, applicant response, notification delivery, and interview completion are separate dimensions.

```text
assignment
  absent | assigned

schedule
  absent | stored

applicant response
  absent | Pending | Accepted | Rejected | RequestedNewTime

notification delivery
  Pending | Processing | Delivered | Failed | Quarantined

completion
  not completed | completed
```

This slice creates the first stored schedule and the first `Pending` response. Later journeys own other transitions.

### Recruitment interview

`RecruitmentInterview` remains the assignment aggregate root. It owns:

- immutable interview, application, department, interviewer, schema, and assigner identities.
- the assignment instant.
- a non-negative aggregate revision.

Migration 0011 removes the obsolete `state` and `scheduled_at` assignment columns. Migration 0010 rows keep all assignment facts.

### Interview schedule

`RecruitmentInterviewSchedule` is present only for a scheduled interview. It owns:

- immutable `interviewId`.
- `scheduledAt` as an RFC3339 instant.
- non-empty `room`.
- optional `campus`.
- optional HTTPS `mapLink`.
- a bounded human message.
- the person that scheduled the interview.
- the commit instant.
- the interview revision that created the schedule.

The schedule record contains the complete tuple. The database does not represent a partial schedule.

### Invitation

`RecruitmentInvitation` is present only after scheduling. It owns:

- immutable invitation identity.
- interview identity and schedule revision.
- a unique SHA-256 capability digest.
- response state `Pending` for this slice.
- the creation instant.

The raw capability is not stored in this table. The invitation response slice defines response transitions.

### Contact projection

Profile gains a contact projection for staff notification identity. The projection owns:

- person identity.
- email.
- phone.
- revision.

Recruitment reads the assigned interviewer contact through Profile. Missing contact is a typed integrity failure.

Recruitment reads the applicant email and phone through Admissions. The command cannot override either contact.

## Scheduling board

`readSchedulingBoard` returns one strict observation. It contains:

- the actor department.
- interviews in deterministic assignment order.
- applicant identity, name, email, and phone projection.
- assigned interviewer identity, display name, email, and phone projection.
- interview revision.
- nullable stored schedule.
- applicant-response state, which is absent or `Pending` in this slice.
- notification delivery state, when an outbox row exists.

An active department leader reads all assigned interviews in their department.

An active member reads only interviews where `interviewerPersonId` equals the actor person identity.

`GlobalAdmin` remains denied until the native Identity policy defines department scope.

The board does not require an open application window. Recruitment can continue after application submission closes.

## Input rules

The command contains:

- `commandId`.
- `interviewId`.
- `expectedRevision`.
- `scheduledAt`.
- `room`.
- optional `campus`.
- optional `mapLink`.
- `message`.

The command does not contain sender, recipient, capability, department, actor, or response state.

The server rejects these values:

- an invalid RFC3339 instant.
- an instant that is not later than the observed server instant.
- an empty room.
- a non-HTTPS map link.
- a map link with user credentials.
- a message that is empty or longer than 2,000 characters.
- unknown properties.

The server does not probe the map URL. Form preview is a local Foldkit projection and causes no server effect.

## Authorization

Recruitment evaluates authorization for each read and command.

- An inactive actor receives `403`.
- A department leader can schedule interviews in their department.
- A member can schedule only an interview assigned to that person.
- Recruitment checks that the member has a current, non-suspended Organization membership.
- A cross-department actor receives `403`.
- A different member receives `403`.
- A global administrator receives `403` in this slice.
- Missing or invalid credentials receive `401`.

Authorization runs before stored command replay returns an observation. A revoked actor cannot use replay as a read path.

## Command transaction

The execution context contains:

- the authenticated actor.
- one observed server instant.
- a server-generated invitation identity.
- a server-generated 256-bit response capability.

The transaction uses this order:

1. Lock the command identity.
2. Lock the interview identity.
3. Read and lock the interview and application scope.
4. Evaluate current actor authorization.
5. Read the stored command receipt.
6. Return an identical stored observation with `replayed=true`.
7. Reject changed bytes under the same command identity.
8. Check `expectedRevision`.
9. Reject an interview that already has a schedule.
10. Read authoritative applicant and interviewer contacts.
11. Store the schedule.
12. Increment the interview revision.
13. Store the invitation capability digest and `Pending` response state.
14. Store the canonical command receipt and observation.
15. Store one scheduling audit fact.
16. Store one approved invitation outbox request.
17. Commit all rows or no rows.

An identical replay writes no rows. The replay result contains the exact stored observation.

A stale revision changes no row. A conflicting command identity changes no row.

A second first-schedule command fails. Staff rescheduling is a separate journey.

## Capability security

The backend creates 32 random bytes. It encodes the bytes as an opaque URL-safe capability.

Recruitment stores only `SHA-256(capability)` in the invitation table. Capability lookup uses the digest.

The raw capability exists in the pending outbox payload because the notification needs the link.

The outbox interpreter removes the sensitive payload after delivery or quarantine. Logs, receipts, audits, and board observations omit the raw capability.

The capability is valid only for the current pending invitation and schedule revision. A later reschedule rotates it.

## Notification request

The transaction stores one `SendInterviewInvitation` request. The request contains semantic template data:

- deterministic effect identity.
- command, interview, invitation, and schedule identities.
- applicant email and phone.
- assigned interviewer display and contact projection.
- scheduled instant and location.
- the approved human message.
- the raw capability for link construction.

The request does not contain rendered HTML or a provider-specific payload.

A separate worker claims requests in deterministic order. The worker checks the envelope against canonical receipt and interview rows.

The worker supplies the effect identity as the provider idempotency key. Failed delivery changes only outbox state.

A recording `NotificationGateway` supplies local proof. It records the approved request and performs no network operation.

This slice does not claim real provider delivery.

## Native HTTP and SDK

The native backend exposes:

```text
GET  /api/admin/recruitment/interviews/scheduling-board
POST /api/admin/recruitment/interviews/schedule
```

The SDK extends `admin.recruitment`. It strictly decodes the query, command, observation, result, and tagged failures.

The old dashboard scheduling caller stops using:

- `admin.interviews.list`.
- `admin.interviews.read`.
- `admin.interviews.schedule`.

No alias forwards these operations to Recruitment. Legacy methods can remain only for named unmigrated callers.

## Foldkit ownership

`/dashboard/intervjuer` uses the shared Foldkit dashboard shell and a dedicated scheduling program.

React Router owns:

- authentication transport.
- the initial server read.
- strict custom-element attribute encoding.
- the same-origin Recruitment bridge.

React owns no scheduling list, selection, form, request, or feedback state.

The Foldkit model owns:

- strict initial-input validity.
- scheduling-board `AsyncData`.
- selected interview.
- schedule fields.
- dialog visibility.
- request identity and generation.
- scheduling in-flight state.
- visible success or failure feedback.

The Foldkit update function emits Effect commands as values. It ignores stale asynchronous observations.

A successful POST causes a new board read. Only that read can close the dialog and show success.

The interface does not state that an invitation is delivered when the database only warrants `Pending`.

The existing mixed interview program retains only the candidate-response journey until design spec 0051 replaces it.

## Required evidence

### Portable capability evidence

PGlite uses the canonical migration manifest. It observes:

- one accepted schedule.
- one schedule, invitation, receipt, audit, and outbox row.
- identical replay without another write.
- conflicting command reuse.
- stale revision rejection.
- duplicate first-schedule rejection.
- unauthorized and cross-department rejection.
- invalid input rollback.
- relational constraint rejection.
- recording notification interpretation without a network request.
- sensitive payload removal after interpretation.

PGlite does not prove PostgreSQL locking behavior.

### PostgreSQL evidence

Disposable PostgreSQL observes:

- interview and command advisory-lock serialization.
- two concurrent commands for one revision produce one accepted transition.
- exact replay under concurrency writes one effect request.
- transaction rollback leaves no partial row.
- outbox claim and stale-claim recovery obey PostgreSQL semantics.

### Boundary evidence

HTTP and SDK evidence covers:

- strict request and response decoding.
- oversized and malformed bodies.
- every actor variant.
- typed schedule failures.
- exact native routes and stable string identities.

### Browser evidence

A real browser uses the native backend and disposable PostgreSQL. The user schedules an assigned interview on `/dashboard/intervjuer`.

The browser observes the stored schedule after a fresh read. The browser sends no Symfony scheduling request.

The proof observes no external provider request. A recording interpreter observes the approved notification request.

## Scope holds

This slice does not implement:

- applicant confirm, reject, or request-new-time transitions.
- staff rescheduling.
- provider-backed email or SMS delivery.
- interview completion, answers, or scoring.
- co-interviewer assignment.
- interview cancellation or deletion.
- Profile mutation.
- global-administrator policy.
- Identity credentials or sessions.
- production data import.
- deployment.

## Definition of done

1. This frozen contract precedes implementation changes.
2. Recruitment owns one schedule transition and one strict scheduling-board query.
3. Assignment, schedule, response, delivery, and completion state remain separate.
4. The transaction stores schedule, invitation, receipt, audit, and outbox rows together.
5. Exact replay writes nothing. Stale or conflicting commands change nothing.
6. Current actor scope is checked before accepted replay returns.
7. Recipient and sender contact facts come from authoritative Services.
8. The raw capability is absent from canonical invitation rows, receipts, audits, logs, and interface observations.
9. The notification provider is outside the scheduling transaction.
10. Native HTTP and SDK boundaries strictly decode all scheduling values and failures.
11. `/dashboard/intervjuer` uses full Foldkit and the native Recruitment SDK.
12. Foldkit performs a fresh board read after the command.
13. The migrated browser path has no Symfony scheduling call or compatibility route.
14. Portable, PostgreSQL, boundary, accessibility, and browser evidence passes on the committed revision.
15. Root type, format, lint, test, build, and migration replay checks pass.
16. Production delivery, deployment, and Identity cutover remain unclaimed.

## Falsifiers

- One enum conflates schedule, applicant response, delivery, and completion.
- A partial schedule tuple can exist.
- The browser supplies sender, recipient, capability, actor, department, state, or revision authority.
- A member schedules an interview assigned to a different person.
- A revoked actor reads an accepted command through replay.
- A schedule commits without its invitation, receipt, audit, or outbox row.
- Provider delivery runs inside the schedule transaction.
- Identical replay creates another outbox request.
- A stale command changes the schedule.
- The raw response capability appears in a receipt, audit, log, board, or rendered page.
- The interface reports provider delivery from schedule persistence.
- React owns scheduling interaction state.
- A stale asynchronous read replaces a newer Foldkit board.
- The interface reports success from the POST response without a fresh GET.
- The browser calls Symfony interview list, read, or schedule operations.
- PGlite evidence is reported as PostgreSQL concurrency proof.
- A recording interpreter is reported as provider-delivery proof.
