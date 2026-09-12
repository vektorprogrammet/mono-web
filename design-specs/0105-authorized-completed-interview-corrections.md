# 0105 — Authorized corrections to completed interview assessments

Status: frozen for local implementation, 2026-09-12. Production release unclaimed.

Baseline: `82443f2a2f1480bfaa73a4c2c75e013ef9761948` (`migration/assistant-operations-0906`).
The next number was checked across the accepted tree and its available migration branches.
No `0105` design spec exists. This document claims `0105` for this bounded journey.

## Goal and product boundary

The current active assigned interviewer can correct the assessment of a completed native interview.
The correction keeps the original interview completion and appends an immutable assessment version.
The journey is not a reopening, a second completion, or a legacy edit-parity claim.

The journey permits only these assessment fields:

- answers against the immutable question snapshot captured for the interview;
- the three native integer scores, each from `0` through `10`;
- one explicit recommendation: `Ja`, `Kanskje`, or `Nei`.

The journey does not edit schedule, invitation response, cancellation, assignment, application preferences,
special needs, identity, affiliation, placement, admission, or coordinator authority. It sends no notification.
It does not add a reason field because the source evidence establishes no reason policy.

The existing Foldkit conduct Model, Message, update, view, effects, and browser client remain the UI boundary.
No React form, React interoperability, `useEffect`, or new frontend stack is permitted.

## Felt journey

1. The current active assigned interviewer opens `/dashboard/intervjuer`.
2. Recruitment resolves the session to one `PersonId`, the current active membership in the interview department,
   and the immutable applicant-before-interview custody check.
3. The interviewer opens a completed interview and chooses **Rett intervju**.
4. The detail reads the current effective assessment and the immutable original question snapshot.
   It shows the original completion time and finalizer, and the read-only correction history.
5. The interviewer edits answers, all three scores, and the required recommendation with keyboard controls.
6. The interviewer submits one correction command. The client sends the expected current revision and idempotency key.
7. The server authorizes again in the transaction, validates the snapshot answers, scores, and recommendation,
   appends one replacement assessment, advances the interview revision, and appends receipt and audit rows atomically.
8. The client performs a fresh GET for the detail and a fresh scheduling-board read. It never treats the POST body as final state.
9. Reload displays the corrected effective assessment and the complete read-only history.
10. The interviewer can correct the same completed interview again. Each accepted correction appends one version.

A failed correction keeps the local draft values and displays a typed failure. A stale conflict never merges or
replaces the draft. The interviewer must reopen the detail to obtain a newer revision before submitting again.

## Authority and immutable facts

| Fact | Owner | Rule |
|---|---|---|
| Current actor | Identity and Organization | Resolve the live session at the request instant. Require active person, membership, team, and department. |
| Interview scope | Recruitment | Require the current actor to equal `interviewer_person_id` and the interview department. No coordinator or co-interviewer privilege. |
| Known self | Admissions identity custody | Lock and check the existing Applicant→Person association before any detail, history, replay, or correction. A known applicant/interviewer match denies. A missing link remains unknown. |
| Original assessment | Recruitment conduct | Preserve the existing conduct row, answers, scores, recommendation, finalizer, finalized time, and original interview revision. |
| Original question source | Recruitment | Validate every effective and replacement answer against the immutable per-interview question snapshot, not current schema metadata. |
| Effective assessment | Recruitment | Derive one projection from the original conduct followed by correction rows in revision order. Do not maintain a mutable duplicate current assessment. |
| Correction history | Recruitment | Append immutable replacement rows with predecessor revision, actor, instant, command identity, values, and resulting revision. |
| Revision | Recruitment interview aggregate | Increment `recruitment_interviews.revision` once per accepted correction. The expected revision is an optimistic concurrency precondition. |
| Receipt | Recruitment | Persist one correction command receipt per command identity and payload digest. Exact replay returns the original correction observation, even after later corrections. Authority is checked before replay lookup. |
| Audit | Recruitment | Persist one append-only audit row per accepted correction. The audit references the correction receipt and resulting revision. |
| Report | Recruitment report projection | Read the same effective assessment projection used by detail. Keep one row per completed interview and the original completion time. |
| Effects | None | No mail, SMS, notification, outbox, application, identity, affiliation, placement, admission, or scheduling effect. |

Fresh authority is required before each detail read, correction command, and correction receipt replay.
The detail read includes history in the same authorized transaction snapshot. The historical finalizer, a previous
membership, a report capability, or an old conditional token never grants access.

## State and version model

The original conduct remains the immutable base version. Let `originalRevision` be its existing
`recruitment_interview_conducts.interview_revision`. Let each correction row have a unique
`resultingRevision` greater than its predecessor. The effective version is the row with the greatest
`resultingRevision`, or the original conduct when no correction exists.

