# Design spec 0049 — native recruitment applicant assignment

## Metadata

| Field | Value |
|---|---|
| Status | Contract remains frozen. Amendment 0049.1 authorizes one bounded evidence-harness correction only. Amendment implementation, runtime evidence, and acceptance evidence are pending. |
| Revision | Amendment 0049.1 records the native Identity and receipt evidence contract. Implementation and evidence remain pending. |
| Base | `d867bf7b7eea44412e267127006f8c7c7dbadab2` (`d867bf7`) |
| Goal | Replace the Symfony applicant-assignment seam with one native Recruitment authority and one full-Foldkit team-leader journey |
| Actor | Active department team leader |
| Route | `/dashboard/sokere` |
| Preserved journey authorities | `intent://journey:recruitment:applicant-assignment:v1` and `intent://journey:recruitment:review-applicants:v1` from the accepted intent authority |
| Architecture | Design spec 0045.2; Database, Admissions, Organization, and Profile requirements remain explicit until the process composition root |
| Operator boundary | No production data, remote PostgreSQL, provider, credential, deployment, or external-notification effect |

## Amendment 0049.1 — native Identity and receipt evidence correction

The integrated dashboard uses native Better Auth session cookies through Identity. The old recruitment runner uses a `jwt_token` cookie and legacy token maps.

This drift concerns the evidence harness only. This amendment does not change any frozen product semantics or scope hold.

This amendment authorizes one bounded evidence-harness correction:

- Create a disposable local database and apply the canonical migrations.
- Set `ADMISSION_FIXED_NOW` to one deterministic instant inside the existing native seed interval.
- Run the existing `native-recruitment-journey-seed.mjs` against that fixed clock.
- Seed the synthetic team-leader identity through the existing disposable `identity:seed` entrypoint.
- Pass one process-scoped `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` to the backend and dashboard processes.
- Authenticate the team leader through the rendered native sign-in form in real Chromium.
- Observe the issued `better-auth.session_token` cookie after sign-in.
- Use the resulting Better Auth session cookie for each native Recruitment request.
- Capture each browser request and require no `Authorization` header.
- Run Axe against the rendered applicant-assignment page.

After sign-in, the capture must contain this exact native Recruitment request sequence:

1. `GET /api/admin/recruitment/assignment-board?status=all`.
2. `GET /api/admin/recruitment/assignment-board?status=new`.
3. `POST /api/admin/recruitment/interviews/assign`.
4. A fresh `GET /api/admin/recruitment/assignment-board?status=new`.
5. `GET /api/admin/recruitment/assignment-board?status=all`.

Every request must return `200`. The runner must reject each missing, additional, reordered, failed, Symfony, legacy, or compatibility request.

The browser must observe the visible choices, assignment success, closed dialog, selected interviewer, and `Ikke kontaktet` state. The fresh read remains the only success authority.

After the browser run, the runner must observe exactly one persisted row of each type for the seeded application:

- A Recruitment interview.
- An assignment command receipt.
- An assignment audit fact.

One passing artifact must support both journeys. The runner must emit two separate canonical receipts from that artifact.

The applicant-assignment receipt uses `intent://journey:recruitment:applicant-assignment:v1` and these accepted steps:

- `mono-session-login`
- `load-applicant-list`
- `load-interviewer-options`
- `load-interview-schema-options`
- `assign-interview`
- `fresh-read-applicant-list`

The review receipt uses `intent://journey:recruitment:review-applicants:v1` and these accepted steps:

- `mono-session-login`
- `list-current-applicants`

The harness must not use JWT cookies, token maps, fixture authentication adapters, bearer injection, compatibility routes, or Symfony requests.

The correction must not change product authentication policy, access policy, product routes, frozen authority semantics, or transaction semantics.

It authorizes no production data, external provider, production credential, deployment, or remote effect. Local PostgreSQL persistence is not PostgreSQL concurrency evidence.

Implementation, runtime evidence, and acceptance evidence remain pending.

## Problem

The current `/dashboard/sokere` route still uses React state and three Symfony-shaped SDK domains. It reads legacy Hydra applications and users, reads legacy interview schemas, and posts an integer-ID assignment to Symfony. The native backend has authoritative Admissions and Organization services but no Recruitment authority, no canonical interviewer display-name source, no native assignment transaction, and no Foldkit applicant program.

