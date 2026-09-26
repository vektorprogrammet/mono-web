# Intended system

**Status:** Target business model and product behavior. Revised 2026-09-26.

This document explains the replacement system. It describes intent, not production
state. [STATE.md](../STATE.md) records what is implemented and accepted.

## Purpose

Vektorprogrammet sends volunteer university students to partner schools as
assistants. An assistant helps pupils during regular mathematics lessons, in the
classroom. The partner schools are primary and lower secondary schools (barneskole
and ungdomsskole). The system also supports the organization that recruits, places,
schedules, and monitors these assistants.

The operational core is a school-service commitment:

```text
school demand + eligible assistant supply
  -> automatic placement draft
  -> coordinator-adjusted placements
  -> reviewed proposal
  -> coordinator-confirmed roster
  -> dated school-service commitment
  -> recorded absences and coverage
  -> Completed | Cancelled | Unfulfilled
  -> immutable evidence and service history
```

Recruitment, onboarding, organization administration, expense reimbursement,
events, certificates, content, and communication support this core. They are
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
- A **Department** is the local chapter of Vektorprogrammet in one university city.
  Each department recruits, places, and schedules its own assistants.
- A **VolunteerAffiliation** records that a person can serve as an assistant in one
  department. It has an independent lifecycle.
- An **Appointment** records a position in a unit for a time range. A unit is a
  team or a board. The position maps to one role type, and the role type gives
  the authority.
- A **Delegation** gives the current members of one team one capability in one
  area for a time range.
- A **Grant** gives one Person or one service principal named authority for a time
  range. Global administration is a grant.
- A **Placement** assigns an assistant to recurring school service on one weekday,
  in one or both teaching blocks of a semester.
- A **SchoolServiceCommitment** binds a school, dated service interval, demand,
  and the assistants scheduled to meet it. It does not replace a Placement.
- An **Absence** records that one scheduled assistant cannot serve on that dated
  commitment. It does not erase the placement or the school's need. A coverage
  record can name the person who covers the absence: a substitute or another
  assistant.
- A **SemesterRef** identifies an external semester. Vektorprogrammet uses semesters
  but does not own their lifecycle. Each semester has its own admission, placement,
  and school service.
- A **teaching block** (bolk) is one half of a semester. An assistant serves in
  block 1, block 2, or both blocks.
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

Current-assignment reconciliation requires accepted Person evidence and explicit Person, department, semester, and school mappings.
Placements owns validation, canonical writes, conflicts, and append-only import provenance through its public server boundary.
The synthetic snapshot remains a separate, restricted path.
Accepted Person evidence binds each occurrence to its source user within one snapshot. Occurrence labels alone cannot identify a Person.
An immutable source-user mapping supplies the canonical Person identity. Valid Person replay retains a separate binding for each accepted snapshot.
Missing source school relationships quarantine the affected assignments, not unrelated rows.

A reviewed legacy snapshot also requires the matching source revision, source watermark, semester, effective date, reviewer, and evidence references.
Every assignment in the selected semester needs one review entry that pins its raw source-row digest and active decision.
A combined-block assignment requires explicit evidence that one weekday applies to both blocks.
A historical backup alone does not establish current assignments.

The cutover imports references, accepted People, selected Organization, historical service, reviewed current assignments, and Accounts in one transaction.
Selected current rows do not enter historical service. An explicit historical-only choice leaves current assignments unchanged.
The importer creates Active affiliations and placements at revision 1 only when canonical targets permit them.
Several placements can share one importer-proven affiliation. Inactive and invalid rows do not compete for active slots.

Each occurrence receives an accepted or quarantined disposition. Import writes no human decisions, authority grants, attendance, or notification work.
Exact replay preserves later native changes. Changed source identity, review, references, or snapshot content fails without partial writes.
Supplied review evidence does not independently prove freshness, currentness, or production authority.

Reviewed Organization reconciliation uses the [public Organization boundary](../packages/database/src/organization/reviewed-cohort.ts).
It requires accepted Person evidence for the exact source snapshot and accepted department mappings. Numeric legacy user IDs never become Person IDs implicitly.

