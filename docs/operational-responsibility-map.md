# Operational responsibility map

**Status:** Target operating model and migration gap map. Revised 2026-09-22.

This document states who performs work, which software context supports it, and
where the replacement is incomplete. Business meaning lives in [system.md](system.md).
Technical ownership lives in [architecture.md](architecture.md).

## Responsibility rules

1. A person can hold several responsibilities at the same time.
2. Responsibility follows an active relationship and scope, not a role label.
3. Team membership is not volunteer affiliation.
4. Interview assignment is not admission authority.
5. A navigation label is not authorization.
6. External recipients get narrow capabilities, not staff accounts by default.
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
| School contact          | Provide school demand or feedback through a narrow capability                    | Named school and semester                      | Staff account or unrelated school access  |
| Receipt approver        | Read scoped receipt files and decide claims                                      | Active economy grant and claim scope           | General finance or payment authority      |
| Coordinator             | Propose and confirm scoped school placements and coverage                        | Chapter, school, and semester scope            | National authority                        |
| Global administrator    | Perform exceptional administrative actions                                       | Explicit active grant                          | Ownership of every business decision      |
| System operator         | Run migration, backup, restore, deployment, and recovery                         | Production environment authority               | Business approval authority               |
| Delivery worker         | Claim committed outbox work and record attempts                                  | Technical outbox lease                         | Power to create the business fact         |

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
school demand
  + volunteer affiliation and availability
  -> constrained proposal
  -> coordinator confirmation
  -> roster
  -> teaching-service event
  -> absence or substitute resolution
  -> history and certificate
```

The current native implementation proves demand, affiliation, placement, roster
confirmation, acknowledged volunteer notification, and one recorded teaching
occurrence. It also proves substitute-pool and selected school-survey journeys.
Missing parts include absence and no-show handling, complete substitute dispatch,
service closure, and full certificate and reporting outcomes.

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

Current native coverage includes selected survey and school-feedback paths. Full
survey administration, audience policy, result publication, and export remain to be
closed as one operational journey.

## Service ownership

| Concern                   | Business owner                      | Native context               | External dependency                               |
| ------------------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------- |
| Identity and sessions     | Account holder and operator         | Identity                     | Credential engine and OAuth providers             |
| Recruitment               | Applicant, interviewer, coordinator | Admissions and Recruitment   | Email delivery                                    |
| Affiliation and placement | Volunteer, leader, coordinator      | Placements and Schools       | Semester reference                                |
| Substitute coverage       | Volunteer and coordinator           | Substitutes                  | Notification delivery                             |
| Organization              | Leaders and administrators          | Organization                 | Semester reference                                |
| Expenses                  | Claimant and approver               | Economy                      | Private storage, email, later payment integration |
| Public content            | Content editor                      | Content                      | Public web runtime                                |
| Events                    | Event organizer and participant     | Social events                | Notification delivery                             |
| Surveys                   | Survey owner and participant        | Surveys                      | Export storage or delivery                        |
| Audit and delivery        | System operator                     | Database and backend workers | PostgreSQL and providers                          |

## Migration gaps

| Area                | Closed native boundary                                                                                               | Remaining work                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Recruitment         | Application, invitations, scheduling, recommendation, reporting, completed-assessment correction, applicant progress | Real cohort reconciliation, remaining recruitment outcomes, explicit admission decision if wanted |
| Identity            | Native sessions, OAuth, account claim, password recovery, profile                                                    | Real Person and Account reconciliation, unsupported credentials and aliases                       |
| Placement           | Affiliation, placement, demand, roster confirmation, notification, and teaching occurrence                           | Absence, no-show, service closure, and complete history and certificate outcomes                  |
| Substitute coverage | Pool membership and scoped operations                                                                                | Full dispatch, acknowledgement, absence closure, and delivery outcomes                            |
| Economy             | Claim, private file, approval, rejection, reopen, outbox retry                                                       | Wider finance workflow, payment authority, settlement integration                                 |
| Organization        | Units, memberships, team interest, scoped authority                                                                  | Verify all national and cross-chapter operations; retire linear legacy roles                      |
| Surveys             | Selected native survey journeys                                                                                      | Full administration, results, audience rules, and export                                          |
| Reporting           | Several recruitment, receipt, and operational projections                                                            | Complete statistics, exports, certificate, and service-delivery reports                           |
| Production          | Local synthetic PostgreSQL, browser, API, recovery, and delivery exercises                                           | Real-data rehearsal, writer transfer, rollback, deployment, and legacy shutdown                   |

## Known retained-data constraints

Two Symfony uniqueness rules are not enforced in the production database:

- `assistant_history(user_id, school_id, semester_id, bolk)`: 332 backup rows
  stored both teaching blocks in one value. Split those rows, reconcile remaining
  same-block duplicates, and run a fresh live scan before adding the index.
- `team_membership(user_id, team_id, start_semester_id, position_id)`: a historical
  backup contained seven duplicate groups after valid multi-position memberships
  were excluded. Reconcile them and run a fresh live scan before adding the index.

The 2024 backup is evidence about that snapshot only. Production cleanup is an
operator-authorized data change. Do not automate deletion of ambiguous history.

## Production authority boundary

Local development may use synthetic PostgreSQL, loopback HTTP, disposable private
storage, and test provider layers.

The following actions require separate operator authority:

- read or modify production data;
- use real credentials or provider accounts;
- send real email or notifications;
- deploy or change DNS;
- import final data;
- transfer write ownership;
- disable legacy writers;
- perform rollback or irreversible cleanup.

Before cutover, prove on the exact candidate revision:

1. identity and cohort reconciliation;
2. private-file and receipt import;
3. historical affiliation and placement mapping;
4. notification transport and suppression rules;
5. backup and restore;
6. native writer ownership;
7. rollback after writer transfer;
8. operator-observable health and failure diagnostics.

## Next development order

Complete operational journeys, not isolated endpoints:

1. Close the school-demand-to-delivered-service cycle.
2. Close substitute dispatch and acknowledgement.
3. Close remaining recruitment outcomes and decide whether admission is a real
   separate command.
4. Close survey administration, results, and exports.
5. Define wider finance and settlement ownership.
6. Reconcile real identity, files, affiliation, and placement data.
7. Rehearse production writer transfer and rollback.

Each journey gets one active contract in `docs/specs/`. Remove the contract after
its durable intent is in this map, the system document, code, and observable checks.