The following values remain unchanged for the lifetime of the completed interview:

- `completionState = Completed`;
- `cancellationState = NotCancelled`;
- the original `finalized_at`;
- the original `finalized_by_person_id`;
- the original conduct answers, scores, recommendation, and `interview_revision`;
For a new correction command, the expected revision equals the locked current interview revision and the server
derives the predecessor from that locked effective version. A matching command receipt is replayed after fresh
authority and custody checks, before current-revision or predecessor validation. Therefore a later correction does not
make an exact replay fail with a stale precondition. A conflicting command key remains a typed conflict.
The actor and applicant custody checks pass for every command, and all replacement fields pass the same native
validation as finalization for a new command.

The original recommendation can be `NULL` for historical conduct. It remains `NULL` in the original version.
Every new correction requires an explicit recommendation and cannot use `NULL` or infer a value from scores.

## Persisted schema contract

Add one forward migration after the accepted migration chain. The migration must run against an upgraded database
that contains old completed conduct, including old rows with a `NULL` recommendation. It must not rewrite those rows.

### `recruitment_interview_correction_assessments`

One row is one immutable replacement assessment:

```text
{
  interview_id: RecruitmentInterviewId,
  predecessor_revision: NonNegativeInteger,
  resulting_revision: PositiveInteger,
  answers: JSON array validated against the snapshot,
  explanatory_power: Integer 0..10,
  role_model: Integer 0..10,
  suitability: Integer 0..10,
  recommendation: Ja | Kanskje | Nei,
  corrected_by_person_id: PersonId,
  corrected_at: Rfc3339Instant,
  command_id: CorrectionCommandId
}
```

The exact table and view names are implementation proposals. The binding invariant is a single linear chain:
the first correction points to the original conduct revision, each later correction points to the immediately
preceding correction revision, and each resulting revision is exactly predecessor plus one. Enforce this with the
interview/revision uniqueness, foreign keys where the original schema permits them, and a database insert trigger
that checks the locked current effective revision. The trigger is not a replacement for the transaction lock.
Require a unique command identity and a foreign-key link to `recruitment_interviews`. Reject updates and deletes
with the existing append-only trigger convention. Add lookup indexes by interview and resulting revision. Do not
add a mutable `current` flag or copied completion metadata.

### `recruitment_interview_correction_command_receipts`

One row is one correction command identity:

```text
{
  command_id: CorrectionCommandId,
  command_sha256: HexSha256,
  command_json: JSON object,
  observation_json: JSON object,
  interview_id: RecruitmentInterviewId,
  predecessor_revision: NonNegativeInteger,
  resulting_revision: PositiveInteger,
  committed_at: Rfc3339Instant
}
```

The command identity is unique. The stored digest, interview identity, predecessor, and resulting observation must
match on exact replay. A same-key different payload returns the existing typed conflict and writes nothing.

### `recruitment_interview_correction_audit`

One row is one accepted correction:

```text
{
  command_id: CorrectionCommandId,
  interview_id: RecruitmentInterviewId,
  actor_person_id: PersonId,
  predecessor_revision: NonNegativeInteger,
  resulting_revision: PositiveInteger,
  occurred_at: Rfc3339Instant
}
```

## Domain schemas and operations

Extend the existing `packages/domain/src/recruitment/schema.ts` with schemas for the correction command,
correction result, effective assessment, and tagged history. Use the repository's Effect v4 schemas and strict
excess property decoding. Reuse `RecruitmentInterviewAnswerSchema`, `RecruitmentInterviewScoreSchema`, and
`InterviewRecommendationSchema`.

The public correction payload has exactly:

```text
{
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore,
  recommendation: Ja | Kanskje | Nei
}
```

The route supplies the interview identity. The `If-Match` header supplies the expected current interview revision.
The idempotency key supplies the command identity. The domain command may contain these server-derived values, but
the browser payload must not repeat them or provide a predecessor revision.
The effective detail observation keeps the existing original completion fields and adds:

```text
{
  finalizedByPersonId: PersonId,
  finalizedAt: Rfc3339Instant,
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore,
  recommendation: Ja | Kanskje | Nei | null,
  effectiveRevision: NonNegativeInteger,
  history: Array<OriginalHistoryEntry | CorrectionHistoryEntry>
}
```

The exact history union is tagged so illegal nullable combinations are not representable:

```text
OriginalHistoryEntry {
  _tag: "Original",
  revision: NonNegativeInteger,
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore,
  recommendation: Ja | Kanskje | Nei | null,
  finalizedByPersonId: PersonId,
  finalizedAt: Rfc3339Instant
}

CorrectionHistoryEntry {
  _tag: "Correction",
  revision: PositiveInteger,
  predecessorRevision: NonNegativeInteger,
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore,
  recommendation: Ja | Kanskje | Nei,
  correctedByPersonId: PersonId,
  correctedAt: Rfc3339Instant,
  commandId: CorrectionCommandId
}
```

