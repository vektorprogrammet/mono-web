# State

Lifecycle: build

## Current

The [Cloudflare development provider boundary](docs/specs/cloudflare-development-provider-boundary.md)
is frozen for local implementation. Production use remains unauthorized.

Same-repository pull-request automation now builds exact-head homepage and dashboard
Worker Previews, probes their public documents and assets, updates one review comment,
and deletes both previews when the pull request closes. The provider journey remains
unobserved because no Cloudflare deployment or credential use was authorized.

The native replacement has substantial local functionality. Production still
runs the legacy PHP application.

The latest observed native runtime architecture is revision
`9e07114700ee5c6520d6276f7129d95184937b7c`.

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

The private 2024-08-22 legacy backup has passed a local cutover rehearsal using a
SELECT-only MariaDB account and a new disposable PostgreSQL database. The native
Person importer reconciled 2,893 of 2,923 source people and quarantined 30. The
same read-only cutover driver seeded 5 departments, 28 semesters, 44 schools, and
43 school-department links, then reconciled all 1,815 assistant-service rows:
1,690 imported and 125 quarantined (105 invalid, 10 missing mappings, 10 duplicate
targets). The native history view contains 1,681 distinct historical affiliations;
no current affiliation or placement was inferred. The local journey proved
whole-cutover rollback after induced historical failure, fresh-target rejection,
exact replay, backup/restore content equivalence, restored replay, and private
cleanup. The established Person rollback, concurrent import, changed-source,
and own-profile gates still pass.

The reusable cutover driver reads one consistent, read-only InnoDB source snapshot
through a SELECT-only account; remote source and target connections require
verified TLS. Its first import requires an explicitly selected, empty native
database; replay verifies the same source evidence and target references. No
production SELECT-only credential, connection route, or separate native target
has been supplied or configured for this rehearsal. The
2024 backup contains no 2026 current assignments, so it cannot establish current
placements. Production import remains unperformed.

Real credential and account recovery, current placement, receipt, private-file,
and settlement-reference cohorts remain. A fresh production source read must also
reconcile historical changes since the dated backup. Their existing synthetic
paths do not infer current authority from historical facts.

## Next

The implemented recruitment sequence is complete under the current product model.
It keeps recommendation, invitation, account claim, affiliation, and placement as
separate facts. It does not infer an admission decision. Adding one requires a new
product decision that names the fact and its authority.

Close the remaining replacement gates in this order:

1. Obtain a production SELECT-only source route and a new native database; rehearse
   the live Person, reference, and historical-service cohorts without source writes.
   Then reconcile credentials, account recovery, current placement, receipts,
   private files, and settlement references.
2. Configure and prove the authorized production mail, storage, and external
   settlement-evidence boundaries.
3. Rehearse production writer transfer, recovery, and rollback.

Create one active file under `docs/specs/` for the next journey. Remove it when
the accepted behavior is represented by [docs/system.md](docs/system.md), code,
and observable checks.

## Production gates

Production replacement is not authorized or rehearsed.

Before cutover:

- reconcile Account credentials, legacy aliases, unsupported credentials,
  historical affiliations, placements, receipts, and private files;
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
