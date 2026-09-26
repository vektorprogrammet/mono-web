# Operational responsibility map

**Status:** Target operating model and replacement contracts.

This document defines human responsibility and the outcomes that replacement must preserve.
Business meaning lives in [system.md](system.md). Technical ownership lives in [architecture.md](architecture.md).
[STATE.md](../STATE.md) alone records current implementation, acceptance, migration gaps, and next work.

## Responsibility rules

1. A person can hold several responsibilities at the same time.
2. Responsibility follows an active relationship and scope, not a role label.
3. Team membership is not volunteer affiliation.
4. Interview assignment is not admission authority.
5. A navigation label is not authorization.
6. An authenticated human action uses IAM with only the required scope.
7. The software records facts and enforces authority. An authorized human makes
   ambiguous business decisions.

## Stakeholders

| Stakeholder             | Operational responsibility                                                       | Required scope                                 | Must not imply                            |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Anonymous visitor       | Read public content and submit a public application or contact message           | Public                                         | Account, affiliation, or staff authority  |
| Applicant               | Maintain own contact data and follow own recruitment progress                    | Own Person or application                      | Volunteer affiliation or placement        |
| Interviewer             | Schedule, conduct, and assess assigned interviews                                | Assigned interview and local recruitment scope | Admission decision for all applicants     |
| Co-interviewer          | Participate in assigned interview and make an authorized correction              | Assigned interview plus correction capability  | General recruitment administration        |
| Recruitment coordinator | Coordinate schedules, inspect recommendations, issue onboarding invitations      | Local recruitment scope                        | Automatic affiliation or school placement |
| Volunteer               | Maintain own profile, availability, preferences, claims, and substitute interest | Own active affiliation                         | Team or administrative authority          |
| Team member             | Perform work for an organizational unit                                          | Active appointment                             | Volunteer affiliation                     |
| Team leader             | Manage scoped membership and team operations                                     | Active leadership appointment                  | Authority outside the unit or interval    |
| School contact          | Provide demand or evidence to a coordinator; use IAM if acting in the app        | Named school and semester                      | Coordinator or unrelated school authority |
| Receipt approver        | Read scoped receipt files and decide claims                                      | Active economy grant and claim scope           | General finance or payment authority      |
| Coordinator             | Propose and confirm scoped school placements and coverage                        | Chapter, school, and semester scope            | National authority                        |
| Global administrator    | Perform exceptional administrative actions                                       | Explicit active grant                          | Ownership of every business decision      |
| System operator         | Run migration, backup, restore, deployment, and recovery                         | Production environment authority               | Business approval authority               |
| Delivery worker         | Claim committed outbox work and record attempts                                  | Technical outbox lease                         | Power to create the business fact         |

Sponsor-team members seek funding from businesses and organizations. Their team
appointments do not create volunteer affiliation or finance approval authority.
Sponsor presentation is content, not proof of a sponsorship agreement or income.
Record only team activities that the application actually supports.

## End-to-end processes

### Recruit a new volunteer

```text
Applicant submits
  -> interviewer is assigned
  -> interview is scheduled and completed
  -> recommendation is recorded
  -> coordinator reviews and reports
  -> onboarding invitation is issued
  -> applicant claims an account
  -> applicant requests affiliation
  -> authorized leader establishes affiliation
  -> coordinator may create a placement
```

| Step                                    | Human owner                              | Software owner           |
| --------------------------------------- | ---------------------------------------- | ------------------------ |
| Submit application                      | Applicant                                | Admissions               |
| Schedule and conduct interview          | Interviewer                              | Recruitment              |
| Record recommendation                   | Interviewer                              | Recruitment              |
| Report and correct completed assessment | Coordinator or authorized co-interviewer | Recruitment              |
| Issue and answer onboarding invitation  | Recruitment coordinator and applicant    | Recruitment and Identity |
| Claim account and manage profile        | Applicant                                | Identity and Profile     |
| Request and establish affiliation       | Applicant and authorized leader          | Placements               |
| Place at school                         | Coordinator                              | Placements and Schools   |

A separate admission decision needs an explicit business owner and lifecycle. It does not follow from the steps above.

### Return an existing volunteer

```text
Authenticated person
  -> request chapter affiliation
  -> leader establishes affiliation
  -> coordinator creates or updates placement
  -> history remains intact
```

Identity reconciliation must prevent a second Person or Account for the same human.
Historical placement and assessment records must survive.

### Plan and deliver school service

```text
school demand + assistant supply
  -> reviewed proposal
  -> confirmed recurring roster
  -> dated school commitment and scheduled assignments
  -> absence and reassignment when needed
  -> recorded transition evidence
  -> Completed | Cancelled | Unfulfilled
```

