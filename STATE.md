# State

Lifecycle: build

## Current

The native replacement has substantial local functionality. Production still
runs the legacy PHP application.

The latest observed native runtime architecture is revision
`32e24f6c63df88bd5c1f35bdb6371fd01c4c1431`.

Implemented native journeys include:

- identity, sessions, OAuth, password recovery, and profile self-service;
- scoped organization, directory, team-interest, and mailing-list operations;
- admission periods, public applications, applicant progress, returning
  registration, interview assignment, scheduling, response, conduct,
  recommendation, reporting, and immutable completed-assessment corrections;
- onboarding invitation, account claim or link, volunteer-affiliation request
  and establishment, manual school placement, coordinator-confirmed school
  service, own and coordinator absence reporting, sequential substitute dispatch,
  addressed acceptance or decline, coordinator acknowledgement, delivery
  recovery, exact attendance, and immutable Covered or Uncovered closure;
- expense submission, private-file custody, scoped approval, rejection,
  reopening, separately authorized immutable settlement evidence, and
  acknowledged owner-notification recovery;
- content publication, contact messages, and social-event creation;
- scoped school-survey creation, anonymous response, closure, policy-controlled
  results, response counts, and CSV export.

These journeys were observed with synthetic local resources. This is not
production cutover evidence.

The native architecture now uses one Effect backend runtime, one PostgreSQL
ownership layer, generated HTTP and SDK contracts, transaction-bound authority,
atomic audit/outbox/receipt writes, and Foldkit dashboard workflows.

The synthetic local Person reconciliation path creates or explicitly links
Person/profile records before credentials and historical operations can depend on
those identities. The reconciled Account path accepts only matching immutable
Person evidence, imports one supported credential, quarantines unsupported aliases
and conflicts, preserves replay, and exercises native sign-in, recovery, and
restore. Real cohort mapping and production import remain unperformed.

## Next

The implemented recruitment sequence is complete under the current product model.
It keeps recommendation, invitation, account claim, affiliation, and placement as
separate facts. It does not infer an admission decision. Adding one requires a new
product decision that names the fact and its authority.

Close the remaining replacement gates in this order:

1. Reconcile real identity, credentials, files, affiliation, placement, receipt,
   and settlement-reference data.
2. Configure and prove the authorized production mail, storage, and external
   settlement-evidence boundaries.
3. Rehearse production writer transfer, recovery, and rollback.

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