A mechanical endpoint replacement would leave four independent sources of truth: legacy application status, a synthetic interviewer list, React dialog state, and a native interview write. This slice instead establishes one explicit dependency graph and runs the complete team-leader journey through it.

## Preserved user journey

1. An active department team leader signs in through the existing authenticated dashboard seam.
2. `/dashboard/sokere` mounts the shared Foldkit control-panel shell and the native applicant-assignment program.
3. The program loads the current admission-period assignment board from the native backend.
4. The team leader selects the `Nye søkere` filter.
5. The board shows each applicant's warranted application state, interview state, interviewer, and scheduled time.
6. The team leader opens an unassigned applicant.
7. The dialog shows active interviewer profiles derived from current Organization membership and active interview schemas owned by Recruitment.
8. The team leader selects one interviewer and one schema and submits one decoded command.
9. Recruitment atomically stores the interview assignment, command receipt, and audit fact.
10. The Foldkit command performs a new assignment-board read.
11. The refreshed board shows the selected interviewer and `Ikke kontaktet` interview state.

The assignment response is not final UI evidence. Only the fresh board observation may replace the board Model.

## Authority graph refinement

The executable dependency graph for this journey is:

```text
Database
├─ Admissions ── Organization
├─ Organization
├─ Profile ── Organization
└─ Recruitment ── Admissions + Organization + Profile
```

Profile owns person display names. Organization owns department/team membership and the temporal/suspension rule. Recruitment owns interviewer eligibility as the composition of those facts for this journey, but it does not copy person names into Recruitment persistence. Admissions owns applicants, applications, admission periods, and department scope.

This is an explicit 0045.2 refinement. Identity still cuts over last for credentials, sessions, and authentication authority. Profile display reads do not authorize a command.

## Canonical supporting Profile seam

The native repository currently has no canonical person-name source. This journey therefore establishes the smallest read authority that can render a usable interviewer choice:

- `PersonProfile` is a `Model.Class` keyed by the existing Organization `PersonId`.
- It owns `firstName`, `lastName`, and `revision` only.
- `displayName` is a total projection from `firstName` and `lastName`; it is not persisted.
- `Profile` exposes a bounded `readProfiles(personIds)` operation.
- `ProfileLive` retains `Database` and `Organization` requirements in its Layer type.
- A requested person without a profile is a typed integrity failure. Recruitment never substitutes an opaque identifier, fixture name, or deployment-config label.

Profile expansion, profile mutation, credentials, sessions, and account lifecycle remain outside this slice.

## Recruitment models

`packages/domain/src/recruitment/schema.ts` is the source for persisted Recruitment declarations.

### Interview schema choice

`InterviewSchema` owns:

- immutable `interviewSchemaId`;
- `name`;
- non-negative `questionCount`;
- `active`;
- `revision`.

Only active schemas are assignment choices. Full question editing and answer capture are separate journeys.

### Assigned interview

`RecruitmentInterview` owns:

- immutable `interviewId`;
- immutable `applicationId`;
- immutable `departmentId`;
- immutable `interviewerPersonId`;
- immutable `interviewSchemaId`;
- immutable `assignedByPersonId`;
- immutable `assignedAt`;
- scheduling state, initially and only `NoContact` in this slice;
- nullable `scheduledAt`, which is always null after assignment;
- `revision`, initially zero.

Application and profile values are not copied into this record. The assignment board joins their current warranted projections.

The Model declarations derive strict persistence and JSON variants. Unknown properties fail decoding. Callers cannot provide generated revision fields through insert/update JSON variants.

## Assignment board observation

The board is one decoded observation containing:

- current admission-period identity and department identity;
- candidates sorted deterministically by submitted instant and stable application ID;
- eligible interviewers sorted by display name and stable person ID;
- active schemas sorted by name and stable schema ID.

Each candidate contains:

- stable application and applicant IDs;
- authorized applicant name and email projection;
- submitted time;
- application state (`Received` for this slice);
- interview state (`Unassigned` or `NoContact`);
- nullable interviewer `{ personId, displayName }`;
- nullable interview-schema choice;
- nullable scheduled time.

`status=new` includes only `Unassigned` candidates. `status=all` includes both states. No other status spelling is accepted.

An active interviewer option requires all of:

1. a non-suspended Organization membership active at the requested instant;
2. a live team in the actor's department;
3. a resolvable PersonProfile.

Duplicate memberships for the same person collapse to one deterministic option. A missing Profile for an otherwise eligible person is a typed integrity failure, not silent omission.

