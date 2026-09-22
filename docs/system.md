# Intended system

**Status:** Target business model and product behavior. Revised 2026-09-22.

This document explains the replacement system. It describes intent, not production
state. [STATE.md](../STATE.md) records what is implemented and accepted.

## Purpose

Vektorprogrammet connects volunteer university students with partner schools that
need mathematics tutoring. The system also supports the organization that recruits,
places, schedules, and follows up those volunteers.

The operational core is:

```text
school demand + eligible volunteer supply
              |
              v
       roster proposal
              |
              v
   coordinator confirmation
              |
              v
    delivered teaching service
              |
              v
history, certificate, feedback, and coverage recovery
```

Recruitment, onboarding, organization administration, expenses, events, surveys,
content, and communication support this core. They are separate workflows, not one
large aggregate.

## Business facts

- A **Person** is a stable human identity.
- An **Account** authenticates a Person. Credentials and sessions belong to the
  account lifecycle.
- A **Profile** stores the person's contact data.
- A **VolunteerAffiliation** records that a person can serve as an assistant in one
  local chapter. It has an independent lifecycle.
- An **Appointment** records a position in an organizational unit for a time range.
- A **Placement** records assigned teaching service at a school.
- A **SemesterRef** identifies an external semester. Vektorprogrammet uses semesters
  but does not own their lifecycle.
- Roles shown in a menu are projections. They are not the authority model.

These facts may overlap. One person can be a volunteer, team member, team leader,
receipt approver, and coordinator at the same time. Leaving a team must not erase
volunteer history or school placement.

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

### School demand and placement

Partner-school demand includes capacity, weekday, teaching block, location,
language, and semester. Volunteer supply includes affiliation, eligibility,
availability, and preferences.

The coordinator records demand for an active school, weekday, and teaching block.
A proposal snapshots that demand and the current active placements. Every mismatch
is explicit, and confirmation requires an exact review of those exceptions.

Confirmation creates one durable notification for each unique assigned volunteer.
After acknowledged delivery, the coordinator can record one teaching occurrence
whose attendees exactly match the confirmed roster for that slot. Proposal
generation never creates or changes a placement, and placement history remains
after edits or removal.

### Substitute coverage

An affiliated volunteer can opt into the substitute pool. Authorized coordinators
can find eligible substitutes for an absence and record the operational outcome.
Pool membership alone does not mean dispatch, school placement, or delivered work.

### Expense reimbursement

A volunteer submits a claim and private receipt file. Authorized approvers can read
the file, approve or reject the claim, reopen a rejected claim when policy allows,
and record settlement evidence.

Claim state, file custody, approval authority, delivery attempts, and settlement
history are separate facts. A file path or team label does not grant access.

### Organization administration

Authorized people manage local departments, national units, teams, boards,
positions, memberships, and team interest. Memberships are effective-dated. A
person may hold more than one position or membership.

A local chapter and a national unit use the same appointment mechanism but have
different scopes. A chair is not automatically a global administrator.

### Supporting workflows

The native application also contains journeys for:

- account claim, password recovery, sessions, and profile self-service;
- directory and school capacity maintenance;
- public content, contact messages, and sponsor presentation;
- social events and team interest;
- surveys and school feedback;
- certificates;
- authenticated applicant progress;
- acknowledged receipt and interview notification delivery.

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
