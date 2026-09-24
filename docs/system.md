# Intended system

**Status:** Target business model and product behavior. Revised 2026-09-24.

This document explains the replacement system. It describes intent, not production
state. [STATE.md](../STATE.md) records what is implemented and accepted.

## Purpose

Vektorprogrammet connects volunteer university students with partner schools that
need mathematics tutoring. The system also supports the organization that recruits,
places, schedules, and follows up those volunteers.

The operational core is a school-service commitment:

```text
school demand + eligible assistant supply
  -> reviewed proposal
  -> coordinator-confirmed roster
  -> dated school-service commitment
  -> absence and reassignment when needed
  -> Completed | Cancelled | Unfulfilled
  -> immutable evidence and service history
```

Recruitment, onboarding, organization administration, expense reimbursement,
events, surveys, content, and communication support this core. They are
separate workflows, not one aggregate.

Sponsor teams seek support from businesses and organizations. Their funding
supports voluntary school service, chapter operations, and internal social
activities for student members.
IAM identifies people and grants scoped authority across these activities.
Team membership does not make a person an assistant, and sponsorship does not
grant school-service or payment authority. The system does not automate every
human team activity or assume that sponsor presentation is an income ledger.

## Business facts

- A **Person** is a stable human identity.
- An **Account** authenticates a Person. Credentials and sessions belong to the
  account lifecycle.
- A **Profile** stores the person's contact data.
- A **VolunteerAffiliation** records that a person can serve as an assistant in one
  local chapter. It has an independent lifecycle.
- An **Appointment** records a position in an organizational unit for a time range.
- A **Placement** assigns an assistant to recurring school service in a semester.
- A **SchoolServiceCommitment** binds a school, dated service interval, demand,
  and the assistants scheduled to meet it. It does not replace a Placement.
- An **Absence** records that one scheduled assistant cannot serve on that dated
  commitment. It does not erase the placement or the school's need.
- A **SemesterRef** identifies an external semester. Vektorprogrammet uses semesters
  but does not own their lifecycle.
- Roles shown in a menu are projections. They are not the authority model.

These facts may overlap. One person can be a volunteer, team member, team leader,
receipt approver, and coordinator at the same time. Leaving a team must not erase
volunteer history or school placement.

Legacy data must resolve to a Person before credentials, affiliations, placements,
or operational history can reference it. Reconciliation requires an explicit
source-to-Person mapping and matching identity evidence. Creating a Person writes
the initial name and contact profile. Linking an existing Person never overwrites
native profile facts and requires the expected profile revisions.

Inactive, ambiguous, stale, conflicting, or unattested mappings are quarantined
without partial Person writes. Legacy username and company-email aliases do not
become native login identities. Credential import is a separate Account operation.

Account import requires immutable accepted Person-reconciliation evidence for
the source repository, source user, and target Person. The canonical private
email requires explicit ownership evidence. The native identity name comes
from the reconciled Person profile. Existing targets, conflicting emails,
invalid rows, and unsupported credentials are quarantined without partial
authentication writes. Legacy aliases do not become login identities.

A supported legacy hash creates a native user and credential Account. An
eligible passwordless source row creates a native user without a credential,
session, verification flag, or claim message. The import records which mode
it used. The Person must request native password recovery at the canonical
email and use its one-time link to set the first password. Exact replay
preserves the import evidence and any password set after import. Password
recovery replaces a retained legacy hash and revokes older sessions. The
backup alone does not prove current mailbox ownership.

New passwords use Argon2id with the existing native NFKC normalization policy.
The [credential module](../packages/database/src/password-codec.ts) owns encoding,
cost, input limits, and bounded hashing admission. Existing native scrypt and
supported PHP bcrypt hashes remain verification formats with their original
normalization and byte semantics. Successful sign-in upgrades an outdated hash
under the new policy. The complete submitted password becomes the new credential;
legacy bcrypt truncation does not carry into the upgraded password.

An upgrade requires the stored credential to match the hash that authentication
verified. If a concurrent reset or upgrade wins, the stale sign-in fails. The
account lifecycle removes its new session and clears its cookie. Current
credentials receive the same check before the response leaves the server.
Incorrect passwords cannot change credentials. Hashing overload is a temporary
service failure, not an incorrect-password result.

