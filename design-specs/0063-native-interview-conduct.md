# Design spec 0063 - native interview conduct and decision

> **Summary:** An assigned team member opens a scheduled interview, records the immutable interview question answers and three-axis score, then finalizes or cancels it through one native Recruitment authority.

## Metadata

| Field | Value |
|---|---|
| Goal | Replace the legacy interview-conduct and staff-cancellation seam with one native Recruitment transition and one full-Foldkit assigned-interviewer journey |
| Status | Implementation present; real Chromium journey passed at integrated commit `b114cde` |
| Base | `0818c1ab86561623ec40afb131e99680fab1b686` (`0818c1ab`) |
| Implementation revision | `b114cdeadc32e7bb4134cf5d89384883f93d8e11` (`b114cde`) |
| Depends on | 0040 logical capability topology; 0045 Effect Model/Service authority; 0049 native Recruitment assignment; 0050 native Recruitment scheduling; 0051 native Recruitment invitation response; 0054 Identity sessions; 0055 person-keyed authorization; 0056 declarative authorization |
| Actor | Active team member who is the assigned interviewer for the interview |
| Route | `/dashboard/intervjuer` |
| Journey authority | `intent://journey:recruitment:interview-conduct:v1` |
| Operator boundary | No production data, production import, credential change, provider, notification, deployment, or external effect |
| Scope hold | Interview-schema administration remains a separate legacy-accounted journey. This contract does not cut over that route. |

The base and source paths in this contract are static-analysis evidence only. They do not prove that the current native route, service, SDK, database, or browser behavior passes this contract.

## Goal and felt journey

The journey is one assigned team member completing one already scheduled interview. It does not create an assignment or schedule. Those facts must already be warranted by the native dependencies.

1. An authenticated assigned team member opens `/dashboard/intervjuer`.
2. Identity resolves the session to one `PersonId`; Organization resolves the person's current memberships at one `authorizationInstant`.
3. Recruitment reads the native scheduling board. The member sees only interviews assigned to that person and in the member's current department scope.
4. The member selects a scheduled interview whose current invitation response is `Accepted`.
5. Foldkit reads one strict conduct observation. It shows the scheduled location, applicant display identity, the immutable question snapshot captured for this interview, any existing stored answers, and an empty score until finalization.
6. The member enters one answer for every question and selects the three score values.
7. The member submits one `FinalizeInterview` command. Foldkit validates the local form but does not mark the interview complete optimistically.
8. Recruitment authorizes the command again, validates the complete answer set and score, and atomically stores the conduct, receipt, and audit fact.
9. Foldkit performs a fresh conduct read and scheduling-board read. Only those reads replace the local model; the POST response is not final interface evidence.
10. The board now shows `Completed` and the detail shows the stored answers, score, and finalization instant.
11. If the scheduled interview must not take place, the member can submit one `CancelInterview` command before finalization. Recruitment stores a cancellation, receipt, and audit fact atomically. Foldkit performs the same fresh reads and shows `Cancelled`.

There is no native conduct draft write. Answers and scores are local Foldkit state until finalization. A failed command preserves the entered values and exposes a typed safe failure.

## Source evidence and limits

The inspected legacy sources at the base revision are:

