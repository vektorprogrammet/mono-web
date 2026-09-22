# State

Lifecycle: build

## Current

The native replacement has substantial local functionality. Production still
runs the legacy PHP application.

The latest observed native runtime architecture is revision
`9b923ed42c40e2b7c62f938af217e89aacd80c47`.

Implemented native journeys include:

- identity, sessions, OAuth, password recovery, and profile self-service;
- scoped organization, directory, team-interest, and mailing-list operations;
- admission periods, public applications, applicant progress, returning
  registration, interview assignment, scheduling, response, conduct,
  recommendation, reporting, and immutable completed-assessment corrections;
- onboarding invitation, account claim or link, volunteer-affiliation request
  and establishment, manual school placement, and coordinator-confirmed school
  service from demand through acknowledged notification and recorded attendance;
- substitute preferences and scoped pool administration;
- expense submission, private-file custody, scoped approval, rejection,
  reopening, refund, and acknowledged notification delivery;
- content publication, contact messages, social-event creation, and anonymous
  school-survey participation.

These journeys were observed with synthetic local resources. This is not
production cutover evidence.

The native architecture now uses one Effect backend runtime, one PostgreSQL
ownership layer, generated HTTP and SDK contracts, transaction-bound authority,
atomic audit/outbox/receipt writes, and Foldkit dashboard workflows.

## Next

Close complete operating outcomes in this order:

1. Add absence reporting, substitute dispatch, acceptance, acknowledgement, and
   service-history closure.
2. Close remaining recruitment outcomes. Add a coordinator admission decision
   only if the organization defines it as a separate fact and authority.
3. Complete survey administration, audience rules, results, and exports.
4. Define the wider finance workflow, payment authority, and settlement evidence.
5. Reconcile real identity, credentials, files, affiliation, and placement data.
6. Rehearse production writer transfer, recovery, and rollback.

Create one active file under `docs/specs/` for the next journey. Remove it when
the accepted behavior is represented by [docs/system.md](docs/system.md), code,
and observable checks.

## Production gates

Production replacement is not authorized or rehearsed.

Before cutover:

- reconcile Account, Person, profile, legacy aliases, and unsupported
  credentials;
- reconcile historical affiliations, placements, receipts, and private files;
- configure and prove real mail, SMS, storage, and payment authority;
- run the final data import against an authorized production snapshot;
- fence legacy writers before native ownership starts;
- prove backup, restore, rollback, delivery recovery, and reconciliation;
- obtain explicit operator authority for each external or destructive action.

Team membership must never stand in for volunteer affiliation. A recommendation
must never stand in for an explicit coordinator outcome.

## Evidence boundary

Code and generated contracts describe the implemented surface. Focused checks
and real local journeys prove only the exact behavior that they exercise.
Neither local evidence nor this file proves production readiness.

Historical specifications, screenshots, logs, reports, and runtime bundles were
removed from the working tree. Git history retains tracked material. Unique
umbrella documentation was preserved in the local checksummed history archive
before deletion.