Each team or board membership needs one review entry that binds its raw digest and supplies an interval or explicit exclusion.
The review defines the authorization instant. Historical appointments, future appointments, suspended members, and inactive units confer no current authority.
A current membership of a legacy Styret team becomes a seat on the board of its department. A current Hovedstyret membership becomes a seat on the national board.
Each imported title becomes a position of its unit, and each position maps to one role type.
A legacy team that works for the whole organization, such as Økonomi, becomes a national team. Its home stays in its department.
A current team leader receives the scope of the team only. The leader also holds a derived seat on the governing board of the team.
Import never creates grants, delegations, human lifecycle events, or notification work. Board leaders and global administrators create delegations explicitly.

Malformed or unresolved rows receive individual quarantine dispositions. Exact replay preserves later native changes. A requested cohort needs at least one accepted appointment.
The source reader adds Organization tables only after explicit selection. Review evidence alone does not establish current production facts or authorize cutover.

## Core lifecycles

### Recruitment and affiliation

Each department runs its own admission for each semester. A new applicant submits
the assistant application on the public site. The application states the field of
study, year of study, weekday availability, teaching blocks, and school wishes.
School wishes name a school level, a preferred school, and a teaching language.

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

There is no inferred generic “accepted applicant” fact. For a new applicant, the
interview recommendation decides admission. An interviewer from the recruitment
team (Rekruttering) records it. No coordinator makes a separate admission decision.

A returning assistant registers again for each new semester, without an interview.
The registration states the same availability and school wishes as an application.
The assistant can use the existing account and history. The assistant still needs
an explicit affiliation in the department and an explicit placement.

When the placements for the semester are complete, each new applicant and each
returning assistant has one admission outcome: admitted, substitute, or rejected.
A Kanskje (maybe) recommendation implies no outcome. The recruitment team
(Rekruttering) then decides whether the person is placed, a substitute, or rejected.
An admitted person has a placement. A substitute is also admitted but has no
placement. A substitute is on call during the semester and can cover an absence.
The school coordination team (Skolekoordinering) sends the outcome message to each
person.

The onboarding claim link is a bearer capability for one invitation. A consumed claim capability cannot be used again.
A holder without an account presents only the link and creates an account; a request that also carries a session or bearer fails.
A signed-in holder links the existing account without changing that account's email. The session is then the one principal, and the link is a requirement bound to its invitation, not a second credential.
Claiming the account grants neither affiliation nor a placement.

Applicant progress shows the same facts in sequence. Interview or returning
registration completion can lead to a pending affiliation, active affiliation,
and active school placement. Placement is the final visible state. Affiliation
does not hide an earlier invitation or cancellation, and the projection does not
invent a separate admission answer.

Global administrators maintain reusable interview questionnaires. They can create, revise, activate, or deactivate a questionnaire.
The question types are free text, dropdown, single choice, and multiple choice.
Each assigned interview retains its saved questions and answers. Later questionnaire changes affect future assignments only.
Unavailable historical questions remain unavailable; the system does not replace them with the current definition.

Board leaders maintain primary and optional co-interviewers in the departments that they cover. Global administrators can maintain staffing across departments.
Both interviewers must be eligible, distinct people. Neither can be the linked applicant.
Staffing changes preserve schedules, invitation capabilities, responses, assessments, and onboarding facts. They send no new invitation.
Completed or cancelled interviews reject staffing changes. Removed interviewers lose assignment-based access on the next authorized interaction.

Both maintenance workflows require a reason and the observed revision when updating an existing record.
State, immutable history, and command receipts commit together. Replays recheck current authority without repeating the change.
Queued notifications retain their original content and recipients. Staffing changes do not bypass notification integrity or cancellation checks.

After an applicant requests a new interview time, authorized staff can select a replacement through the scheduling board.
Pending, accepted, rejected, completed, and cancelled interviews do not permit general rescheduling.

A replacement creates a new schedule and invitation. It supersedes the previous invitation and resets the current response to Pending.
Previous schedules, responses, messages, command receipts, audit records, and notification envelopes remain immutable. Old invitation links cannot access the replacement.
Current boards, interview conduct, reports, and applicant progress use the current schedule without duplicate rows.

Each replacement rechecks current authority and the observed revision in one transaction. Exact retries return the original outcome without repeating the change.
Transient failures retain the draft and request identity. Conflicts retain the draft for explicit refresh without overwriting newer state.
Superseded notification work cannot start another provider attempt. An existing attempt can finish, but its acknowledgement cannot change replacement facts.

### School administration

Schools owns partner-school identities, contacts, language, active status, and department associations.
A school contact is data. It is not a principal and it holds no role.
A current global administrator can maintain every school. Board leaders can maintain schools in the departments that they cover.
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