A dated commitment records demand, scheduled assignments, and immutable Completed, Cancelled, or Unfulfilled evidence.
Covered and Uncovered describe each absence, not the whole commitment.
A roster is not attendance. Cancellation creates no attendance occurrence.
[State](../STATE.md#evidence-boundary) records the local observations and their limits.

### Reimburse an expense

```text
volunteer submits claim and private file
  -> approver reads within scope
  -> approve or reject
  -> optional authorized reopen
  -> finance settles outside or through a later explicit integration
  -> system records settlement evidence
```

Claim state, private-file custody, approval, settlement evidence, and delivery are separate responsibilities.
An authorized recorder attaches evidence of external settlement. The native application does not perform a bank transfer.
Receipt approval does not prove payment or grant settlement authority.

### Run organization operations

```text
create or update organizational unit
  -> define positions
  -> appoint person for an interval
  -> derive scoped capabilities
  -> revoke or end appointment
  -> retain history
```

Appointment changes preserve history and unrelated responsibilities. Suspension and term-end affect authority, not Person identity.
Native account disabling is a separate global-administrator action. Re-enable does not revive old sessions.
External mail, Workspace, and service-principal administration require separate custody.
The old linear user-role hierarchy must not become the new domain model.

### Run a survey

```text
Evaluering prepares the semester's forms in Google Forms
  -> a placement coordinator reads the placement board of the department and semester
  -> Evaluering sends the forms to the assistants of each teaching block and to the partner schools
  -> Evaluering compiles the results outside the system
```

The system owns no survey or survey response. The placement board supplies each placement's assistant,
school, weekday, and teaching block, and the active partner schools of the department.

## Service ownership

| Concern                   | Business owner                      | Native context               | External dependency                               |
| ------------------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------- |
| Identity and sessions     | Account holder and operator         | Identity                     | Credential engine and OAuth providers             |
| Recruitment               | Applicant, interviewer, coordinator | Admissions and Recruitment   | Email delivery                                    |
| Affiliation and placement | Volunteer, leader, coordinator      | Placements and Schools       | Semester reference                                |
| Substitute coverage       | Volunteer and coordinator           | Placements and Substitutes   | Notification delivery                             |
| Organization              | Leaders and administrators          | Organization                 | Semester reference                                |
| Expenses                  | Claimant and approver               | Economy                      | Private storage, email, later payment integration |
| Public content            | Content editor                      | Content                      | Public web runtime                                |
| Events                    | Event organizer and participant     | Social events                | Notification delivery                             |
| Surveys                   | Evaluering                          | Placements supplies the data | Google Forms                                      |
| Audit and delivery        | System operator                     | Database and backend workers | PostgreSQL and providers                          |

## Replacement contract ledger

Migration preserves the work people can complete and the facts they can trust.
It does not preserve PHP routes, database tables, screens, status-code accidents,
or the legacy role hierarchy. [The intended system](system.md) owns business
meaning. [The architecture](architecture.md#interface-contracts) owns interface
seams. [State](../STATE.md) owns current implementation and proof status.

For each contract below, acceptance needs an authorized actor, starting facts,
one business transition, the observable result, a denied case, and recovery from
retry or failure. A different native workflow is valid when those properties
hold. A row in an API catalogue is not sufficient proof.

| Contract                            | Observable result that must survive replacement                                                                                                                                                                                               | Failure that must be rejected                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and own profile            | One Person can claim or use an Account, recover access, and edit only their own profile. Account, affiliation, and role remain separate.                                                                                                      | Unmapped or inactive identity, reused recovery link, another Person's profile, or a stale grant.                                                   |
| Recruitment and onboarding          | A public application, assigned interview, recommendation, invitation, claim, affiliation request, and leader decision remain separate visible facts. A returning volunteer keeps their identity and history.                                  | Closed-period or duplicate application, unassigned assessment, invalid invitation, cross-chapter action, or an inferred admission decision.        |
| Organization and authority          | Leaders manage effective-dated units, appointments, membership, and directory facts within their scope. Revocation affects the next action.                                                                                                   | Local title used as national authority, expired appointment, team interest used as membership, or team membership used as affiliation.             |
| School demand and placement         | A coordinator sees demand and eligible supply, reviews proposal exceptions, then confirms a roster. Placement edits retain history and notify assigned people.                                                                                | Stale or unreviewed proposal, wrong school or semester, overlap, or history used to invent a current placement.                                    |
| Dated service and coverage          | A school commitment names its service interval, demand, and scheduled assistants. Absence can trigger reassignment. Completion, cancellation, or unfulfilled service has distinct evidence; Covered or Uncovered describes each absence only. | A roster or accepted offer counted as attendance, an uncovered assistant counted as a failed whole session, or a terminal result without evidence. |
| Expense reimbursement               | A claimant submits a claim and verified private file. A scoped approver decides it. A separately authorized recorder attaches immutable external settlement evidence.                                                                         | Another owner's file, cross-scope approval, file-less import, stale edit, or approval/refunded status presented as payment proof.                  |
| Communication and operational reads | Recipients see current status and authorized history. Committed notifications can recover after provider failure without a second business decision.                                                                                          | Lost outbox work, duplicate effect, confidential cross-scope read, or a report that confuses unknown, rejected, and absent facts.                  |

[Recruitment](system.md#recruitment-and-affiliation),
[placement](system.md#school-demand-and-placement),
[dated service](system.md#dated-school-service),
[coverage](system.md#substitute-coverage), and
[economy](system.md#expense-reimbursement) define the detailed transitions.
The native system adds explicit denials, revisions, idempotency, audit, private
file custody, and settlement separation. These are stronger contracts, not
reasons to copy legacy implementation. Legacy error codes such as an incidental
500 on duplicate input are not parity requirements.

No-show handling, service corrections, and coordinator reporting need a fresh
operational-use check. If an active core journey depends on one, either provide
the outcome in native software or approve a safe, explicit transition process.
Do not silently classify an active obligation as a peripheral feature.

Changelogs, historical articles, generic events and surveys, certificate
requests, and nonessential statistics are not cutover gates by default.
Retain their data in a protected, accessible archive when legal or operational
retention requires it. School feedback also runs in Google Forms.

## Migration accounting

Every legacy fact in an active core journey needs one declared disposition:
**import as current**, **import as history**, **retain in an archive**,
**quarantine for a human decision**, or **prove no active instance exists**.
The migration manifest records source identity, snapshot and watermark, mapping,
transformation revision, disposition, target identity, and reason. Do not use
aggregate equality to hide swapped or omitted identities.

| Source cohort or boundary                                 | Required reconciliation                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Person, profile, Account, and credentials                 | Verify current identity and mailbox ownership. Resolve invalid addresses, unsupported hashes, aliases, and changed accounts. Preserve a new password on replay.          |
| Reference data and historical assistant service           | Resolve rejected and ambiguous source rows. Preserve history without inventing current affiliation, placement, or human decisions.                                       |
| Active affiliation and placement                          | Require current assignments and explicit Person, chapter, semester, school, and slot mappings. Reject overlap and unowned targets.                                       |
| Active recruitment and organization work                  | Inventory active writers and open cases. Import, attest empty, or obtain an approved handover for each case. Verify authority separately from role labels.               |
| Open service and delivery work                            | Reconcile commitments, assignments, absences, offers, outcomes, and pending effects at the fence. Never infer attendance or replay historical notifications.             |
| Receipts, private files, payment accounts, and settlement | Verify file bytes and digests. Map owners and departments. Secure account custody. Quarantine missing evidence. Reconcile settlement references separately.              |
| Non-core retained data                                    | Retain required content and verified assets through an explicit archive or migration disposition. Sponsor presentation does not establish income or funding obligations. |

See [State](../STATE.md#historical-backup-rehearsal) for reader coverage, observed counts, and synthetic-only adapters.
Current-source reconciliation must resolve combined teaching blocks and ambiguous membership groups before imposing uniqueness constraints.

## Interface and provider closure

| Seam                        | Required proof before claiming the contract                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human client to server      | Exercise the generated HTTP and SDK journey, including denied scope, stale write, retry, and recovery. Credential routes remain separate.                 |
| Service to server           | Exercise a real service credential, scoped grants, and revocation through mounted ingress without a Person cookie. Network isolation grants no authority. |
| Server to PostgreSQL        | Verify atomic state, revision, evidence, audit, and outbox writes. Denial, conflict, and failed commit leave no partial state. Verify restore and replay. |
| Server to providers         | Verify real mail, private storage, acknowledgement, restart, and bounded retry on the exact candidate. Include SMS only for required active journeys.     |
| Migration to native storage | Account for each source occurrence. Refuse changed-source replay. Verify exact replay, rollback, restored replay, retained facts, and private bytes.      |

[State](../STATE.md#next) records remaining work at these interfaces. Local synthetic evidence is not deployed provider or production evidence.

## Cutover gates and authority

1. With operator authority, inventory the current production readers, writers,
   pending work, and retained data. Mark each active case against this ledger.
2. Freeze explicit identity, reference, account, history, current-state, and file
   mappings. Reconcile every quarantine or approve its operational disposition.
3. Prove the exact candidate version with real required providers and a new
   native database. Verify denial, recovery, backup, restore, and private bytes.
4. Read a fresh source snapshot under SELECT-only access. Record its watermark.
   Apply a reconciled delta, or rebuild a clean target when changed-source
   refusal prevents safe replay.
5. Fence legacy writers before native authority starts. Verify one writer,
   current facts, pending effects, and the rollback path after native writes.
6. Transfer or reverse ownership only with separate operator authorization.
   Retire PHP only after all required readers and writers have moved.

A continued legacy writer, unexplained delta, missing file, unresolved active
case, wrong-scope reader, or unavailable rollback blocks cutover. Production
replacement remains unauthorized; local evidence does not change that boundary.

After native writes begin, restarting PHP without reconciling those writes can
lose acknowledged work. A rollback must account for each native-only fact and
pending external effect before legacy writer authority returns.
