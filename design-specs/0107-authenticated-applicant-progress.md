# 0107 — Authenticated applicant progress

Status: implemented and observed locally, 2026-09-20. Production release unclaimed.

Baseline: `a1291cb4075f9d74f4ef01c42316d39ecc603b54` (`migration/assistant-operations-0906`).
The accepted tree contains no `0107` design spec. This document claims `0107` for this bounded journey.
Acceptance: runtime revision `f5a98af9e2f2b887f9a79c54dea9ed4bdad36405`; see [the acceptance manifest](../evidence/functional-parity/0107/acceptance-manifest.json).

## Goal and product boundary

A signed-in Person whose account is explicitly linked to an Applicant can open the native dashboard, see every linked application in the current semester, and understand its current recruitment progress and next action. Reloading after a real source transition shows the new state.

Progress is a read-only derivation of authoritative application, interview, schedule, invitation-response, completed-conduct, cancellation, returning-registration and active-placement facts. It is not persisted as a second status column.

This journey does not introduce an assistant admission decision. Legacy assistant admission is derived from active school history, not a persisted Accept/Reject/Waitlist value. Interviewer recommendation, score and assessment history remain private staff data and never become applicant progress.

Applicant progress and completion receipts are separate accepted parity items. `0107` implements progress only. It creates no notification, outbox request, delivery acknowledgement or claim that an applicant received a completion message.

## Source-backed behavior

The legacy authenticated journey is `GET /min-side` in `apps/server/src/App/Identity/Controller/UserController.php`. It selects the signed-in user's application for their current department and semester, then derives progress through `ApplicationManager` and `ApplicationStatusRule`.

The live legacy rule has this precedence:

1. active assistant school history → assigned to school;
2. previous assistant → application received, with no interview required;
3. no interview → application received;
4. completed interview → interview completed;
5. otherwise invitation state maps to awaiting invitation, awaiting a new time, invited, accepted or cancelled.

`DashboardProvider` exposes the same current application status, title, description, scheduled instant and room. The applicant templates show a five-step process and never expose interviewer answers, scores or recommendation.

Native identity ownership comes only from `applicant_account_links`, established by `0099`. Email equality is never ownership proof. Native current facts already live in `admission_applications`, admission periods/semesters, recruitment interviews, schedules, invitation responses, completed conducts, cancellations, `0038` returning registrations and `0032` active placements.

## Observable contract

### Selection and identity

- The HTTP boundary accepts no PersonId, ApplicantId, department or application selector. The authenticated session Person is the only subject.
- Read applications through `applicant_account_links`; an unlinked Person receives an empty progress list, not another applicant's data.
- Return all linked applications whose admission-period semester contains the server observation instant. Sort newest submission first, then stable ApplicationId. This avoids selecting an arbitrary department when one Person has multiple explicitly linked applicant records.
- Historical and future-semester applications remain outside this current-progress projection. Historical classification/backfill remains separate.
- Missing, expired or revoked credentials return `401` before any progress source read. No organization membership is required: account ownership and volunteer affiliation are separate facts.

### Progress states

Each application exposes one discriminated progress state plus ApplicationId, AdmissionPeriodId, DepartmentId, SemesterId and submission instant.

| State | Authoritative condition and precedence | Applicant meaning |
| --- | --- | --- |
| `AssignedToSchool` | An active placement exists for the linked Person in the application's department and semester. Highest precedence. | Taken on as an assistant; contact partners and attend the school. |
| `InterviewCompleted` | A completed conduct exists, or the application has an immutable `0038` returning-assistant registration. | Application is being assessed; await separate notification. |
| `Cancelled` | A cancellation exists or the current invitation response is `Rejected`. | No further action in this recruitment path. |
| `AwaitingNewInterviewTime` | Current invitation response is `RequestedNewTime`. | Wait for a replacement time. Do not present the superseded time as current. |
| `InterviewAccepted` | Current invitation response is `Accepted`. | Attend at the returned current scheduled instant and room. |
| `InvitedToInterview` | A current invitation exists with `Pending` response. | Respond through the separately delivered capability journey. |
| `ApplicationReceived` | No interview, no current invitation, or another nonterminal unscheduled state. | Wait for an invitation. |