Legacy assistant service is append-only history. Each accepted row retains its
source identity and requires accepted Person evidence plus explicit department,
semester, and school mappings. Historical affiliation is derived from accepted
service rows. Importing history never creates a current affiliation, placement,
demand, absence, service occurrence, Account, or admission decision.

A synthetic current-assignment reconciliation snapshot may establish current facts only
when every active source assignment has accepted immutable Person evidence and explicit
Person, department, semester, and school mappings. It retains its declared canonical
digest, source watermark, source-row digest, assignment evidence, mapping, disposition,
and deterministic placement identity as append-only provenance. The transaction creates
the existing Active affiliation at revision 1 only when it has no canonical target, then
creates the existing active placement at revision 1. It writes no human operational
audit action. Several placements can share the one importer-proven affiliation. Exact
replay is stable; changed source identity, ambiguous or unresolved mappings, inactive
assignments, overlap, and unowned canonical targets are rejected or quarantined without
adopting or mutating canonical facts. This local synthetic path does not authorize
production import.

## Core lifecycles

### Recruitment and affiliation

```text
Applicant submits
  -> interview scheduled
  -> interview completed
  -> recommendation recorded
  -> onboarding invitation issued
  -> applicant claims account
  -> applicant requests affiliation
  -> authorized leader establishes affiliation
```

The system must keep these decisions separate:

1. Interview recommendation.
2. Onboarding invitation.
3. Account claim.
4. Volunteer affiliation.
5. School placement.

There is no inferred generic “accepted applicant” fact. A coordinator admission
decision is not part of the current native model unless the organization defines it
as a separate command and authority.

A returning volunteer may use an existing account and history. They still need an
explicit affiliation for the relevant chapter and an explicit placement.

Applicant progress shows the same facts in sequence. Interview or returning
registration completion can lead to a pending affiliation, active affiliation,
and active school placement. Placement is the final visible state. Affiliation
does not hide an earlier invitation or cancellation, and the projection does not
invent a separate admission answer.

Global administrators maintain reusable interview questionnaires. They can create, revise, activate, or deactivate a questionnaire.
The question types are free text, dropdown, single choice, and multiple choice.
Each assigned interview retains its saved questions and answers. Later questionnaire changes affect future assignments only.
Unavailable historical questions remain unavailable; the system does not replace them with the current definition.

Current department leaders maintain primary and optional co-interviewers within their department. Global administrators can maintain staffing across departments.
Both interviewers must be eligible, distinct people. Neither can be the linked applicant.
Staffing changes preserve schedules, invitation capabilities, responses, assessments, and onboarding facts. They send no new invitation.
Completed or cancelled interviews reject staffing changes. Removed interviewers lose assignment-based access on the next authorized interaction.

Both maintenance workflows require a reason and the observed revision when updating an existing record.
State, immutable history, and command receipts commit together. Replays recheck current authority without repeating the change.
Queued notifications retain their original content and recipients. Staffing changes do not bypass notification integrity or cancellation checks.

### School administration

Schools owns partner-school identities, contacts, language, active status, and department associations.
A current global administrator can maintain every school. Department leaders can maintain schools within their current scope.
Directory membership alone grants no maintenance authority.

Shared details require authority over every associated department. Association changes require authority over both the current and requested departments.
An existing school without associations requires global authority. New schools and replacement association sets require at least one department.
The system refuses to remove an association with dependent records, including saved placement proposals.
Deactivation preserves capacity, placement, demand, and history. There is no school deletion command.

A capacity plan records nonnegative weekday counts for one school, department, and semester.
Capacity maintenance requires an active school, its department association, and current authority for that department.
Capacity is separate from placement demand. School commands do not change placements, rosters, commitments, or notifications.

Each command requires a reason. Edits require the observed revision. State, revision, history, and command receipts commit together.
Exact replay does not repeat a change. The server checks current authority before replay and rejects conflicting payloads or stale revisions.
Scoped management reads conceal other departments, their capacity plans, and their history.

### School demand and placement

Placement demand specifies required volunteers, school, weekday, teaching block, and semester.
Volunteer supply includes affiliation, eligibility, availability, and preferences.

The coordinator records demand for an active school, weekday, and teaching block.
A proposal snapshots that demand and the current active placements. Every mismatch
is explicit, and confirmation requires an exact review of those exceptions.