The original entry preserves a historical null recommendation. Every correction entry has a recommendation, actor,
time, predecessor, and command identity. The history is read-only and contains no applicant contact field.

Add a `correctInterviewAssessment` operation to Recruitment. Keep `readInterviewConduct` as the single detail read.
The detail body includes the effective assessment, original completion fields, and history. Do not add a separate
history HTTP read. The detail body and its ETag come from one authorized database transaction snapshot.

The pure domain transition must reject an unfinished/cancelled interview, stale expected revision, invalid snapshot
answers, invalid score, absent recommendation, and inactive/out-of-scope actor. It derives the predecessor from the
locked effective assessment. It constructs an immutable replacement and increments the revision without changing
original completion fields.

## PostgreSQL transaction contract

Reuse the existing PostgreSQL Recruitment layer and applicant-before-interview custody implementation.
For detail reads, correction commands, and replay, acquire the applicant custody lock before the interview lock.
Resolve current authority after custody and before reading any receipt or assessment.

The detail read uses one transaction snapshot for all of these operations:

1. resolve the current session and department authority;
2. lock applicant custody and perform the known-self check;
3. lock/read the interview, original conduct, schedules, invitation, question snapshot, and ordered corrections;
4. derive the effective assessment and tagged history;
5. read the HTTP source used to derive the ETag from the same locked revision and authority facts;
6. return the body and ETag together.

The server derives the predecessor from the locked effective assessment. It never trusts a browser predecessor.
The command still carries the expected revision derived from `If-Match`; the server checks it against the locked
interview revision.

For a new command, in one transaction:

1. decode the payload strictly and compute its canonical digest with route identity and expected revision;
2. perform the fresh actor, department, assignment, and known-self checks;
3. check for an existing correction receipt and return an exact replay only when digest and identities match;
4. validate completed state, expected revision, snapshot answers, native scores, and recommendation;
5. advance `recruitment_interviews.revision` with the expected-revision predicate;
6. insert the correction assessment whose predecessor is the locked effective revision;
7. insert the correction receipt;
8. insert the correction audit;
9. return the typed correction observation.

Any failure rolls back the assessment, interview revision, receipt, and audit. No command writes an outbox row.
The HTTP response is not the final UI state; the client performs a fresh detail read and board read.

The original finalization receipt remains an observation of the original finalization command. It never replays as a
correction and is never changed by a later correction.
## HTTP and SDK contract

Extend the existing schema-driven Recruitment API and generated client. Do not add a generic retry policy,
resend behavior, or a parallel hand-written public API.

Keep the existing detail route:

```text
GET /api/recruitment/interviews/{interviewId}
```

The response body now contains the effective assessment, original completion metadata, and tagged version history.
Its body and ETag come from the same authorized transaction snapshot. A body from an older snapshot paired with a
newer ETag is a protocol failure and has an executable falsifier.

Add the correction command route:

```text
POST /api/recruitment/interviews/{interviewId}:correct
```

The correction request uses the existing `If-Match` and idempotency-key headers. Its JSON payload contains only
answers, score, and recommendation. The route supplies the interview identity. The expected revision comes only from
`If-Match`. The command identity comes only from the idempotency key. No duplicate predecessor or identity field is
accepted. Responses use the existing strict problem mapping and return no applicant-facing fields. Reads and writes
are private and no-store.

The AccessSpec must state that detail, correction, and replay require the current assigned interviewer, current active
department membership, and known-self denial. A coordinator report reader cannot call these routes.
Regenerate the SDK through the existing toolchain and update all callers and bridge schemas.
Use the existing `executeCommand`/lifecycle precedence. Do not evaluate `If-Match` in an outer preparation step
before the transaction can perform fresh authority and receipt lookup. Within the authorized transaction, exact
matching receipt replay precedes new-command CAS validation. A replay still requires current authority and custody.
## Foldkit UI contract

Modify only the existing `apps/dashboard/app/foldkit/scheduling` conduct machine and its recruitment bridge/client.
Keep Model, Message, update, view, and Command ownership in Foldkit.

When a completed detail is open:

- render **Rett intervju** as the action label;
- allow editing of the snapshot answers, all three score selects, and recommendation;
- show original completion time and finalizer as read-only;
- show a read-only version history with original and correction revisions;
- keep cancel and finalize controls unavailable;
- preserve the current local draft after a failed correction or stale conflict;
- after success, mark the conduct read as refreshing, issue a fresh detail read and scheduling-board read,
  then replace the model only from those reads;
