# Operational responsibility map

**Status:** Target operating model and migration gap map. Revised 2026-09-23.

This document states who performs work, which software context supports it, and
where the replacement is incomplete. Business meaning lives in [system.md](system.md).
Technical ownership lives in [architecture.md](architecture.md).

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

| Step                                    | Human owner                              | Software owner           | Native state                                    |
| --------------------------------------- | ---------------------------------------- | ------------------------ | ----------------------------------------------- |
| Submit application                      | Applicant                                | Admissions               | Implemented                                     |
| Schedule and conduct interview          | Interviewer                              | Recruitment              | Implemented                                     |
| Record recommendation                   | Interviewer                              | Recruitment              | Implemented                                     |
| Report and correct completed assessment | Coordinator or authorized co-interviewer | Recruitment              | Implemented                                     |
| Issue and answer onboarding invitation  | Recruitment coordinator and applicant    | Recruitment and Identity | Implemented                                     |
| Claim account and manage profile        | Applicant                                | Identity and Profile     | Implemented                                     |
| Request and establish affiliation       | Applicant and authorized leader          | Placements               | Implemented                                     |
| Place at school                         | Coordinator                              | Placements and Schools   | Implemented for current native journey          |
| Separate admission decision             | Undefined                                | No native owner          | Product decision required before implementation |

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

The native implementation proves roster confirmation, dated absence, sequential
substitute offers, acknowledgement, attendance, and per-absence Covered or
Uncovered closure with synthetic resources. These facts do not yet establish a
dated commitment or a terminal school-service outcome. [State](../STATE.md)
records the evidence boundary. No-show handling and required coordinator reports
need an operational-use check; certificates are not a default cutover gate.

### Reimburse an expense

```text
volunteer submits claim and private file
  -> approver reads within scope
  -> approve or reject
  -> optional authorized reopen
  -> finance settles outside or through a later explicit integration
  -> system records settlement evidence
```

Native receipt submission, private-file custody, scoped approval, rejection,
reopening, audit, and delivery retries exist. Real payment authority and the wider
finance process are not yet defined. Do not treat receipt approval as bank settlement.

### Run organization operations

```text
create or update organizational unit
  -> define positions
  -> appoint person for an interval
  -> derive scoped capabilities
  -> revoke or end appointment
  -> retain history
```

Native organization, team-interest, directory, content, and social-event journeys
exist. The old linear user-role hierarchy must not become the new domain model.

### Run a survey

```text
authorized actor creates survey
  -> participant submits once under audience policy
  -> owner closes survey
  -> results projection becomes available
  -> authorized export may run
```

The native system has scoped creation, anonymous response, closure, policy-
controlled results, counts, and CSV export. Generic survey feature parity is
not a cutover gate unless an active service path requires it.

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
| Surveys                   | Survey owner and participant        | Surveys                      | Export storage or delivery                        |
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
retention requires it. School feedback used in active service follow-up is a
separate contract from general survey parity.

## Migration accounting

Every legacy fact in an active core journey needs one declared disposition:
**import as current**, **import as history**, **retain in an archive**,
**quarantine for a human decision**, or **prove no active instance exists**.
The migration manifest records source identity, snapshot and watermark, mapping,
transformation revision, disposition, target identity, and reason. Do not use
aggregate equality to hide swapped or omitted identities.

| Source cohort or boundary                                         | Current evidence                                                                                                                                                           | Required closure                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person, profile, Account, and credentials                         | The 2024 backup rehearsal imports mapped People and supported hashes; it provisions eligible passwordless identities. One accepted Person still lacks a valid login email. | Verify current identity and mailbox ownership, correct that address, decide unsupported hashes and aliases, and reconcile every new or changed account. Preserve any new password on replay.                              |
| Departments, schools, semesters, and historical assistant service | The local driver imports explicit references and accepted service history. It does not turn history into present authority.                                                | Reconcile rejected and ambiguous rows against a fresh source; preserve history without fabricating affiliation, placement, or human decisions.                                                                            |
| Active affiliation and school placement                           | A synthetic assignment cohort exists, but the 2024 backup cannot establish current placements.                                                                             | Obtain fresh active assignments and explicit Person, chapter, semester, school, and slot mappings. Reject overlap and unowned targets; prove exact current reads.                                                         |
| Active recruitment and organization work                          | The current backup cutover reader covers six tables, not all live applications, interviews, invitations, membership, or open demand.                                       | Inventory each active source writer and record. Import, attest empty, or arrange an approved operational handover for every open case. Verify current authority separately from role labels.                              |
| Open service and delivery work                                    | Synthetic roster, absence, substitute, and notification journeys exist. The source reader does not cover every dated school commitment or pending effect.                  | Inventory open commitments, assignments, absences, offers, outcomes, and delivery attempts at the fence. Import explicit evidence or quarantine; never replay historical notifications or infer completion from a roster. |
| Receipts, payment accounts, private files, settlement             | The backup has receipt rows and paths but no authorized file bytes. Legacy account numbers are plaintext, and refunded status is not transfer evidence.                    | Obtain verified bytes and digests, map owners and departments, secure payment-account custody, quarantine missing evidence, and reconcile external settlement references separately.                                      |
| Non-core retained data                                            | Legacy Sponsor records present names, links, and logo paths. They do not establish funding agreements or income. No full feature clone is required.                        | Retain required sponsor records and verified logo assets as content or archive. Inventory real financial obligations separately; do not derive them from presentation records.                                            |

The existing cutover reader selects users, departments, semesters, schools,
school-department links, and assistant history in one read-only InnoDB snapshot.
Its one target transaction imports references, Person, history, and Accounts.
It does **not** import every cohort above. The 2024 backup is not a final source
snapshot. See [State](../STATE.md#production-gates) for local counts and limits.

Two legacy uniqueness assumptions need fresh reconciliation. The backup has
assistant-history rows with combined teaching blocks and duplicate membership
groups after valid multiple positions are excluded. Do not discard these rows
or add a unique constraint until the current source and intended meaning agree.

## Interface and provider closure

| Seam                        | Required proof before claiming the contract                                                                                                                                                        | Current limit                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human client to server      | Run applicant, volunteer, coordinator, and finance journeys through the generated external HTTP and SDK surface, including denial, stale write, retry, and recovery.                               | Local synthetic journeys are not production user proof. Better Auth credential routes remain separate from native OpenAPI.                                                                                       |
| Service to server           | Exercise a real service credential through the mounted HTTP ingress, scoped grant lookup, revocation, and denial without a Person cookie. Treat source-network rules as additional isolation.      | Local mounted HTTP proves scoped service approval-queue reads, denial, revocation, and human access. No deployed service credential or provider proof exists. Internal receipt evidence still requires a Person. |
| Server to PostgreSQL        | Show an authorized command commits its fact, revision, evidence, audit, and outbox together; denial, conflict, or crash leaves no partial business state. Prove restore and replay.                | Direct placement/substitute database calls remain to be checked against the intended domain-service seam.                                                                                                        |
| Server to providers         | Prove real mail, private storage, delivery acknowledgement, restart recovery, and settlement-evidence authority on the exact candidate revision. Add SMS only where an active journey requires it. | No authorized deployed provider journey exists. [State](../STATE.md) records the unresolved schema-migration ownership mismatch.                                                                                 |
| Migration to native storage | Prove every source occurrence has a disposition, changed source is refused, exact replay writes nothing new, and rollback and restored replay retain owned facts and file bytes.                   | The current rehearsal proves only the named local cohorts. No final live delta, receipt archive, or writer transfer has been observed.                                                                           |

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