Placement demand specifies the school, weekday, teaching block, semester, and
required number of assistants. Assistant supply includes affiliation, eligibility,
availability, and school wishes. The application or returning registration of each
assistant supplies the availability and school wishes.

The school contact tells the school coordination team (Skolekoordinering) what the
school needs. The coordinator records that demand for an active school, weekday,
and teaching block.

The system first creates a placement draft automatically. The draft matches the
weekday availability and teaching blocks of the assistants to the capacity plans of
the schools. A coordinator then adjusts the draft manually. The draft creates no
placement until a coordinator accepts it.

A proposal snapshots the demand and the current active placements. Every mismatch
is explicit, and confirmation requires an exact review of those exceptions.

Confirmation freezes the roster snapshot and queues one notification per assigned
assistant. It does not prove that service occurred on a specific date. Proposal
generation never changes a placement. Placement history survives edits and removal.

Volunteers can read their active school placements for the selected department and semester.
The server filters this view by the authenticated Person; it does not expose the coordinator board.
A placement is separate from a confirmed roster and a dated commitment.

### Dated school service

An authorized coordinator establishes a commitment for one school, date, and
bounded service interval from a confirmed roster. It records the required number
of assistants and their scheduled assignments. An absence affects one assignment.
A substitute or another assistant can cover that assignment. Coverage does not
change the confirmed roster or the semester placement of the absent assistant.

The interval starts before it ends, and required demand is positive. A reviewed
proposal can still have no assigned assistant; this leaves visible unmet demand.
It cannot become Completed without evidence that actual attendance met demand.

The coordinator acts within the school and semester scope. The coordinator can
record evidence received from a school contact and retain its source. The school
contact does not act in the application.

The commitment stays open until an authorized actor records one terminal outcome:

| Outcome     | Required evidence                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed   | An immutable occurrence records actual attendance for the same interval. Attendance meets the recorded demand. It can include the people in coverage records.        |
| Cancelled   | The decision records the actor, time, reason, and source of the cancellation. It records no invented attendance.                                                     |
| Unfulfilled | The decision records unmet demand, any actual attendance, the actor, time, and supporting evidence. An uncovered absence alone does not decide the whole commitment. |

A request for better evidence leaves the commitment open. An elapsed end time
marks it overdue for review; time alone does not prove completion or cancellation.
A terminal decision is immutable. Concurrent or repeated commands cannot create
a second terminal outcome. A later correction needs a separate authorized
reversal contract; it cannot silently rewrite the original evidence.

Coordinator cards identify the absent person and the actor who recorded each terminal decision.
Attendance lists contain only the people recorded as present, not everyone assigned to the service. Empty attendance is explicit.

Names come from the matching assignment or the coverage record. Missing names use
stable person identifiers. The deciding actor uses its recorded identifier.
The cards use existing authorized responses. They perform no separate identity lookup.

### Substitute coverage

The system records absences and coverage only. Assistants and substitutes agree in
Slack, outside the system, on who covers an absence.

A scheduled assistant or a scoped coordinator can report an absence for a confirmed
slot and service date. The report stores no medical reason or free text. A coverage
record names the person who covered the absence on that date: a substitute or
another assistant. Neither record changes the confirmed roster or a placement.

When service occurs, its attendance records the confirmed roster minus absent
assistants plus the people in coverage records. An absence closes as Covered or
Uncovered against that occurrence. These outcomes describe one assignment, not the
whole school commitment. Cancellation or unfulfilled service with no attendance
records no invented occurrence. Absence, coverage, occurrence, and commitment
outcome remain separate durable facts.

### Expense reimbursement

Expense claims are the only money flow in the system. A volunteer submits a claim
and a private receipt file. Assistants claim travel to school, and team members
claim the costs of social events.

A volunteer submits a claim under a payment-authority grant for a department. The
payment destination is private Economy data that belongs to that grant. The grant
itself holds no account data. A claim keeps the encrypted destination that it was
submitted against.

The economy team holds two national delegations. The first lets every current member
of the team read the file, approve or reject the claim, and reopen a rejected claim
when policy allows. Approval does not prove payment and leaves the claim `Approved`.

The second delegation reaches only the leader of the economy team, the finance lead.
After approval, the finance lead pays the claim outside the system. The finance lead
then records immutable evidence of that external settlement. The evidence preserves the amount, destination fingerprint,
external authority and reference, settlement time, recording actor, and receipt
revision. Owners can read their evidence. Finance readers see only evidence within
their active scope. Notification failure does not roll back the evidence, and retry
keeps the original effect identity.

