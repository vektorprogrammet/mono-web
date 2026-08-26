# Design spec 0051 - Native recruitment invitation response

> **Summary:** An applicant responds to a native interview invitation. Recruitment stores one outcome and exposes it through fresh applicant and staff reads.

## Metadata

| Field             | Value                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status            | Contract remains frozen at revision 0051.2; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence are pending |
| Base              | `1f7fe7424cd06e26a9713fd284c77fce71ee990e`                                                                                                                                           |
| Goal              | Replace the Symfony invitation-response seam with one native Recruitment authority and one full-Foldkit applicant journey                                                            |
| Actor             | Applicant who holds the current invitation capability                                                                                                                                |
| Observers         | Active department leader and assigned active interviewer                                                                                                                             |
| Routes            | `/interview-response/:capability` and `/interview-response/redacted`                                                                                                                 |
| Dependency        | Native interview scheduling from design spec 0050                                                                                                                                    |
| Architecture      | Design specs 0040 and 0045                                                                                                                                                           |
| Operator boundary | No production data, credentials, deployment, remote provider, or external notification effect                                                                                        |
| Scope hold        | Identity credentials, sessions, and access-policy authority remain final                                                                                                             |
| Revision          | 0051.2 binds every browser page to one exchanged capability and rejects capability-shaped response messages before any authority transition; 0051.1 made rejection messages optional |

## Problem

Design spec 0050 creates a scheduled interview and a digest-only invitation. The invitation starts with the `Pending` response state.

The applicant interface already uses full Foldkit. However, its server bridge and SDK still call Symfony response routes.

The accepted parity evidence also comes from Symfony and disposable SQLite. It does not prove native authority or PostgreSQL behavior.

The native Recruitment Service has no capability read or response transition. Its database constraint permits only the `Pending` state.

## User journey

1. The applicant opens the invitation link.
2. React Router sends the capability to the native SDK on the server.
3. Recruitment reads the current invitation by its capability digest.
4. React Router stores the capability in an HttpOnly cookie.
5. React Router redirects to `/interview-response/redacted`.
6. Foldkit shows the stored schedule and the available response actions.
7. The applicant confirms, rejects, or requests another time.
8. Foldkit sends one decoded command through the same-origin bridge.
9. Recruitment locks the current invitation and applies one valid transition.
10. Recruitment stores the response, audit fact, and approved notification request atomically.
11. Foldkit performs a new server read.
12. Foldkit shows the stored response state.
13. The department leader performs a new scheduling-board read.
14. The assigned interviewer performs a separate scheduling-board read.
15. Each observer sees the response allowed by its current authority.

The command response is not final interface evidence. Only a new read can replace the Foldkit model.

## Authority graph

```text
invitation link
  -> React Router capability exchange
  -> HttpOnly SameSite=Strict cookie
  -> same-origin Foldkit bridge
  -> strict public Recruitment SDK
  -> native Recruitment HTTP
  -> Recruitment Service
  -> authoritative PostgreSQL invitation and schedule

Pending response
  -> Accepted
  -> Rejected
  -> RequestedNewTime

Rejected or RequestedNewTime
  -> durable response-notification request
  -> recording NotificationGateway in local evidence

fresh applicant read
  <- capability digest lookup

fresh staff read
  <- Recruitment scheduling board
  <- Admissions applicant projection
  <- Profile interviewer projection
  <- Organization actor scope
```

The capability authorizes only one current invitation. Identity does not authorize the applicant journey.

Recruitment owns the invitation, response, audit fact, and approved notification request. It also owns the response transition.

Admissions owns applicant facts. Profile owns assigned-interviewer contact facts. Organization owns current staff scope.

`NotificationGateway` owns delivery interpretation. It does not own the response transition.

## Semantic state

Schedule, response, delivery, and completion remain separate dimensions.

```text
schedule
  Scheduled

applicant response
  Pending | Accepted | Rejected | RequestedNewTime

response notification
  absent | Pending | Processing | Delivered | Failed | Quarantined

interview completion
  NotCompleted | Completed
```