- `apps/server/src/App/Interview/Controller/InterviewController.php`: `GET|POST /kontrollpanel/intervju/conduct/{id}` initializes answer objects, permits a leader, assigned interviewer, or co-interviewer, saves the aggregate, and marks it conducted on the `saveAndSend` action; `POST /kontrollpanel/intervju/cancel/{id}` marks the interview cancelled; `POST /kontrollpanel/intervju/status/{id}` accepts a browser integer status.
- `apps/server/src/App/Interview/Api/Resource/InterviewConductInput.php` and `Api/State/InterviewConductProcessor.php`: `POST /api/admin/interviews/{id}/conduct` accepts an unbounded answer array and four score fields, mutates Doctrine entities, and returns `204`.
- `apps/server/src/App/Interview/Api/Resource/InterviewResponseResource.php` and `Api/State/InterviewCancelProcessor.php`: `POST /api/interview-responses/{responseCode}/cancel` accepts `cancelMessage`, requires the legacy pending status, then sends mail after the flush. This applicant-response cancellation is not the staff cancellation in this contract.
- `apps/server/src/App/Interview/Infrastructure/Entity/Interview.php`: legacy rows combine schedule, response status, conducted timestamp, answers, score, and cancellation state; the legacy status transition table permits several status changes that are not reused as one native lifecycle enum.
- `apps/server/src/App/Interview/Infrastructure/Entity/InterviewAnswer.php`, `InterviewQuestion.php`, `InterviewQuestionAlternative.php`, and `InterviewSchema.php`: answers refer to schema questions; question kinds are `text`, `list`, `radio`, and `check`; list/radio/check choices are represented by alternatives.
- `apps/server/src/App/Interview/Infrastructure/Entity/InterviewScore.php` and `Form/InterviewScoreType.php`: the persisted score validates integer values in `0..10`, while the old form presents a narrower choice set. Native 0063 resolves this representation drift by making `0..10` the authoritative score range and testing both boundaries.
- `apps/server/src/App/Interview/Controller/InterviewSchemaController.php`, `Api/Resource/AdminInterviewSchemaWriteResource.php`, `Api/Resource/InterviewSchemaResource.php`, and their processors: legacy schema CRUD exists at `/kontrollpanel/intervju/skjema`, `/kontrollpanel/intervju/skjema/opprett`, `/kontrollpanel/intervju/skjema/{id}`, `/kontrollpanel/intervju/skjema/slett/{id}`, `/api/admin/interview-schemas`, and `/api/admin/interview-schemas/{id}`. No native schema-admin cutover is claimed here.
- `packages/domain/src/recruitment/schema.ts`, `service.ts`, `scheduling-postgres.ts`, and `invitation-response-postgres.ts`: native assignment, scheduling, invitation, response, and delivery dimensions exist as separate code paths; no native conduct, score, question snapshot, completion, or staff-cancellation transition exists at this base.
- `packages/sdk/src/domains/admin/recruitment.ts`, `packages/sdk/src/schemas/recruitment.ts`, `apps/backend/src/recruitment/http.ts`, `apps/backend/src/router.ts`, and `apps/dashboard/app/foldkit/scheduling/**`: native assignment and scheduling boundaries exist; no conduct boundary exists. The current scheduling route's implementation is inspected evidence, not proof of this future journey.

The old `responseCode` is not an input to 0063. Native 0051's capability remains private to invitation-response routes and is never copied into conduct data, receipts, audits, board observations, rendered HTML, or error messages.

## Authority and ownership

Recruitment remains one coherent capability. It owns the interview aggregate's conduct and cancellation transitions, question snapshots attached to an assigned interview, score values, answers, lifecycle receipts, and lifecycle audit facts.

| Fact | Owner | Rule |
|---|---|---|
| Assignment identity and department | Recruitment, established by 0049 | 0063 never changes assignment identity or department. |
| Schedule and current invitation response | Recruitment, established by 0050 and 0051 | 0063 reads these facts and never rewrites the schedule or invitation response. |
| Question schema source | Recruitment | Schema administration is not in this slice. A conductible assignment must have a complete native question source. |
| Per-interview question snapshot | Recruitment | The snapshot is captured at assignment and is immutable for the interview's lifetime. Conduct never follows later schema edits. |
| Answers and three-axis score | Recruitment | Stored only as part of one accepted finalization. No copied applicant contact or unrelated application fields are persisted. |
| Completion and cancellation state | Recruitment | Completion is the presence of one immutable conduct record; cancellation is the presence of one immutable cancellation record. |
| Person identity and current membership | Identity and Organization | Identity resolves `PersonId`; Organization supplies current membership and suspension facts at the command instant. |
| Applicant display identity | Admissions/Profile projections already used by Recruitment | The conduct observation may show display identity needed by the member, but 0063 adds no contact projection or contact write. |
| External delivery | No owner in this slice | No provider, outbox, email, SMS, or notification request is created by conduct or cancellation. |

`Profile` and `Admissions` remain read dependencies only where the existing Recruitment board/detail projections require them. 0063 does not add a contact dependency or persist a display-name copy.

## Dependency contract

The following facts must be warranted before this journey can start:

1. 0049 has assigned one native `RecruitmentInterview` with an immutable `interviewSchemaId`, `applicationId`, `departmentId`, `interviewerPersonId`, and assignment instant.
2. 0049's assignment transaction has captured a complete immutable question snapshot for the chosen schema. The current 0049 code stores only schema metadata and therefore cannot be treated as conduct evidence until this snapshot seam is implemented and gated. Existing interviews without a snapshot fail closed with `InterviewQuestionsUnavailable`; no question is guessed from `questionCount`.
3. 0050 has stored one complete native schedule and incremented the interview revision. A partial schedule is not conductible.
4. 0051 has established the current invitation and response state. `Accepted` is required for finalization; `Pending`, `RequestedNewTime`, `Rejected`, superseded, or missing invitations are typed rejections for finalization.
5. 0054 resolves the session cookie to `PersonId`, and 0055/0056 produce the request-specific Organization authority. No role string, bearer-token map, or stale actor projection is accepted.