Claim state, file custody, approval authority, settlement authority, delivery
attempts, and settlement history are separate facts. A file path, an approval
capability, or a team name does not give settlement access.

Reviewed receipt migration runs after accepted Person and reference reconciliation.
The [review contract](../packages/domain/src/receipt/review.ts) binds each source receipt to ownership, department, date, account, and private-file evidence.
Every occurrence receives an accepted, quarantined, or excluded disposition. Source ownership remains unique across native and reviewed importers.
Imports create no grants, human audit events, notifications, or settlement evidence. A reviewed legacy refund becomes approval, not proof of payment.

Payment accounts use authenticated encryption with receipt-specific context. Keyed commitments bind source accounts without plaintext in reviews or reports.
Exact replay preserves native edits and the original ciphertext. It observes private bytes again instead of trusting a previous success.
SQL and file storage do not share a transaction. Failed promotion remains pending and can resume after process restart or database and file restore.
Native edits that differ from the retained import facts also remain pending. Replay never overwrites them.

The combined rehearsal shares accepted Person identities across Accounts, Organization, assignments, historical service, and receipts.
Source evidence must agree across the SQL and receipt phases. A successful SQL phase does not complete the candidate.
Native sign-in and scoped reads exercise imported identities. Logical restore retains the database, private bytes, and required secrets.
Synthetic acceptance remains separate from historical-data accounting and production readiness.

### Organization administration

Authorized people manage local departments, teams, boards, positions, team and board memberships, and team interest.
Each department has one board (Styret). The national board (Hovedstyret) serves every department.
Team and board memberships are effective-dated. A person can hold more than one position and more than one team or board membership.

Teams and boards are units. A unit is a scope, and it never holds authority itself.
A team has a home department and a scope. The scope is the home department, or the whole organization for a national team.
A national team, such as Økonomi, has its home in one department but works for the whole organization.

A department governs itself only while Hovedstyret recognizes it as independent.
The board of an independent department is the governing board of the department and its local teams.
Hovedstyret is the governing board of the national teams, of every department that is not independent, and of every team without a board.
The governing board creates, defines, and dissolves a team.

A position is a title that its unit defines, such as leder, nestleder, or sekretær.
Each position maps to exactly one role type: team member, team leader, board leader, or board member.
Authority comes from the role type. A title alone gives no authority.

An appointment on a team gives authority within that team only.
The team leader authorizes each appointment to the team. A team leader acts within the team.
A board leader acts in the area of the board: its department for the board of an independent department, and every department for Hovedstyret.
A board member holds a seat but no administration.

Every current leader of a local team also sits on the board of the team's home department.
Every current leader of a national team also sits on Hovedstyret.
Such a derived seat starts and ends with the team leadership. It gives membership, not administration.
The members of the board of an independent department, derived seats included, issue certificates for that department.
For a department that is not independent, the seats on Hovedstyret issue its certificates.
A global administrator can issue certificates in every department.
A seat on the national board does not make a person a global administrator.

Authorized appointment actions create, revise, end, suspend, or reinstate a responsibility.
Every action checks current scope and preserves attributable history.
Ending or suspending one appointment does not change another appointment, volunteer affiliation, or school placement.
Current authority applies to each protected request, including requests from existing sessions.
A leadership handover can appoint the successor before the predecessor leaves.
The end of the last leadership appointment revokes only its scope.

A team membership is open-ended. It stays current until an authorized person ends
it. Team membership changes usually happen at a semester boundary. A team leader is
elected for one year or for one semester.

A team member with at least one semester in the team can take leave from the team.
Leave that lasts longer than two semesters ends the team membership.

A global administrator can disable or re-enable native human account access through a separate command.
Disabled access blocks native sessions, human OAuth access, and recovery.
Re-enable requires fresh authentication and does not revive old sessions, recovery tokens, or human OAuth credentials.
Self-offboarding and removal of the last usable global administrator fail without changes, including during concurrent commands.
State, revisions, command receipts, and attributable history commit together.
An exact replay cannot duplicate history. A changed command identity payload or stale revision cannot leave a partial change.
These commands do not administer external mail, Google Workspace, or service principals.

### Membership and governance

An **organization member** is a student at a Norwegian university or college. An
organization member serves as an assistant, is a team member, or holds an elected
position. An organization member can do more than one of these at a time. All of
this work is unpaid. Organization membership lapses after three semesters without
any of these. The national board (Hovedstyret) can give organization membership to
another person for one calendar year.