A state cannot carry fields that are meaningless for that state. `InvitedToInterview` and `InterviewAccepted` carry the current schedule: instant, room, campus and optional map link. Other variants do not carry schedule fields. The UI owns Norwegian presentation text and the fixed five legacy process labels; the API owns semantic states and source values.

The response never contains applicant email/phone, interviewer identity/contact, answers, scores, recommendation, correction history, capability token, account-link metadata, placement school/partners or staff-only audit data.

### HTTP and dashboard

- Add one authenticated read endpoint to the generated native API and SDK. It returns a no-store, private projection.
- Add one dashboard destination reachable from the signed-in identity menu. A linked applicant sees current application cards, semantic status, next action and five-step progress. An unlinked or out-of-semester Person sees an explicit empty state.
- The accepted schedule state shows time and room; the invited state shows the proposed schedule without a response mutation control. `0051` remains the separate capability-based invitation-response journey.
- Desktop and mobile layouts preserve step order and current/completed semantics without color-only meaning. Keyboard navigation, headings and status announcements remain accessible.

## Authority, freshness and failure semantics

- Resolve the session and Person inside the read transaction/snapshot. The query keys only from that PersonId and explicit applicant links.
- Use the server observation instant for current-semester selection. The client cannot submit a clock.
- Derive progress in one bounded read so mixed revisions do not create an impossible status.
- Malformed or internally inconsistent source rows fail closed as `503`; they do not become an empty list or guessed state.
- Credential failure is `401`. An authenticated unlinked Person receives `200` with an empty list. The projection does not reveal whether a supplied email or ApplicantId exists because neither is accepted.
- Every successful response is `Cache-Control: no-store` and `Referrer-Policy: no-referrer` through the existing private HTTP semantics.

## Acceptance gates and falsifiers

- Apply the complete canonical migration chain to disposable PostgreSQL and seed synthetic linked/unlinked Persons plus current, historical and future applications.
- Sign in through the real native identity engine. Drive the generated SDK/API and production dashboard build in Chromium.
- Observe, in order, application received, invited, accepted, requested-new-time, rejected/cancelled, completed interview, returning-registration completion, and active placement. Reload after source transitions.
- Prove active placement and completed conduct precedence over stale lower progress facts.
- Prove current-semester filtering and deterministic ordering with multiple explicit links and departments.
- Prove an unlinked Person gets an empty list; anonymous, expired and revoked credentials get `401`; no email equality or request parameter can select another applicant.
- Assert every forbidden private field and capability secret is absent from HTTP bodies, DOM, screenshots and retained artifacts.
- Inject malformed/inconsistent source data where constraints permit and observe fail-closed behavior, not a guessed or empty projection.
- Observe desktop/mobile, keyboard access, reload, Axe and page-error capture.
- Run affected package type checks/tests, API generation freshness, documentation generation freshness, capability-parity freshness and changed-file formatting separately from runtime evidence.
- Gate the exact committed executable revision from a clean checkout. Retain sanitized evidence and remove disposable PostgreSQL, browser, credentials and temporary runtime artifacts.

Any implementation that accepts an applicant/person selector, links by email, persists a second mutable progress status, exposes assessment or contact data, treats recommendation as admission, sends a completion message, adds an admission decision, chooses one of several linked current applications arbitrarily, or reports global parity falsifies this slice.

## Boundaries and follow-on work

Local synthetic implementation and rehearsal only. No production data, credentials, provider action, remote push, deployment or cutover authority.

This journey does not implement completion receipts or their acknowledged delivery; coordinator admission decisions; co-interviewer assignment; initial co-interviewer conduct; historical first-time classification; automatic scheduling; applicant account linking; invitation-response mutation; affiliation approval or placement mutation; events; surveys; certificates; statistics; exports; real-data reconciliation; or production cutover.

The accepted continuation plan and `STATE.md` govern later journeys. Completion receipts require their own source-backed contract, durable effect ownership and observed transport semantics.