A disposable seed for this contract must therefore create the native person, Organization membership, application, schema question source, assigned interview, schedule, and accepted invitation in dependency order. This seed is local evidence, not a production import.

## State model

Assignment, schedule, invitation response, notification delivery, completion, and cancellation remain distinct dimensions:

```text
assignment
  absent | assigned

schedule
  absent | stored

invitation response
  absent | Pending | Accepted | Rejected | RequestedNewTime

notification delivery
  absent | Pending | Processing | Delivered | Failed | Quarantined

completion
  NotCompleted | Completed

cancellation
  NotCancelled | Cancelled
```

Only the following combined states are legal for 0063:

| Schedule | Invitation | Completion | Cancellation | Finalization | Cancellation |
|---|---|---|---|---|---|
| stored | Accepted | NotCompleted | NotCancelled | allowed | allowed |
| stored | Accepted | Completed | NotCancelled | replay or typed already-finalized | rejected |
| stored | any current response | NotCompleted | Cancelled | rejected | replay or typed already-cancelled |
| absent or partial | any | any | any | rejected | rejected |

A cancellation does not delete the schedule, invitation, answers, or historical assignment. A finalization does not change the applicant response. Completion and cancellation are terminal and mutually exclusive. A canceled interview cannot be finalized; a completed interview cannot be canceled.

## Canonical persisted models and exact schemas

`packages/domain/src/recruitment/schema.ts` remains the single declaration source for persisted Recruitment records. Each persisted record is an Effect v4 `Model.Class`; SQL aliases decode directly through its `select` variant. Unknown properties fail with `onExcessProperty: "error"`. IDs are non-empty stable branded strings, instants use the repository RFC3339 schema, and revisions are nonnegative integers.

### Interview question source and snapshot

The existing native `InterviewSchema` metadata remains selectable by `interviewSchemaId`, `name`, `questionCount`, `active`, and `revision`. 0063 requires a read-only question source with this exact value shape:

```text
InterviewQuestionDefinition {
  questionId: NonEmptyStableId,
  ordinal: NonNegativeInteger,
  prompt: String (trimmed, length 1..5000),
  helpText: String | null (length <= 5000),
  kind: "text" | "list" | "radio" | "check",
  alternatives: String[] (each trimmed, length 1..5000, no duplicates)
}
```

The source is valid only when ordinals are unique and contiguous from `0`, `text` has no alternatives, and `list`, `radio`, and `check` have at least one alternative. A schema's question source is not edited by 0063.

`RecruitmentInterviewQuestionSnapshot` is an immutable `Model.Class` with exactly:

```text
{
  interviewId: RecruitmentInterviewId,
  questionId: NonEmptyStableId,
  ordinal: NonNegativeInteger,
  prompt: String,
  helpText: String | null,
  kind: "text" | "list" | "radio" | "check",
  alternatives: String[]
}
```

The pair `(interviewId, questionId)` and the pair `(interviewId, ordinal)` are unique. The snapshot is created by the assignment transaction and cannot be updated or deleted by a conduct command. A question source mismatch, duplicate, gap, or absent snapshot is a typed integrity failure.

### Answer and score values

`RecruitmentInterviewAnswer` is a boundary value, not a second authority:

```text
{
  questionId: NonEmptyStableId,
  answer: string | string[]
}
```

The answer is checked against the referenced snapshot question:

- `text`: one non-empty string, maximum 5000 characters;
- `list` or `radio`: one non-empty string that equals one alternative;
- `check`: an array of zero or more unique alternatives;
- no answer contains an unknown question id, duplicate question id, or an extra property.

The final answer array must contain exactly one item for every snapshot question and is canonicalized in snapshot ordinal order before persistence. Empty `check` answers are valid; every other kind requires a non-empty answer.

`RecruitmentInterviewScore` is a strict value schema with exactly:

```text
{
  explanatoryPower: Integer 0..10,
  roleModel: Integer 0..10,
  suitability: Integer 0..10
}
```

No client-controlled total is accepted. The total is a pure projection `explanatoryPower + roleModel + suitability`; it is not persisted as another source of truth.

### Conduct record

`RecruitmentInterviewConduct` is immutable and exists only after finalization. It has exactly:

```text
{
  interviewId: RecruitmentInterviewId,
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore,
  finalizedByPersonId: PersonId,
  finalizedAt: Rfc3339Instant,
  interviewRevision: NonNegativeInteger
}
```

`interviewRevision` is the interview aggregate revision after the accepted transition. The row has one record per interview. There is no update variant and no delete operation.

### Cancellation record

`RecruitmentInterviewCancellation` is immutable and exists only after cancellation. It has exactly:

```text
{
  interviewId: RecruitmentInterviewId,
  cancelledByPersonId: PersonId,
  cancelledAt: Rfc3339Instant,
  interviewRevision: NonNegativeInteger
}
```

0063 has no cancellation message field. The legacy applicant `cancelMessage` belongs to the separate 0051 response path and is not copied into staff cancellation.

### Commands and observations

`FinalizeInterviewCommand` contains exactly:

```text
{
  commandId: RecruitmentConductCommandId,
  interviewId: RecruitmentInterviewId,
  expectedRevision: NonNegativeInteger,
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore
}
```

`CancelInterviewCommand` contains exactly:

```text
{
  commandId: RecruitmentCancellationCommandId,
  interviewId: RecruitmentInterviewId,
  expectedRevision: NonNegativeInteger
}
```

The server supplies actor, `authorizationInstant`, transition instant, and no other browser value is trusted.

`RecruitmentInterviewConductObservation` contains exactly:

```text
{
  interviewId: RecruitmentInterviewId,
  applicationId: PublicApplicationId,
  applicant: { applicantId: ApplicantId, firstName: ApplicantName, lastName: ApplicantName },
  schedule: RecruitmentInterviewSchedule,
  invitationResponse: "Accepted",
  questions: RecruitmentInterviewQuestionSnapshot[],
  answers: RecruitmentInterviewAnswer[],
  score: RecruitmentInterviewScore | null,
  completionState: "NotCompleted" | "Completed",
  cancellationState: "NotCancelled" | "Cancelled",
  finalizedAt: Rfc3339Instant | null,
  cancelledAt: Rfc3339Instant | null,
  revision: NonNegativeInteger,
  canFinalize: boolean,
  canCancel: boolean
}
```

The observation contains no raw invitation capability, email, phone, notification payload, database receipt, audit internals, or schema-editor fields. The scheduling-board projection gains only `completionState`, `cancellationState`, and the corresponding instants; its existing assignment, schedule, response, and notification dimensions remain separate.

`FinalizeInterviewObservation` is exactly:

```text
{
  _tag: "InterviewFinalized",
  commandId: RecruitmentConductCommandId,
  interviewId: RecruitmentInterviewId,
  interviewRevision: NonNegativeInteger,
  finalizedAt: Rfc3339Instant,
  completionState: "Completed",
  cancellationState: "NotCancelled"
}
```

`CancelInterviewObservation` is exactly:

```text
{
  _tag: "InterviewCancelled",
  commandId: RecruitmentCancellationCommandId,
  interviewId: RecruitmentInterviewId,
  interviewRevision: NonNegativeInteger,
  cancelledAt: Rfc3339Instant,
  completionState: "NotCompleted",
  cancellationState: "Cancelled"
}
```

Both command results contain `{ observation, replayed: boolean }`. An identical replay returns the exact stored observation and `replayed: true`; the response is not used as the final UI model.

## Pure transition laws

The transition functions receive decoded state, explicit actor facts, one observed instant, and one command. They do not read ambient identity, time, configuration, or database state.

`finalizeInterview(state, command, actor, now)` accepts only when:

1. the interview is assigned and the schedule is complete;
2. the invitation is current and `Accepted`;
3. the actor is the assigned active team member;
4. completion and cancellation are both not terminal;
5. `expectedRevision` equals the observed aggregate revision;
6. the answer set exactly matches the question snapshot and each value satisfies its question kind;
7. every score value is an integer in `0..10`.

It returns one `InterviewFinalized` observation and state with `Completed`, `NotCancelled`, the server instant, and one incremented revision. It never changes assignment, schedule, invitation response, or delivery state.

`cancelInterview(state, command, actor, now)` accepts only when:

1. the interview is assigned and the schedule is complete;
2. the actor is the assigned active team member;
3. completion and cancellation are both not terminal;
4. `expectedRevision` equals the observed aggregate revision.

It returns one `InterviewCancelled` observation and state with `NotCompleted`, `Cancelled`, the server instant, and one incremented revision. It never deletes or rewrites existing schedule or invitation rows and emits no effect request.

Invalid input, missing questions, stale revision, non-accepted response, unauthorized actor, completed state, canceled state, or missing schedule returns a typed failure and leaves state unchanged. `finalizeInterview` and `cancelInterview` are not interchangeable status integers.

## Authorization

Each protected request captures one `authorizationInstant` after Identity session resolution. Organization resolves the complete person authority at that instant. 0056 rules are evaluated in the same command transaction and may add requirements but cannot replace the canonical membership check.

For this narrow actor slice, the command actor is valid only if all conditions hold:

- the session resolves to the assigned `PersonId`;
- the person has an active, non-suspended Organization membership in the interview's department at `authorizationInstant`;
- the interview's immutable `interviewerPersonId` equals that person;
- the department and team referenced by the membership are active.

A team leader or global administrator may remain visible through the existing scheduling-board projection, but this contract does not grant them conduct or cancellation command authority. Co-interviewer authority is not inferred because 0049/0050 do not provide a native co-interviewer capability.

Missing or invalid session maps to `401 UnauthenticatedActor`. An authenticated person without the required current assignment maps to `403 RecruitmentScopeDenied` or `RecruitmentRoleDenied`. A revoked or expired membership is re-evaluated and cannot use command replay as a read path.

## Recruitment Service and Layer boundary

`Recruitment` adds these operations to its existing 0049/0050/0051 service:

```text
readInterviewConduct(interviewId, context)
  -> RecruitmentInterviewConductObservation

finalizeInterview(command, context)
  -> { observation: FinalizeInterviewObservation, replayed: boolean }

cancelInterview(command, context)
  -> { observation: CancelInterviewObservation, replayed: boolean }
```

The context contains the authenticated actor and one `now`; it never contains a SQL client, HTTP request, SDK value, raw capability, or Layer. The named journey programs remain open Effects:

```text
readConductJourney(personId, authorizationInstant, interviewId)
  requires Database | Admissions | Organization | Profile | Recruitment
finalizeConductJourney(personId, authorizationInstant, command)
  requires Database | Admissions | Organization | Profile | Recruitment
cancelConductJourney(personId, authorizationInstant, command)
  requires Database | Organization | Recruitment
```

`RecruitmentLive` retains `Database`, `Admissions`, `Organization`, and `Profile` structurally, captures them once, and provides them to private persistence programs. The Layer does not construct a request-local database, runtime, or supporting Layer. The HTTP adapter imports no SQL client and contains no transition law.

## HTTP boundary

The native backend adds exactly these endpoints:

```text
GET  /api/admin/recruitment/interviews/{interviewId}/conduct
POST /api/admin/recruitment/interviews/{interviewId}/finalize
POST /api/admin/recruitment/interviews/{interviewId}/cancel
```

The path interview id and body interview id must match. The body is strict JSON and contains only the command fields declared above; actor, department, schedule, invitation response, question set, and revision authority come from the server-side read. Unknown query parameters, path forms, body properties, malformed RFC3339 values, malformed IDs, answer mismatches, and score values outside `0..10` fail before the transition.

Failure mapping is exact:

| Failure | HTTP status |
|---|---:|
| Missing or invalid Identity session | 401 |
| Inactive actor, wrong assigned interviewer, cross-department scope, or rule denial | 403 |
| Unknown interview | 404 |
| Incomplete schedule, missing question snapshot, missing current invitation, or missing applicant projection | 409 or 503 according to whether the state is a typed domain conflict or an integrity failure |
| Pending, rejected, requested-new-time, or superseded invitation for finalization | 409 |
| Completed or canceled transition | 409 |
| Stale revision or conflicting command identity | 409 |
| Invalid body, answer, score, or path/body identity | 422 |
| Persistence or decode failure | 503 |

The existing `/api/admin/recruitment/interviews/scheduling-board`, assignment, schedule, and invitation-response routes keep their 0049/0050/0051 contracts. No legacy route is forwarded to these endpoints. The legacy conduct and staff-cancellation paths remain source evidence until a separately authorized retirement; this spec does not claim they are removed.

## SDK boundary

The SDK extends `client.admin.recruitment` with exactly:

```text
client.admin.recruitment.readInterviewConduct(interviewId)
client.admin.recruitment.finalizeInterview(command)
client.admin.recruitment.cancelInterview(command)
```

Each method makes one strict native request, decodes the exact response through Effect Schema, rejects excess properties, and maps tagged failures to the existing Recruitment error family. No Hydra envelope, legacy integer status, response code, browser actor, applicant contact, or compatibility method is accepted.

The existing scheduling SDK method remains the source of the initial board. After either command, the Foldkit command performs a fresh native conduct read and board read. It does not replace state from a command response or invent a completed/canceled row locally.

## Foldkit ownership and route behavior

`/dashboard/intervjuer` keeps the shared Foldkit dashboard shell. React Router owns route matching, authentication transport, strict custom-element attribute encoding, the same-origin bridge, and the initial scheduling-board read. React owns no board, selected interview, answer, score, dialog, request, retry, or feedback state.

The scheduling Foldkit model is extended with a selected conduct record. Foldkit owns:

- the strict scheduling-board `AsyncData`;
- selected interview identity;
- conduct-detail `AsyncData`;
- immutable question snapshot projection;
- local answers and score fields;
- finalization/cancellation confirmation state;
- request identity and generation;
- in-flight exclusion;
- typed success, denial, conflict, and failure feedback;
- stale-read rejection and retry state.

Legal messages include:

| Message | Transition |
|---|---|
| `OpenedConduct(interviewId)` | Clear conduct feedback and request one strict conduct detail read. |
| `SucceededConduct(detail)` | Replace detail only when its request identity and interview id match the selected record. |
| `FailedConduct(failure)` | Keep the scheduling board and show a safe typed failure; never render an empty success detail. |
| `ChangedAnswer(questionId, answer)` | Update only the local answer projection after question-kind validation. |
| `ChangedScore(axis, value)` | Update only the local score projection after `0..10` validation. |
| `SubmittedFinalize` | Require a complete local answer set and all score axes; issue one command with a new request id. |
| `SubmittedCancel` | Require the selected record to be scheduled, not completed, and not canceled; issue one command with a new request id. |
| `SucceededFinalize` / `SucceededCancel` | Ignore the POST observation for replacement, then request fresh conduct and board reads. |
| `FailedFinalize` / `FailedCancel` | Preserve local values and show the typed failure. A stale revision clears the selected detail and requires a fresh selection. |
| `ClosedConduct` | Clear selected detail and local values without a server effect. |

The view uses labelled native controls, field-level errors, keyboard-operable confirmation, visible focus, a single page heading, semantic question grouping, and `role=alert` for typed failures. It never renders an invitation capability, raw persistence detail, or contact field. A malformed startup attribute renders no applicant, interview, or fixture.

## Persistence and transaction laws

Migration `21_native-recruitment-interview-conduct` is the next ordered application migration after the current manifest revision. It is one checked-in SQL source used by PGlite and PostgreSQL. It creates, in dependency order:

1. `recruitment_interview_schema_questions`, the read-only native question source keyed by `interview_schema_id` and ordinal;
2. `recruitment_interview_question_snapshots`, immutable per-interview copies keyed by `(interview_id, question_id)` and `(interview_id, ordinal)`;
3. `recruitment_interview_conducts`, one immutable finalization row per interview with answers JSON and the three score columns;
4. `recruitment_interview_cancellations`, one immutable cancellation row per interview;
5. `recruitment_interview_lifecycle_command_receipts`, keyed by command id with canonical digest, command JSON, observation JSON, kind, interview id, resulting revision, and commit instant;
6. `recruitment_interview_lifecycle_audit`, append-only transition facts linked to the receipt and interview.

The migration adds relational checks for non-empty identities, contiguous/nonnegative ordinals at the application boundary, valid question kinds, JSON object/array shapes, score range `0..10`, one conduct or cancellation row per interview, one receipt per `(interview_id, kind)`, immutable audit identity, and foreign-key linkage to the existing interview and schedule identities. It does not add a contact, notification, or placement table.

### Finalization transaction

One database transaction performs this order:

1. Capture and validate `authorizationInstant` and actor facts.
2. Take the command advisory lock and interview advisory lock.
3. Lock the interview row, current schedule, invitation, question snapshots, and lifecycle receipt for the command identity.
4. Re-evaluate Organization authority and the assigned-person check in the transaction.
5. Resolve the current invitation and require `Accepted`.
6. Read the stored lifecycle receipt. An identical digest returns its stored observation with no writes; a different digest returns `RecruitmentLifecycleCommandConflict` with no writes.
7. Check `expectedRevision`, no existing conduct, no existing cancellation, and complete schedule.
8. Decode answers against the locked immutable question snapshot and decode all score axes.
9. Increment the interview revision with expected-revision CAS.
10. Insert exactly one conduct row.
11. Insert exactly one lifecycle receipt and one `InterviewFinalized` audit fact.
12. Commit every row or none.

### Cancellation transaction

One database transaction performs the same lock and authority order, then:

1. checks expected revision and complete schedule;
2. rejects existing conduct or cancellation;
3. increments the interview revision with expected-revision CAS;
4. inserts exactly one cancellation row;
5. inserts exactly one lifecycle receipt and one `InterviewCancelled` audit fact;
6. commits every row or none.

No transaction contacts an external service or inserts an outbox request. A provider failure is therefore not a possible cause of conduct or cancellation rollback. A failed transaction leaves interview revision, conduct/cancellation rows, receipts, and audits unchanged.

The interview lock orders concurrent finalization and cancellation. Exactly one can commit. The loser receives a typed terminal-state or stale-revision conflict. A retry recomputes current authority and state; it does not reuse an actor, snapshot, score, or answer from the failed attempt.

## Evidence plan