This slice changes only the applicant-response dimension. It can add one approved response-notification request.

It does not delete the assignment, schedule, invitation, application, or historical audit facts.

## Capability contract

The raw capability is the 43-character base64url value created by design spec 0050. Recruitment stores only its SHA-256 digest.

The dashboard receives the raw capability only on the exchange request. It stores the value in an HttpOnly, SameSite=Strict cookie.

The browser URL changes to `/interview-response/redacted` before the interactive view appears. The response bridge reads the server-held cookie.

The SDK sends the capability in a dedicated authorization header. Native API paths do not contain the capability.

The capability can read the current invitation after a response. This rule makes the required post-command read possible.

Mutation authority exists only while the response state is `Pending`. A repeated or competing transition is rejected.

A later reschedule supersedes the invitation and rotates the capability. A superseded capability cannot read or change the replacement invitation.

This slice adds no wall-clock expiry. Legacy behavior defines no duration, and no accepted policy supplies one.

Malformed, unknown, and superseded capabilities produce the same public not-found response. They reveal no invitation facts.

The raw capability must not appear in these artifacts:

- the database outside the transient notification payload from design spec 0050.
- a response, audit, notification, receipt, log, or error.
- a rendered page or browser evidence artifact.
- a staff scheduling-board observation.

## Applicant observation

A valid applicant read returns these facts:

- the scheduled instant.
- the room.
- the campus, when present.
- the response state.
- the response message, when the stored outcome permits it.

The read omits interview, application, person, department, schedule-revision, and capability identifiers. It also omits staff contact facts.

The read remains valid for the current invitation after `Accepted`, `Rejected`, or `RequestedNewTime`.

## Response transitions

### Confirm

`Pending -> Accepted`

Confirm accepts no message. It stores the response instant and one audit fact.

Confirm creates no response-notification request.

### Reject

`Pending -> Rejected`

Reject accepts an optional message of at most 2,000 characters. A blank message becomes absent.

The transaction stores the response, one audit fact, and one approved notification request for the assigned interviewer.

### Request another time

`Pending -> RequestedNewTime`

Request-another-time requires a nonblank message of at most 2,000 characters.

The transaction stores the response, one audit fact, and one approved notification request for the assigned interviewer.

The transition retains the existing schedule. It does not schedule a replacement.

### Repeated or competing commands

Every transition requires the current `Pending` state. A non-Pending invitation returns one typed conflict and changes no row.

These commands are not replayable command receipts. A lost response is recovered with the required fresh read.

Two concurrent first transitions produce exactly one accepted transition. Every loser receives the same typed non-Pending conflict.

## Transaction laws

One database transaction performs these actions:

1. Hash and resolve the supplied capability.
2. Lock the current invitation.
3. Check its current schedule linkage.
4. Check the `Pending` response state.
5. Decode the command and message.
6. Resolve approved interviewer contact facts when notification is required.
7. Store exactly one response outcome.
8. Store exactly one linked audit fact.
9. Store exactly one linked notification request when required.
10. Commit all rows together.

A failure before commit leaves every response, audit, and notification row unchanged.

Database constraints enforce invitation, response, audit, schedule, and notification linkage. Application checks do not replace relational laws.

PGlite proves portable transaction behavior. It does not prove PostgreSQL row-lock concurrency.

## Notification contract

`Rejected` and `RequestedNewTime` create one provider-neutral notification request for the assigned interviewer. `Accepted` creates none.

The request contains the applicant display name, scheduled instant, response state, and response message when present.

The request does not contain the raw capability, provider payload, sender address, department authority, or browser-supplied recipient facts.

The response transaction does not call a provider. A supervised interpreter claims the request after commit.

Local evidence uses a recording `NotificationGateway`. It observes no live provider request and proves no provider delivery.

Co-interviewer delivery is outside this slice because native Recruitment has no co-interviewer authority.

## Staff observations

An active department leader reads all scheduled interviews in the leader's current department. The board shows each stored response state.