Confirmation freezes the roster snapshot and queues one notification per assigned
assistant. It does not prove that service occurred on a specific date. Proposal
generation never changes a placement. Placement history survives edits and removal.

### Dated school service

An authorized coordinator establishes a commitment for one school, date, and
bounded service interval from a confirmed roster. It records the required number
of assistants and their scheduled assignments. An absence affects one assignment.
A substitute can cover that assignment without changing the confirmed roster or
the assistant's semester placement.

The interval starts before it ends, and required demand is positive. A reviewed
proposal can still have no assigned assistant; this leaves visible unmet demand.
It cannot become Completed without evidence that actual attendance met demand.

The coordinator acts within the school and semester scope. The coordinator can
record evidence received from a school contact and retain its source. If the
contact acts in the application, IAM grants only the required school scope.

The commitment stays open until an authorized actor records one terminal outcome:

| Outcome     | Required evidence                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed   | An immutable occurrence records actual attendance for the same interval. Attendance and acknowledged substitutes meet the recorded demand.                           |
| Cancelled   | The decision records the actor, time, reason, and source of the cancellation. It records no invented attendance.                                                     |
| Unfulfilled | The decision records unmet demand, any actual attendance, the actor, time, and supporting evidence. An uncovered absence alone does not decide the whole commitment. |

A request for better evidence leaves the commitment open. An elapsed end time
marks it overdue for review; time alone does not prove completion or cancellation.
A terminal decision is immutable. Concurrent or repeated commands cannot create
a second terminal outcome. A later correction needs a separate authorized
reversal contract; it cannot silently rewrite the original evidence.

### Substitute coverage

An affiliated volunteer can opt into the substitute pool. A scheduled volunteer or
scoped coordinator can report an absence for a confirmed slot and service date.
The report stores no medical reason or free text.

A scoped coordinator dispatches one eligible substitute at a time. Eligibility
requires linked Person identity, active affiliation, active pool membership,
weekday availability, and no placement or acknowledged-coverage conflict. The
dispatch keeps the eligibility and school-name snapshots.

Only the addressed substitute can accept or decline. A coordinator can withdraw an
unacknowledged offer or acknowledge one accepted offer. Provider failure does not
roll back the offer. Retry uses the same immutable envelope and effect identity.

When service occurs, its attendance records the confirmed roster minus absent
assistants plus acknowledged substitutes. An absence closes as Covered or
Uncovered against that occurrence. These outcomes describe one assignment,
not the whole school commitment. Cancellation or unfulfilled service with no
attendance records no invented occurrence. Resolve outstanding offers before a
terminal decision. Pending notifications remain recoverable after the decision;
provider failure does not prevent closure. Absence, offer, response,
acknowledgement, occurrence, and session outcome remain separate durable facts.
Pool membership implies none of them.

### Expense reimbursement

A volunteer submits a claim and private receipt file. Authorized approvers can read
the file, approve or reject the claim, and reopen a rejected claim when policy
allows. Approval does not prove payment and leaves the claim `Approved`.

A different, explicit settlement grant can record immutable evidence after an
external settlement. The evidence preserves the amount, destination fingerprint,
external authority and reference, settlement time, recording actor, and receipt
revision. Owners can read their evidence; finance readers see only evidence within
their active scope. Notification failure does not roll back the evidence, and retry
keeps the original effect identity.

Claim state, file custody, approval authority, settlement authority, delivery
attempts, and settlement history are separate facts. A file path, approval grant,
or team label does not grant settlement access.

### Organization administration

Authorized people manage local departments, national units, teams, boards,
positions, memberships, and team interest. Memberships are effective-dated. A
person may hold more than one position or membership.

A local chapter and a national unit use the same appointment mechanism but have
different scopes. A chair is not automatically a global administrator.

Authorized appointment actions create, revise, end, suspend, or reinstate a responsibility.
Every action checks current scope and preserves attributable history.
Ending or suspending one appointment does not change another appointment, volunteer affiliation, or school placement.
Current authority applies to each protected request, including requests from existing sessions.
A leadership handover can appoint the successor before the predecessor leaves.
The end of the last leadership appointment revokes only its scope.