Implementation is present. The following runtime evidence passed at integrated commit `b114cde`; it does not replace this evidence plan:

### Observed integrated runtime evidence (`b114cde`)

Runner command: `bun run --cwd apps/dashboard e2e:real-conduct`

The temporary runner output was observed for this note. It is not a committed runtime receipt.

The runner used disposable loopback PostgreSQL and real Chromium. Native login succeeded with the real session cookie. Chromium finalized one accepted scheduled interview and then performed fresh conduct and board reads. It observed `Completed`. One independent stale finalize returned HTTP `409` with `RecruitmentInterviewStaleRevision`. Chromium canceled a second accepted scheduled interview and then performed fresh conduct and board reads. It observed `Cancelled`.

The browser evidence recorded zero accessibility violations and zero page errors. The request ledger recorded no legacy conduct, status, schema-admin, or cancellation route and no raw capability. The database evidence recorded `interviews=2`, `schedules=2`, `acceptedInvitations=2`, `snapshots=8`, `conducts=1`, `cancellations=1`, `receipts=2`, `audits=2`, `finalizedReceipts=1`, `cancelledReceipts=1`, `finalizedAudits=1`, `cancelledAudits=1`, and `forbiddenFields=false`.

All other evidence-plan items remain unclaimed unless directly established by existing tests. In particular, this note does not claim concurrent finalization and cancellation, suspension ordering, rollback, or the full HTTP, SDK, and Foldkit evidence matrix.

### Static and model evidence

- Confirm the base revision and exact source paths above; classify this as static analysis, not runtime proof.
- Prove Model variant keys, immutable-field exclusion, private-field exclusion, strict excess-property rejection, question-kind rules, contiguous ordinal rules, answer completeness, score boundaries, and no mutation of input values.
- Prove pure transition tables for accepted finalization, accepted cancellation, replay, stale revision, pending response, rejected response, requested-new-time response, missing questions, duplicate answers, invalid alternatives, completed state, and canceled state.
- Prove that completion and cancellation remain separate from schedule and invitation response.

### Portable database evidence

Using the canonical migration manifest and disposable PGlite data:

1. create a complete native schema question source and an assigned, scheduled, accepted interview;
2. read the conduct observation with no answers and no score;
3. finalize one interview and observe one conduct, receipt, and audit row;
4. read again and observe `Completed`, exact answers, exact score, and incremented revision;
5. replay the identical finalization and observe no additional row;
6. cancel a second accepted scheduled interview and observe one cancellation, receipt, and audit row;
7. observe `Cancelled` after a fresh read;
8. reject partial schedules, missing snapshots, incomplete answers, invalid choices, invalid scores, stale revisions, wrong actors, and terminal transitions with no partial writes;
9. prove no capability, contact, notification, or unrelated application field appears in conduct rows, receipts, audits, or observations.

PGlite proves portable decoding, constraints, and transaction behavior. It does not prove PostgreSQL lock ordering or concurrent serialization.

### PostgreSQL evidence

Disposable PostgreSQL must observe:

- two concurrent finalizations for one accepted interview produce one conduct row, one receipt, one audit, and one typed loser;
- concurrent finalization and cancellation produce one terminal state and one valid database order;
- a concurrent Organization suspension that commits first denies the command;
- a command that commits first records the accepted actor and authorization instant in audit;
- rollback releases all locks and leaves no partial lifecycle rows;
- exact replay under concurrency produces no second lifecycle row.

### HTTP, SDK, and Foldkit evidence

- Strict route, path/body identity, body-size, query, command, observation, and tagged-failure checks pass.
- Every actor variant, invitation state, terminal state, stale revision, question integrity error, and score boundary maps to the declared status family.
- SDK tests prove one native request per method, exact strict decoding, and rejection of legacy/Hydra/excess shapes.
- Foldkit Update tests prove detail loading, local answer/score edits, incomplete-submit rejection, in-flight exclusion, fresh reads after commands, stale-result rejection, terminal-state rendering, denial rendering, and preservation of entered values after failure.
- Accessibility checks prove labels, question grouping, score controls, confirmation keyboard behavior, focus, and alerts.

### Browser evidence

A real Chromium run against the native backend and disposable PostgreSQL signs in through the real Identity page, uses one seeded assigned member, and performs two independent cases:

- opens an accepted scheduled interview, enters every question answer and all three scores, finalizes, performs fresh reads, and observes `Completed`;
- opens another accepted scheduled interview, cancels it, performs fresh reads, and observes `Cancelled`.

The request ledger must contain no Symfony conduct, status, schema-admin, or cancellation request and no provider-network request. The database evidence must match every displayed terminal state. A fixture, source assertion, recording interpreter, PGlite run, or mocked transport is not browser, PostgreSQL, or provider evidence.

