# 0106 — Co-interviewer authority for completed assessment correction

Status: frozen for local implementation, 2026-09-20. Production release unclaimed.

Baseline: `5a02d48424be1e5138f96ddb8519c6e846b63d40` (`migration/assistant-operations-0906`).
The accepted tree contains no `0106` design spec. This document claims `0106` for this bounded journey.

## Goal and product boundary

A designated, current active co-interviewer can find their completed native interview, open its assessment, append a correction, reload, and see the same effective assessment and immutable history as the primary interviewer.

The designation already exists on the interview. Creating, changing, clearing, importing, or notifying a co-interviewer is not part of this journey. Local evidence provisions the designation as synthetic fixture data. A future assignment journey must define its own authority, eligibility, notification, idempotency, and audit contract.

The correction reuses the complete `0105` assessment contract:

- answers against the immutable per-interview question snapshot;
- three integer scores from `0` through `10`;
- one explicit recommendation: `Ja`, `Kanskje`, or `Nei`;
- immutable original completion, finalizer, time, and assessment;
- append-only replacement assessment, receipt, and audit;
- optimistic concurrency and exact-command replay.

It does not grant co-interviewers finalization, cancellation, scheduling, assignment, reporting, applicant administration, identity, affiliation, placement, or admission authority. It sends no notification.

## Felt journey

1. A synthetic completed interview has one primary interviewer and one distinct co-interviewer in the same department.
2. The co-interviewer signs in with a current active native Person identity and department membership.
3. `/dashboard/intervjuer` includes the completed interview because the actor is its co-interviewer. An ordinary unassigned member does not receive it.
4. The co-interviewer opens the existing interview detail. The read performs the existing applicant known-self check before exposing questions, answers, scores, recommendation, or history.
5. The detail identifies the primary interviewer and co-interviewer without exposing unrelated staff or applicant fields.
6. The co-interviewer chooses **Rett intervju**, edits the answers, scores, and recommendation, and submits the existing correction command with the displayed revision, opaque `If-Match`, and one idempotency key.
7. The transaction re-resolves current identity, membership, department, co-interviewer designation, and applicant custody before receipt lookup or assessment access.
8. The server appends one correction assessment, advances the interview revision, and appends one correction receipt and audit row atomically. The original completion facts remain unchanged.
9. The client performs fresh detail and scheduling-board reads. Reload shows the corrected effective assessment and ordered Original/Correction history.
10. The primary interviewer subsequently reads the same effective assessment and history. There is one shared interview aggregate, not one assessment per interviewer.

A failed correction preserves the local draft and displays the existing typed failure. A stale command never merges or replaces the draft.

## Legacy evidence and deliberate native boundary

Legacy Symfony stores a nullable `coInterviewer` relation on `Interview`. `InterviewManager::loggedInUserCanSeeInterview` grants visibility to a team leader, the primary interviewer, or the co-interviewer. Assigned and uncompleted interview queries include primary OR co-interviewer. `InterviewController::showAction` and `conductAction` therefore permit a co-interviewer, subject to applicant-self denial, to read, conduct, and edit the same interview.

The relevant checked-in sources are:

- `apps/server/src/App/Interview/Infrastructure/Entity/Interview.php`;
- `apps/server/src/App/Interview/Infrastructure/InterviewManager.php`;
- `apps/server/src/App/Interview/Controller/InterviewController.php`;
- `apps/server/src/App/Admission/Infrastructure/Repository/ApplicationRepository.php`;
- `apps/server/src/App/Interview/Infrastructure/Repository/InterviewRepository.php`.

Legacy also permits self-assignment, administrative assignment, clearing, scheduling, initial conduct, and broad team-leader visibility through routes whose dynamic production access rules are not fully established. Those operations are not silently copied into this correction slice. Native department authority, current membership, known-self denial, and the `0105` correction invariants remain binding.

## Authority and invariants