- permit a second correction after the fresh read;
- ensure keyboard focus, labels, error descriptions, mobile layout, and Axe behavior remain covered.

The existing terminal conduct view must distinguish historical recommendation absence (`Ikke registrert`) from the
three explicit values. A correction draft must not silently convert historical `null` into a recommendation.

## Report projection contract

Update the existing coordinator report query to derive recommendation, scores, and total from the same effective
assessment projection as detail. Keep exactly one row per completed interview and the original completion time.
Corrected values affect recommendation filtering, score sorting, total sorting, and displayed totals together.
The report still excludes known self-assessments before projection, ordering, filtering, and counting.

The report returns no answers, history, contact data, applicant account identifiers, or correction actor identities.
A report read grants no detail, history, or correction authority. Report reads remain read-only and create no audit or
receipt rows.

## Migration and upgrade invariants

Run the current migration chain against an upgraded database containing:

- a completed conduct with an explicit recommendation;
- a historical completed conduct with `NULL` recommendation;
- unfinished and cancelled interviews;
- existing lifecycle receipts and audits.

The upgrade must preserve every pre-existing conduct, receipt, audit, finalizer, finalized time, answer, score,
recommendation, question snapshot, completion state, and interview revision exactly. Existing historical null remains
null. New correction rows require an explicit recommendation. Invalid direct inserts, updates, deletes, unknown
question ids, duplicate answers, missing answers, invalid scores, and invalid recommendations fail at the boundary.

## Acceptance gates and executable falsifiers

Use the existing real dashboard/API/PostgreSQL journey and native seed/runtime helpers. Do not use mocks as proof of
the real boundary. Run heavy runtime/build work serially in this worktree.

### Browser and Foldkit journey

- Open a completed interview as the current assigned interviewer.
- Use real keyboard focus and controls to change an answer, each score, and recommendation.
- Save, observe a fresh GET, reload, and see the corrected effective values.
- Make a second different correction, save, reload, and see both versions in read-only history.
- Confirm the original completion status, completion time, finalizer, and original assessment remain displayed in history.
- Exercise mobile layout, keyboard focus, accessible labels/state, Axe, and captured page errors.
- Force a failed save and confirm the draft values remain in the Foldkit model and visible controls.

### SQL and projection checks

- Query exact original conduct values and assert that its row is unchanged.
- Query exact ordered correction rows, predecessor/resulting revisions, command identities, actors, instants, and audits.
- Query receipts and assert one receipt and one audit per accepted correction.
- Query the detail and report effective projection and compare answers, scores, recommendation, total, filters, and sort.
- Assert one report row per interview and the original completion time.
- Assert no notification, outbox, application, identity, affiliation, placement, admission, or schedule writes.

### Replay and concurrency

- Replay the original finalization command after a correction and receive the original finalization observation only.
- Replay the first correction exactly after a later correction and receive the byte-for-byte stored correction result,
  not a recomputed observation of the later effective state.
- Reuse a correction command key with a different payload and receive the typed conflict without any mutation.
- Submit two corrections from the same expected revision concurrently. One wins; the other fails stale without overwriting it.
- Inject a failure after each owned write and assert transaction rollback of assessment, revision, receipt, and audit.
- Submit invalid answers, scores, recommendation, or snapshot references and assert no owned write.

### Authority and custody

- Deny anonymous, wrong-department, unassigned, coordinator-only, co-interviewer, ended, suspended, revoked,
  inactive-department, and known-self actors before detail, correction, and replay.
- Revoke membership before a receipt replay and assert denial rather than replay.
- Revoke membership before detail and assert denial rather than stale data.
- Pair an older detail body with a newer ETag in a harness interceptor and assert that the protocol rejects the
  mismatch; the browser must never submit a correction against an ETag newer than the displayed draft.
- Race a new Applicant→Person self-link against a detail read, correction, or replay using the existing applicant-before-interview
  custody lock. A newly known self-assessment must never leak or mutate.
- Allow a different linked Person and preserve unknown-link behavior as established by existing authority rules.

### Historical and report boundaries

- Read and correct a historical-null recommendation only with an explicit new recommendation.
- Preserve the historical-null original entry as null.
- Assert that corrected report filters, numeric sorting, totals, and recommendation display update together.
- Assert that report rows contain no detail answers, correction history, applicant contact, or account-link data.
- Assert that report access does not make detail/history/correction available.
- Assert no notification or unrelated application effect.

Static checks, changed harness TypeScript checks, generated API freshness, focused domain tests, browser evidence,
SQL observations, and clean-source/revision evidence are separate gates. A skipped gate is reported, not treated as
passed. Local synthetic resources only; no production data, credentials, providers, remote push/PR, deployment, or
cutover are in scope.