A global administrator can disable or re-enable native human account access through a separate command.
Disabled access blocks native sessions, human OAuth access, and recovery.
Re-enable requires fresh authentication and does not revive old sessions, recovery tokens, or human OAuth credentials.
Self-offboarding and removal of the last usable global administrator fail without changes, including during concurrent commands.
State, revisions, command receipts, and attributable history commit together.
An exact replay cannot duplicate history. A changed command identity payload or stale revision cannot leave a partial change.
These commands do not administer external mail, Google Workspace, or service principals.

### Mailing recipients

A current department leader reads recipients within that department. A current global administrator reads recipients across departments.
The dashboard selects a department, semester, and cohort, then shows copyable current contact addresses.
The three cohorts are assistants, team members, and their union.

Assistant recipients come from accepted historical service and active placements for the selected department and semester.
Team recipients come from nonsuspended appointments that overlap the semester. An appointment that only touches a semester boundary does not qualify.
The union removes duplicate people and duplicate contact addresses. Accounts, applications, recommendations, and bare affiliations do not establish assistant eligibility.

An explicit semester must exist in the canonical catalogue. An omitted semester resolves to the unique current semester.
Missing or ambiguous references fail without changes. A missing contact can be absent, but an infrastructure failure cannot produce an empty success.
Current authority and recipient facts share one read snapshot. Revoked leadership does not retain access through an existing session.
These reads do not administer subscriptions, send mail, or synchronize an external provider.

### School surveys

A current department leader manages school surveys for that department. A global
administrator can manage surveys for all departments. Each survey belongs to one
department and one semester.

A manager creates a survey with text, list, radio, or checkbox questions. The
definition includes a completion message and an explicit results policy. A manager
can close an open survey once but cannot reopen it.

An anonymous respondent selects an eligible school and sends one response while
the survey is open. The system stores the school but does not store a respondent
identity. A closed survey conceals its public form and rejects new responses.

The results policy grants access to department managers or only to global
administrators. The same policy controls response counts, result rows, and CSV
exports. Unauthorized readers cannot learn whether confidential results exist.

### Supporting workflows

Supporting contracts include:

- account claim, password recovery, sessions, and profile self-service;
- scoped directory reads and separate school-maintenance commands;
- public content, contact messages, and sponsor presentation;
- social events and team interest;
- authenticated applicant progress;
- acknowledged receipt and interview notification delivery.

This list defines scope, not implementation status. [STATE.md](../STATE.md#next) records incomplete maintenance and acceptance.
School-directory reads do not grant school, contact, association, or capacity mutation authority.
Certificates require a separate operational need and are not a default replacement gate.

Each workflow owns its commands and facts. Shared infrastructure may carry an event
or deliver a message, but it does not own the business decision.

## Authority model

Authority follows relationships, scope, resource ownership, and time:

```text
permit(person, action, resource, instant)
  = accountIsUsable(person, instant)
  AND relationshipIsActive(person, resource, instant)
  AND relationshipCovers(resource.scope)
  AND capabilityAllows(action)
```

Examples:

- An applicant may read their own application progress.
- An interviewer may assess only an assigned interview.
- A co-interviewer may correct a completed assessment only when the scoped
  correction capability is active.
- A receipt owner may read their own file.
- An approver may read files and decide claims only in the granted scope.
- A local team leader cannot exercise national authority by label alone.

Default deny. The backend checks authority at the command and query boundary. The
frontend may hide unavailable actions, but hiding is not enforcement.

A service caller is a separate principal, not a synthetic Person. A valid machine
credential proves its identity, but a current grant must also cover the operation,
resource scope, and time. It inherits no human appointment. A request with both
human and machine credentials must fail rather than choose one silently.

## Durable effects

Commands that change business state use one database transaction for:

1. the current projection;
2. immutable history or audit information;
3. idempotency or command receipt;
4. outbox work that must happen after commit.

External delivery happens after commit. Retries reuse the original envelope. A
successful business transaction must not roll back because email or another
provider is temporarily unavailable.

## Reporting

Reports are read models over owned facts. They do not accept commands.

A report must distinguish:

- current state from historical state;
- no data from unavailable data;
- rejected input from omitted input;
- a recorded decision from an inferred label.

## Product boundaries

The system does not own:

- the semester catalogue;
- partner-school pupil data;
- provider account lifecycles;
- production deployment authority;
- an automatic admission-decision aggregate;
- automatic school matching or dispatch;
- payroll, ledger, procurement, or bank settlement.

Those boundaries may be integrated through explicit services. They must not be
invented inside unrelated workflows.