## Definition of done

1. This frozen spec precedes implementation changes and records the exact base revision.
2. Native assignment captures a complete immutable question snapshot before an interview can be conducted; interviews without one fail closed.
3. Recruitment exposes one strict conduct read, one finalization command, and one staff-cancellation command without a second authority.
4. Conduct, score, completion, cancellation, schedule, invitation response, and delivery remain distinct dimensions.
5. Finalization requires an accepted current invitation, assigned active member authority, complete answers, and three score values in `0..10`.
6. Cancellation requires an assigned active member and a scheduled, not-yet-finalized, not-yet-canceled interview.
7. Finalization and cancellation each atomically store their canonical row, receipt, and audit fact or store nothing.
8. Immutable question snapshots and finalized/canceled records cannot be edited or deleted through this slice.
9. Exact command replay returns the stored observation without another write; conflicting replay, stale revision, terminal state, or concurrent loser changes no authoritative row.
10. Native HTTP and SDK boundaries strictly decode IDs, paths, bodies, observations, and tagged failures; no legacy status integer or response capability crosses the seam.
11. `/dashboard/intervjuer` uses Foldkit for board, conduct detail, local answers, score, confirmation, request identity, stale-result rejection, and feedback; React owns none of those states.
12. Fresh native reads, not POST responses, replace the Foldkit model after finalization or cancellation.
13. The route and browser ledger contain no legacy conduct, schema-admin, status, or staff-cancellation request and no provider request during this journey.
14. PGlite portable evidence and disposable PostgreSQL concurrency/rollback evidence pass; PGlite is not reported as PostgreSQL proof.
15. Real-session Chromium evidence observes both finalization and cancellation over the native backend.
16. No production import, production data change, credential change, notification, provider, deployment, or unrelated domain cutover occurs.

## Falsifiers

This contract is incomplete or violated if one condition occurs:

- A conduct command trusts a browser actor, department, invitation state, question set, or revision.
- An interview can be finalized without a complete immutable question snapshot.
- A later schema edit changes the questions or alternatives used by an already assigned interview.
- A non-assigned, inactive, suspended, cross-department, co-interviewer, or authority-less person can finalize or cancel.
- A pending, rejected, requested-new-time, missing, or superseded invitation can be finalized.
- A partial schedule, unknown question, duplicate answer, missing answer, invalid choice, or out-of-range score is accepted.
- Completion and cancellation are collapsed into one status integer or one mutable boolean.
- A completed interview can be canceled, or a canceled interview can be finalized.
- Finalization or cancellation changes assignment, schedule, invitation response, or notification delivery state.
- A conduct/cancellation row, receipt, or audit fact commits without the other required rows.
- An identical command replay creates another conduct/cancellation, receipt, audit, or revision.
- A conflicting command identity, stale revision, or concurrent loser changes a row.
- A command response is presented as final UI evidence without a fresh native read.
- Raw invitation capability, contact data, provider payload, SQL detail, or private persistence fields appear in the observation, DOM, logs, receipts, audits, or browser artifacts.
- HTTP or SDK accepts Hydra, legacy integer status, unknown properties, or a compatibility route.
- React owns conduct, score, answer, selected-interview, request, or feedback state.
- The browser calls `/kontrollpanel/intervju/conduct`, `/kontrollpanel/intervju/cancel`, `/api/admin/interviews/{id}/conduct`, a legacy schema route, or any Symfony endpoint.
- A provider, notification worker, or outbox request runs inside or is caused by this transition.
- A fixture, mocked transport, PGlite output, source assertion, or recording interpreter is reported as native browser, PostgreSQL-concurrency, or provider-delivery proof.
- The native path silently conducts an existing assignment whose question snapshot is absent.

## Non-goals

This contract does not:

- create, edit, activate, deactivate, or delete interview schemas or their question sources;
- migrate or import legacy interview, schema, question, answer, or score rows;
- expose the legacy schema-admin page or add a native schema-admin alias;
- add applicant contact reads, contact mutation, notifications, email, SMS, or provider delivery;
- add co-interviewer assignment or co-interviewer conduct authority;
- reschedule an interview or mutate an invitation response;
- alter admission application state, Organization state, Profile state, or Identity state;
- add bulk conduct, bulk cancellation, undo, rescheduling, deletion, or a second conduct draft save;
- decide any downstream placement, field-of-study, or unrelated applicant workflow;
- authorize production data, production cutover, credential changes, deployment, or legacy-route retirement.

The legacy Symfony routes remain accounted source evidence until a separately authorized clean-cutover contract removes them. This document does not claim that removal has occurred.