An **active member** is an organization member who, in the current semester, serves
as an assistant, is a team member, or holds a board seat.

The national board is responsible for the operation of the whole organization. Its
positions are leader, deputy leader, finance lead, expansion lead, sponsor lead,
IT lead, and mentor. The leaders of the national teams hold their seats on the
national board through their team leadership
([Organization administration](#organization-administration)). The mentor has no vote. The term of the board is one year and
starts on 1 June. With fewer than five members, the board has no quorum. In a tie,
the vote of the leader counts double.

The organization members of a department elect its board (Styret). An independent
department has a board with at least three elected members. It also has at least a
recruitment team (Rekruttering) and a school coordination team (Skolekoordinering).
The national board decides whether a department is independent. If the organization
members of a department elect no board, the national board can appoint one. The
national board can also dismiss a department board.

The General Assembly (Generalforsamling) elects the national board. The national
board calls the General Assembly at least once a year, in spring. The General
Assembly has a quorum when each independent department has at least one attending
member.

A report derives the vote weights for the General Assembly. Each department receives
one vote for each of its active members, plus 100 votes. The report divides the
votes of a department equally among its attending members. No attending member
receives more than 25 votes. For a given list of attending members, the report shows
the votes of each member and whether the General Assembly has a quorum.

### Team applications

A visitor applies to one team through the public site. A team is open when the team and its department are active, the team accepts applications, its deadline is absent or later than now, and a deliverable mailbox exists.
The mailbox is the team email, or the department email when the team has none. The public team page links to the form only for open teams.
The form requires name, email, phone, year of study, field of study, biography, and motivation, each with an explicit length bound.

A submission stores one application with its submission instant. An exact replay of one request returns the original result.
A distinct submission from the same person is a second application. Anonymous submission is rate limited.
The applicant receipt and the team notification commit with the application in one transaction and are delivered after commit through the outbox.
A provider failure keeps the application; unattended recovery delivers the retained notifications. The confirmation states receipt, not delivery.

A current, nonsuspended member of the team reads its applications. The current leader of the team opens or closes intake, sets or clears the deadline against the observed revision, and deletes applications.
Global administration grants no implicit access. Deletion removes the application and its private fields from every stored notification.
Deletion and intake changes record attributable history without applicant contact details or free text. Applications are not purged automatically, and this slice records no review outcome, hiring state, or appointment.

The members of a team decide together which applicants join the team. The team
leader then authorizes the appointment of each new member.

Each new team member signs the team contract of the department and a confidentiality
declaration. The team contract sets a minimum attendance of 70 percent.

### Mailing recipients

Board leaders read recipients in the departments that they cover. A current global administrator reads recipients across departments.
The dashboard selects a department, semester, and cohort, then shows copyable current contact addresses.
The three cohorts are assistants, team members, and their union.

Assistant recipients come from accepted historical service and active placements for the selected department and semester.
Team recipients come from nonsuspended appointments that overlap the semester. An appointment that only touches a semester boundary does not qualify.
The union removes duplicate people and duplicate contact addresses. Accounts, applications, recommendations, and bare affiliations do not establish assistant eligibility.

An explicit semester must exist in the canonical catalogue. An omitted semester resolves to the unique current semester.
Missing or ambiguous references fail without changes. A missing contact can be absent, but an infrastructure failure cannot produce an empty success.
Current authority and recipient facts share one read snapshot. Revoked leadership does not retain access through an existing session.
These reads do not administer subscriptions, send mail, or synchronize an external provider.

### Communication tools

The organization uses Slack for chat and Google Workspace for email. The system
integrates with both providers through explicit services.

The first Google Workspace integration synchronizes team groups with team
membership. If a team has a Google group, the group contains the current,
nonsuspended members of that team. The system changes a group only after the team
membership change commits. A provider failure does not roll back the team
membership change.

The organization creates and deletes Google Workspace accounts manually. The system
does not create, suspend, or delete provider accounts.

### Certificates

A certificate confirms that a person served as an assistant. It lists each semester
of service with the school and the number of days served. At the end of each
semester, the school coordination team (Skolekoordinering) adjusts the number of
days that each assistant served. The certificate uses the adjusted number.
[Organization administration](#organization-administration) names who can issue
certificates.

### Surveys

The evaluation team (Evaluering) runs the surveys of the organization in Google
Forms, outside the system. The system does not own surveys or survey responses. The
system supplies the data that the surveys need: the assistants in each teaching
block and the partner schools.

The placement board of a department and semester holds that data: each placement
with its assistant, school, weekday, and teaching block, and the active partner
schools of the department. The people who coordinate placements in the department
can read the board.

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

The public site contains the assistant application, team pages with team
applications, and the contact form. It also shows sponsors and news. Assistants sign
in to the dashboard to read their placement, submit and read their expense claims,
and maintain their profile.

Each workflow owns its commands and facts. Shared infrastructure may carry an event
or deliver a message, but it does not own the business decision.

## Authority model

Authority follows relationships, scope, resource ownership, and time:

```text
permit(principal, action, resource, instant)
  = principalIsUsable(principal, instant)
  AND onBehalfAllows(principal, action)
  AND ( roleCovers(principal, action, resource, instant)
        OR delegationCovers(principal, action, resource, instant)
        OR grantCovers(principal, action, resource, instant)
        OR capabilityCovers(principal, action, resource) )
  AND requirementsHold(action, resource, instant)
```

A role relates a Person to a scope for a time range. Team memberships, board seats, affiliations, placements, interview assignments, receipt ownership, and applications are roles.
Each role has one role type from a closed set. For an appointment, the position decides the role type.
The role types are team member, team leader, board leader, board member, assistant, placed assistant, roster member, interviewer, co-interviewer, receipt owner, and applicant.
A role covers the scope where its unit sits. A team role covers its team. A seat on the national board covers every department.
A seat on the board of a department covers that department while the department is independent. Otherwise it covers nothing, and Hovedstyret covers the department.
A role gives only the capabilities of its role type.

Examples:

- An applicant can read their own application progress.
- An assistant can read their own placement.
- An interviewer can assess only an assigned interview.
- A co-interviewer can correct a completed assessment only when the scoped
  correction capability is active.
- A receipt owner can read their own file.
- A board member can issue certificates for the department of the board, and a seat on Hovedstyret for a department that is not independent.
- A team leader acts within the team. A title alone gives no authority.

A delegation lets one team act in one area. It has a name, and it names the team, one capability, the area, and a time range.
The area is the home department of the team. For a national team, the area can be another department or the whole organization.
While the delegation is current, the current members of the team hold that capability in that area.
A delegation can instead reach only the current leaders of the team.
Where this document names board leaders for a capability, a current delegation of that capability also qualifies.
A delegation can give department administration, receipt approval, or receipt settlement. It never gives system administration or the management of delegations.
The board leader of the governing board of a team creates and ends the delegations of that team. A global administrator can also create and end them.
The kind of a team gives no authority.

A named requirement restricts a permit. It never gives authority.
For example, an interviewer can schedule an interview only while the interviewer holds an appointment in the department of the interview.

Default deny. The backend checks authority at the command and query boundary. The
frontend can hide unavailable actions, but hiding is not enforcement.

Relationships, delegations, and grants are independent. A grant, such as global administration,
adds the authority that it names while it is current. Its end removes only that authority.
A current appointment keeps its scope, and ending an appointment changes no grant.
Global administration is a grant for system administration. It also covers the cross-department work that this document names for global administrators.
No seat and no appointment implies it.

A request presents one credential. A request that carries both a session cookie and
a bearer token fails. It fails whether they name one Person, two Persons, or a Person
and a service. An interview invitation response that carries a session cookie or bearer
beside its capability also fails. The backend never chooses between them. In the existing-account
onboarding claim, the session of the signed-in Person is the one principal, and a bearer
token cannot make the claim. The claim link is then a single-use requirement bound to its
invitation, not a second credential.

An OAuth client can act for a Person with an account bearer token. It never exceeds the Person's authority.
The token scope narrows that authority further. A client holds no authority of its own.
An agent, such as a chat bot, reads for the Person without a confirmation. It changes data only when the Person confirms that change.

A service caller is a separate principal, not a synthetic Person. A valid machine
credential proves its identity, but a current grant must also cover the operation,
resource scope, and time. It inherits no human appointment.

A contact message is anonymous. A quota for each visitor address limits the messages.
The homepage server authenticates to the backend with a deployment secret. This secret names no principal.

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
- the choice of who covers an absence;
- surveys and their responses;
- payroll, ledger, procurement, or bank settlement.

Those boundaries may be integrated through explicit services. They must not be
invented inside unrelated workflows.