| Fact | Authority | Rule |
|---|---|---|
| Current actor | Identity and Organization | Resolve the live Person and current active membership at every board read, detail read, correction, and replay. |
| Primary interviewer | Recruitment interview | Existing required `interviewer_person_id`; unchanged by this journey. |
| Co-interviewer | Recruitment interview | One nullable Person reference, distinct from the primary interviewer and applicant when the applicant association is known. Absence grants nothing. |
| Board visibility | Recruitment | A member sees every interview where they are primary. A co-interviewer sees the interview only after original conduct exists, because `0106` grants completed-assessment correction rather than scheduling or initial-conduct authority. A department leader keeps existing scheduling-board visibility but gains no correction authority from that visibility. |
| Detail/correction access | Recruitment | Require the current actor to equal the primary interviewer, or to equal the co-interviewer when original conduct exists; match the interview department through active authority and pass known-self denial. |
| Finalize/cancel/schedule access | Existing contracts | Unchanged. Co-interviewer designation alone never grants these commands in `0106`; an unfinished co-interview is absent from the co-interviewer's board and its detail is denied. |
| Original assessment | Recruitment conduct | Immutable, including original finalizer and completion instant. |
| Effective assessment | Recruitment conduct | Derive from the original plus the linear correction chain. Both interviewers read the same projection. |
| Correction receipt and audit | Recruitment | Exact `0105` semantics. The accepted audit actor is the co-interviewer Person. |
| Report | Recruitment report | Existing effective projection remains unchanged. Co-interviewer designation grants no report route. |
| Effects | None | No notification, outbox, mail, SMS, application, identity, placement, scheduling, or affiliation write. |

Changing or clearing a co-interviewer concurrently with correction is outside this slice because no native designation command exists. The current designation is nevertheless read from the same locked interview row as the correction authority decision. A later designation command must share that aggregate lock and revision.

## Persisted schema

Add one forward migration after `0039`.

`public.recruitment_interviews` gains:

```text
co_interviewer_person_id text NULL REFERENCES public.person_profiles(person_id)
```

The database rejects `co_interviewer_person_id = interviewer_person_id`. Existing rows remain `NULL`; no co-interviewer is inferred or backfilled from team membership, names, email, schedules, reports, or correction history. The migration does not alter historical conduct or corrections.

The new column is the single designation fact. Do not add a join table, copied boolean, role record, mutable current-assessment row, or separate co-interviewer assessment.

## Domain and persistence changes

Extend the recruitment interview model and PostgreSQL row decoders with nullable `coInterviewerPersonId`.

Use separate authorization modes so this slice cannot accidentally widen other commands:

- board read: every primary assignment, plus completed interviews for the co-interviewer;
- detail read: primary interviewer, or co-interviewer only after original conduct exists;
- correction command and exact replay: primary or co-interviewer for an existing completed assessment;
- finalization, cancellation, and scheduling: preserve their existing authority.

The detail/correction transaction keeps the existing custody-before-interview lock order. After locking the interview, resolve current department authority and require the actor to match one of the two interview participant fields. Perform that check before reading a correction receipt, original conduct, effective assessment, or history.

The pure correction transition remains unchanged: authority is established at the service boundary and the existing assessment state machine applies the command. Do not encode co-interviewer status in the correction payload.

The scheduling board projects the nullable co-interviewer identity and display name. Contact information is not required for this journey and must not be added merely because the existing primary-interviewer board projection contains it. If the co-interviewer reference cannot resolve to exactly one current Person profile, fail the private board read rather than silently granting or omitting authority.

## HTTP, access-spec, and SDK contract

Keep the existing routes:

```text
GET  /api/recruitment/scheduling
GET  /api/recruitment/interviews/{interviewId}
POST /api/recruitment/interviews/{interviewId}::correct
```

Add an explicit access requirement for current interview participants rather than relabelling co-interviewers as primary interviewers. Detail and correction require:

```text
recruitment.assigned-interviewer-or-co-interviewer
recruitment.not-known-self
```

Finalization and cancellation retain `recruitment.assigned-interviewer`. Scheduling retains its existing contract.

The canonical interview access source, authority version, and ETag include the nullable co-interviewer designation. Adding, changing, or clearing that designation in a future command must invalidate stale authority/representation tokens.

The scheduling-board response adds nullable co-interviewer identity/display data through the canonical schema and generated SDK. Regenerate the current OpenAPI/client artifacts; do not add a parallel hand-written client.

Reads and writes remain private and `no-store`. The correction payload, response, typed problems, `If-Match`, idempotency, and replay protocol remain those of `0105`.

## Foldkit behavior

Reuse the existing scheduling/conduct Model, Message, update, command, and view. No React form, `useEffect`, imperative side channel, or second state owner.

For a board item with a co-interviewer, display a compact **Medintervjuer** fact using the decoded board projection. The co-interviewer uses the existing completed-detail and correction states. The UI does not decide authority from the displayed role; the server-authorized board and detail responses do.

Failure, stale-precondition, retry, fresh-read, keyboard, mobile, and accessibility behavior remain the `0105` behavior.

## Acceptance gates and falsifiers

- Apply the complete migration chain to a database containing pre-`0040` interviews and prove they remain readable with `NULL` co-interviewer values.
- A real native sign-in, production dashboard build, generated SDK/API, PostgreSQL, and Chromium journey proves the co-interviewer board → detail → correction → fresh read → reload path.
- The primary interviewer reads exactly the same corrected effective assessment and ordered history.
- SQL observation proves one nullable designation, unchanged original conduct/completion, one replacement assessment, one receipt, one audit attributed to the co-interviewer, one revision advance, and no effect/outbox row.
- Anonymous, wrong-department, inactive, suspended, revoked, unassigned same-department member, department-leader-only, absent designation, and known-self actors cannot read detail/history or correct/replay.
- A co-interviewer cannot finalize, cancel, or schedule solely because of the designation.
- Exact replay succeeds only after fresh authority and custody checks. Same-key changed payload conflicts. Revocation before replay denies before receipt disclosure.
- Competing corrections at one revision produce one winner. A stale `If-Match` or body revision writes nothing.
- Missing, malformed, excess, snapshot-mismatched, invalid-score, or absent/unknown recommendation payloads write nothing.
- Database or audit failure rolls back assessment, revision, receipt, and audit together.
- ETag/authority evidence changes when the co-interviewer source fact changes in a controlled transaction fixture.
- Board/detail output exposes no new applicant contact, private file, or unrelated staff data.
- Browser observation includes desktop/mobile, keyboard correction, reload, Axe, page-error capture, and retained-artifact secret scanning.
- Package type checks/tests, HTTP generation freshness, docs generation freshness, capability-parity freshness, and formatting of changed files pass separately from runtime evidence.
- Gate the exact committed executable revision from a clean checkout. Remove disposable PostgreSQL, browser, credentials, files, and runtime artifacts after retaining sanitized evidence.

Any acceptance run that provisions the co-interviewer through a new product endpoint, weakens current membership or department checks, treats board visibility as correction authority, rewrites historical rows, grants finalization/cancellation/scheduling, or reports global parity falsifies this slice.

## Boundaries and follow-on work

Local synthetic implementation and rehearsal only. No production data, credentials, provider action, remote push, deployment, or cutover authority.

This journey does not implement co-interviewer assignment/clearing or notifications; initial co-interviewer conduct/finalization; applicant progress/completion receipts; exact historical first-time classification; automatic scheduling; admissions decisions; events; surveys; certificates; statistics; exports; real-data reconciliation; or production cutover.

The accepted continuation plan and `STATE.md` govern later journeys. A native co-interviewer designation workflow requires a separate contract backed by explicit product authority and legacy-source review.