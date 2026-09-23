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

A local cutover rehearsal used the private 2024-08-22 legacy backup.
The MariaDB source account had SELECT-only grants. A separate PostgreSQL
17 database received the native import. The driver reconciled 2,893 of
2,923 source people and quarantined 30. It seeded 5 departments, 28 semesters,
44 schools, and 43 school-department links. It imported 1,690 of 1,815
assistant-service rows. It quarantined 125 rows: 105 invalid, 10 without
mappings, and 10 with duplicate targets. The native history view contains
1,681 distinct historical affiliations.

The same transaction reconciled all 2,923 credential rows. It created 1,482
Person-bound Accounts with unchanged supported legacy hashes. It quarantined
1,441 rows: 1,421 without passwords, 13 inactive, 5 invalid, and 2 without
accepted Person mappings. Legacy usernames and company email addresses remain
unsupported login aliases. The import did not infer a current affiliation or
placement. A synthetic LegacyBackup Account signed in through native Better
Auth with a known password. Real backup passwords are unknown; the rehearsal
did not authenticate a real person.

The local journey proved rollback after induced historical and credential
failures, fresh-target rejection, exact replay, backup/restore content
equivalence, restored replay, and private cleanup. The Person rollback,
concurrent import, changed-source, and own-profile gates also passed.

The driver reads one consistent, read-only InnoDB source snapshot. It requires
an explicitly selected, empty native database for first import. Replay checks
the same source evidence and target references. Devenv provisions the local
source and a separate native PostgreSQL target. This is a backup rehearsal.
It did not access or change the live system or transfer writer authority.
The backup has zero assignments for 2024 Høst. Its 92 assignments for 2024 Vår
were historical when the backup was made. It cannot prove current placements
or eventual live contents. Changes since this backup need reconciliation.

Passwordless account recovery, unsupported credentials, aliases, current
placement, receipt, private-file, and settlement-reference cohorts remain.
Their synthetic paths do not infer current authority from historical facts.

## Next

The implemented recruitment sequence is complete under the current product model.
It keeps recommendation, invitation, account claim, affiliation, and placement as
separate facts. It does not infer an admission decision. Adding one requires a new
product decision that names the fact and its authority.

Close the remaining replacement gates in this order:

1. Reconcile passwordless accounts, unsupported hashes, aliases, receipts, private
   files, and settlement references with local backup evidence. Current placement
   needs a later fresh, authorized source snapshot.
2. Configure and prove authorized mail, storage, and settlement-evidence boundaries.
3. When authorized, obtain a production SELECT-only source route and a new native
   database. Reconcile changes since the backup without source writes.
4. Rehearse writer transfer, recovery, and rollback after separate authorization.

Create one active file under `docs/specs/` for the next journey. Remove it when
the accepted behavior is represented by [docs/system.md](docs/system.md), code,
and observable checks.

## Production gates

Production replacement is not authorized or rehearsed.

Before cutover:

- reconcile current Account credentials and recovery, legacy aliases, unsupported
  credentials, historical affiliations, placements, receipts, and private files;
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