An active assigned interviewer reads interviews assigned to that person. The member board shows `Accepted` and `RequestedNewTime` rows.

The member board omits a `Rejected` interview. The leader board retains the row and shows `Rejected`.

A suspended, inactive, cross-department, or unprofiled actor cannot read the response through the staff board.

A staff observer never receives the raw capability or response-notification payload.

## Native HTTP and SDK boundary

The native backend exposes one stable capability read and three stable transition operations:

- `GET /api/recruitment/invitation-response`.
- `POST /api/recruitment/invitation-response/confirm`.
- `POST /api/recruitment/invitation-response/reject`.
- `POST /api/recruitment/invitation-response/request-new-time`.

These routes do not require an Identity bearer token. They require the dedicated Recruitment invitation capability header.

Every request and response uses strict Effect Schema decoding. Excess properties, malformed values, and oversized bodies fail before the Service transition.

The public boundary maps malformed, unknown, and superseded capabilities to one opaque `404` response.

Invalid input returns a typed `422` response. A non-Pending transition returns a typed `409` response.

Response messages reject every 43-character base64url capability-shaped sequence before the Service transition. The database repeats this confinement law for canonical response, audit, and outbox message fields.

The SDK exposes one public Recruitment invitation domain. It does not retain the Symfony `interviewResponses` domain or compatibility paths.

The staff Recruitment SDK decodes every expanded response state strictly.

## Foldkit ownership

React Router owns route matching, capability exchange, cookie transport, the same-origin action bridge, and initial rendering.

Each successful exchange creates a cryptographically random, non-secret interaction identifier. The HttpOnly capability cookie is named for that interaction. The redacted page and every bridge request carry only the interaction identifier. The server resolves exactly that cookie before each read or transition. Opening or invalidating another invitation cannot retarget or erase an existing tab's authority.

Foldkit owns all applicant interaction state:

- the candidate observation.
- the selected action.
- the message field and validation.
- in-flight exclusion.
- failure feedback.
- the fresh read after a successful command.
- stale asynchronous result rejection.

React does not own a candidate response store, effect, form state, or optimistic result.

The bridge returns safe tagged failures. It does not expose the capability, backend headers, or persistence details.

The production bridge has no fixture-authentication branch or owner-selection flag after cutover.

## Accepted parity journeys

One native browser run emits separate canonical receipts for these accepted journey references:

- `intent://journey:recruitment:invitation-response:v1`.
- `intent://journey:parity:applicant_notify_self:v1`.
- `intent://journey:parity:interview_candidate:v1`.
- `intent://journey:parity:interview_recruiter:v1`.

The invitation-response receipt covers these exact steps:

- `applicant-loads-invitation`.
- `applicant-confirms-invitation`.
- `applicant-rejects-invitation`.
- `applicant-requests-new-time`.
- `fresh-applicant-response-read`.
- `fresh-leader-response-read`.
- `fresh-interviewer-response-read`.
- `invalid-response-preserves-state`.
- `response-capability-remains-private`.

The three broad parity receipts cover their existing four exact step identifiers. The runtime-evidence authority must accept the native receipts.

The functional-parity inventory must link these native receipts before the slice is accepted as native evidence.

## Required evidence

### Model and state evidence

Focused schema and state tests prove these rules:

- exact capability syntax.
- all response states.
- required and optional message laws.
- Pending-only transitions.
- in-flight command exclusion.
- typed failure preservation.
- mandatory fresh read after success.
- stale asynchronous result rejection.

### Portable database evidence

PGlite uses the canonical migration manifest. It observes these facts:

- valid capability reads.
- each accepted transition.
- stored state, message, response instant, and audit linkage.
- no notification row for `Accepted`.
- one notification row for `Rejected` and `RequestedNewTime`.
- malformed, unknown, and superseded capability isolation.
- invalid-state and invalid-input rollback.
- transaction rollback without partial rows.
- leader and member projection rules.
- absence of the raw capability from canonical rows and evidence.