## Authorization

The HTTP boundary decodes the authenticated principal into a Recruitment actor.

- An active `DepartmentLeader` may read and assign only applications and interviewer memberships in their department.
- An inactive actor receives `403`.
- An ordinary member receives `403`.
- Missing or invalid credentials receive `401`.
- Global-administrator behavior is held until the native Identity and access-policy authority exists; this journey does not infer it from a role string.

Authorization is re-evaluated inside Recruitment. The dashboard loader and SDK are not authority.

## Assignment command and transaction

The exact command contains:

- `commandId`;
- `applicationId`;
- `interviewerPersonId`;
- `interviewSchemaId`.

The execution context contains the authenticated actor, current RFC3339 instant, and server-generated `interviewId`.

One PostgreSQL transaction:

1. takes an application-scoped advisory transaction lock;
2. reads and locks the application row;
3. verifies the application belongs to the actor's department and current open admission period;
4. rejects an existing interview for the application;
5. verifies an active schema;
6. verifies current interviewer eligibility from Organization and Profile;
7. inserts `RecruitmentInterview` in `NoContact` state;
8. inserts the canonical command receipt and returned assignment observation;
9. inserts one assignment audit fact;
10. commits all rows or none.

A repeated identical command ID returns the exact accepted observation with `replayed=true` and writes nothing. Reusing a command ID with different canonical bytes fails with a typed command conflict. A second command for an already assigned application fails without changing the first assignment.

Assignment creates no notification or file effect. Notification begins only in the separate scheduling journey.

## Recruitment Service

`Recruitment` is one `Context.Service` with two operations for this slice:

- `readAssignmentBoard(query, context)`;
- `assignApplicant(command, context)`.

The public methods expose domain values and typed failures, not SQL clients, HTTP requests, SDK values, or concrete Layers. `RecruitmentLive` retains `Database`, `Admissions`, `Organization`, and `Profile` requirements. Only the backend process composition root closes them, builds one `ManagedRuntime`, and disposes it once.

## Database migration

Migration 10 adds, without destructive fallback:

- `person_profiles`;
- `recruitment_interview_schemas`;
- `recruitment_interviews` with one interview per application;
- `recruitment_assignment_command_receipts`;
- `recruitment_assignment_audit`.

Foreign keys point to native application, department, and profile identities where their ownership permits. Constraints enforce non-empty IDs, non-negative revisions/counts, `NoContact` plus null schedule for this slice, unique application assignment, exact command-receipt linkage, and immutable audit identity.

The migration registry and schema revision have one generated edge to migration 10. Deterministic PGlite tests seed only non-production Profile, Organization, Admissions, and schema rows. No product branch seeds fixtures.

## Native HTTP and SDK projection

The native backend exposes:

```text
GET  /api/admin/recruitment/assignment-board?status=new|all
POST /api/admin/recruitment/interviews/assign
```

The read returns the exact board observation. The write returns the accepted assignment observation and replay flag, but the browser command must then perform another GET.

The SDK adds one `admin.recruitment` domain using Effect Schema for query, command, observation, and tagged error decoding. The old applicant route stops calling:

- `admin.applications.list`;
- `admin.users.list`;
- `admin.interviews.schemas`;
- `admin.interviews.assign`.

Those methods remain only for still-unmigrated legacy journeys; no alias or compatibility implementation forwards them to Recruitment.

## Foldkit ownership and route cutover

The old nested React route is replaced by an opt-out `/dashboard/sokere` route that reuses the shared Foldkit dashboard shell adapter. React Router owns only:

- authenticated server loading;
- strict runtime decoding/encoding of the custom-element attribute;
- the same-origin SDK bridge for commands.

React owns no applicant list, selected row, filter, dialog, request state, or feedback.

The Foldkit applicant Model owns:

- strict initial-input validity;
- assignment board `AsyncData`;
- selected filter;
- selected application;
- selected interviewer;
- selected schema;
- dialog visibility;
- assignment in-flight state;
- visible success/failure feedback.

Messages and legal transitions are:

| Message | Transition |
|---|---|
| `SelectedFilter(status)` | Select filter, clear dialog state, request a fresh board |
| `SucceededLoadBoard(board)` | Replace board with decoded observation |
| `FailedLoadBoard(message)` | Keep failure visible; do not show an empty success state |
| `OpenedAssignment(applicationId)` | Open only an unassigned candidate |
| `ClosedAssignment` | Clear all dialog selections and errors |
| `SelectedInterviewer(personId)` | Set one eligible choice |
| `SelectedSchema(interviewSchemaId)` | Set one active schema |
| `SubmittedAssignment` | Validate both selections and issue one command |
| `SucceededAssignment(board)` | Replace board only with the post-command fresh read; close dialog; show success |
| `FailedAssignment(message)` | Preserve selections and show the typed safe failure |

Commands are Effect programs over the SDK bridge. Update is deterministic and emits commands as values. The program does not optimistically mark an applicant assigned.

The view uses Foldkit HTML and `@foldkit/ui` where an accessible primitive exists. It provides labelled native controls, keyboard-operable filter and dialog behavior, visible focus, a single page heading, table/list semantics that remain usable on phone widths, and `role=alert` for failures. Malformed startup input renders no applicant, identity, or navigation fixture.

## Executable tracer and evidence

The smallest complete local tracer uses the canonical migrations and PGlite:

1. seed one department, open admission period, application, team, active team-leader actor, active interviewer membership, PersonProfile, and active interview schema;
2. read `status=new` and observe the unassigned applicant and named interviewer;
3. assign with one valid command;
4. read again and observe `NoContact` plus the selected display name;
5. replay the same command and observe the identical receipt without additional interview or audit rows;
6. reject a second assignment and observe no database change;
7. reject an inactive or cross-department interviewer;
8. run the native HTTP and SDK contract over the same capability graph;
9. drive `/dashboard/sokere` in a real browser, select the filter, assign, and observe the fresh state.

PGlite establishes fast capability and migration compatibility. It does not prove PostgreSQL advisory-lock or concurrent-command behavior. That claim remains held for a later authorized real-PostgreSQL run.

## Scope holds

This slice does not implement:

- interview scheduling, invitation delivery, candidate response, scoring, cancellation, or school assignment;
- schema/question editing;
- applicant deletion;
- bulk assignment;
- legacy production import;
- Profile mutation or complete profile projection;
- Identity credentials, sessions, administrator policy, or route-capability administration;
- DigitalOcean provisioning or deployment;
- production-faithful PostgreSQL concurrency evidence.

The old Symfony journey remains source evidence only. It is not a runtime fallback or dual-write target.

## Definition of done

1. This frozen spec and the explicit 0045.2 dependency refinement precede implementation commits.
2. PersonProfile has one Model authority and Recruitment does not persist duplicate names.
3. Recruitment has one Model/Service/Layer authority with explicit Database, Admissions, Organization, and Profile requirements.
4. Assignment atomically writes interview, receipt, and audit or nothing.
5. Exact replay returns the stored observation; conflicting replay and duplicate assignment fail.
6. Board reads enforce actor scope, current admission period, current Organization eligibility, Profile resolution, active schemas, and deterministic ordering.
7. Native HTTP and SDK schemas strictly decode every request and response.
8. `/dashboard/sokere` uses the shared Foldkit shell and a Foldkit applicant program with no React interaction state.
9. The Foldkit assignment command performs a fresh read before replacing the board.
10. The old route has no production fixture, Symfony assignment call, compatibility endpoint, or dual write.
11. Focused Profile, Recruitment, migration, HTTP, SDK, Update, accessibility, and browser gates pass over deterministic non-production data.
12. Root type, lint, build, test, and migration replay checks pass on the committed revision.
13. Real PostgreSQL concurrency, production import, deployment, and remote evidence remain explicitly unclaimed.

## Falsifiers

- Recruitment stores an interviewer display name as a second person authority.
- An opaque person ID or fixture label is shown because Profile data is missing.
- A suspended, temporally inactive, cross-department, or unprofiled person appears as an eligible interviewer.
- A Member or inactive leader can read or assign applicants.
- The command trusts department, actor, revision, or status values from the browser.
- Assignment writes an interview without its receipt and audit, or vice versa.
- A repeated command creates another interview or audit row.
- The UI marks success from the POST response without a fresh GET.
- A decode or transport failure renders an empty successful board.
- React `useState`, `useEffect`, `useFetcher`, or another React store owns applicant interaction state.
- The browser calls Symfony applicant, user, schema, or assignment endpoints.
- A PGlite result is reported as PostgreSQL locking proof.
- A fixture or source assertion is reported as the real browser journey.