### PostgreSQL evidence

A disposable PostgreSQL proof executes two concurrent transitions against one `Pending` invitation.

The proof observes one winner, one typed conflict, one response, one audit, and the exact permitted notification count.

The proof also observes rollback release and relational constraint rejection. PGlite output cannot substitute for this proof.

### HTTP and SDK evidence

Focused HTTP and SDK tests prove strict capability headers, bodies, responses, failures, body limits, and excess-property rejection.

They also prove the absence of every Symfony response path and raw capability value in returned payloads.

### Browser evidence

A real Chromium journey uses the native backend and disposable PostgreSQL. It creates three deterministic `Pending` invitations.

The browser confirms one invitation, rejects one, and requests another time for one. Each action performs a fresh applicant read.

Independent leader and member contexts perform fresh reads. Their views obey the staff projection rules.

Committed database evidence matches every interface state. Invalid and repeated transitions leave the stored state unchanged.

Request capture observes no Symfony response request and no provider-network request. A recording interpreter observes only approved notification requests.

The browser URL, DOM, console, request artifacts, database evidence, and canonical receipts contain no raw capability.

The browser run emits the four canonical parity receipts named by this contract.

## Definition of done

1. This frozen spec precedes implementation commits.
2. Recruitment exposes one capability read and three distinct response transitions.
3. The database permits only complete response states and enforces every linkage law.
4. All accepted writes store the response and audit atomically.
5. Rejection and new-time requests store one approved notification request atomically.
6. Confirmation stores no response-notification request.
7. Repeated and competing transitions change no row after one winner.
8. Applicant and staff views come from fresh native reads.
9. Member and leader projections obey their different rejected-interview rules.
10. Native HTTP and SDK boundaries strictly decode every value and failure.
11. The applicant journey uses full Foldkit and a server-held capability.
12. No production caller uses the Symfony response SDK domain or route.
13. No compatibility endpoint, fixture branch, owner flag, fallback, or dual write remains for this journey.
14. PGlite transaction and relational tests pass.
15. Disposable PostgreSQL concurrency and rollback proofs pass.
16. Focused domain, backend, SDK, Foldkit, accessibility, and browser checks pass.
17. The real native browser journey passes with zero provider-network requests.
18. The runtime-evidence authority accepts four native receipts.
19. The parity inventory links the native receipts to all four accepted journey references.
20. Root format, type, lint, test, build, and migration replay checks pass on the committed revision.

## Falsifiers

The slice is incomplete if one condition occurs:

- Symfony handles a capability read or response transition.
- A capability appears in a native API path, rendered page, log, database proof, or receipt.
- The backend requires an Identity session for the applicant capability.
- A malformed, unknown, or superseded capability reveals invitation facts.
- A non-Pending or competing command changes a row.
- A second valid capability exchange retargets an earlier tab's read or irreversible transition.
- An invalid capability exchange clears another tab's interaction binding.
- A capability-shaped sequence reaches a response, audit, outbox, projection, rendered page, log, or evidence artifact through a response message.
- Two concurrent transitions both succeed.
- A response commits without its audit fact.
- A required notification request is absent or duplicated.
- A provider call runs inside the response transaction.
- A provider failure rolls back the stored response.
- A rejected interview remains in the assigned member board.
- A rejected interview disappears from the leader board.
- The interface reports success without a fresh server read.
- React owns applicant interaction state.
- A fixture or source assertion is reported as native browser evidence.
- PGlite output is reported as PostgreSQL concurrency proof.
- Recording output is reported as provider-delivery proof.
- A native receipt is absent from the accepted runtime-evidence authority.
- The parity inventory still links a legacy Symfony receipt for any covered journey in this slice.

## Non-goals

This slice does not authorize production deployment, production data, credentials, remote providers, or external notification delivery.

It does not add wall-clock capability expiry, rescheduling, co-interviewers, interview completion, or application-state mutation.

It does not cut over Identity credentials, sessions, profile mutation, or staff access-policy authority.
