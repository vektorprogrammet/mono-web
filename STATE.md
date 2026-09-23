# State

Lifecycle: build

## Current

The [Cloudflare development provider boundary](docs/specs/cloudflare-development-provider-boundary.md)
is frozen for local implementation. Production use remains unauthorized.

Same-repository pull-request automation now builds exact-head homepage and dashboard
Worker Previews, probes their public documents and assets, updates one review comment,
and deletes both previews when the pull request closes. The provider journey remains
unobserved because no Cloudflare deployment or credential use was authorized.

The frozen provider contract says the Worker applies PostgreSQL migrations through
Hyperdrive. The current Worker uses DatabaseRuntimeLive, which rejects migrations
and requires an existing schema. Resolve this ownership mismatch before claiming
the provider journey.

Credential migration now writes Argon2id and reads existing native scrypt and
supported PHP bcrypt credentials. Successful sign-in upgrades an outdated hash
with an exact-hash database condition. A concurrent reset wins; stale sign-in
sessions and cookies are removed. Current Argon2id credentials receive the same
reset-race protection. Hashing admission and input size are bounded.

A synthetic local journey exercised Better Auth HTTP and direct API sign-in
against disposable PostgreSQL, owned password recovery, and a local mail sink.
It verified denial, upgrades, reset-token replay rejection, and both reset-race
paths. The account rehearsal retains the real engine/database race regression.
Independent PHP 8.4.25 fixtures verified bcrypt byte semantics and Argon2id
compatibility. Raw PHP compatibility is broader than the legacy Symfony login
encoder, which rejects passwords longer than 72 bytes.

The codec passed on Node 24.20.0 and local workerd, including concurrent requests
and explicit overload. Local workerd used compatibility date 2026-09-21; the
product selects 2026-09-22. Worker-plus-PostgreSQL authentication was not exercised.
Measured process memory and CPU do not prove Cloudflare isolate resource limits.
Provider resource qualification remains required before production use.

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
  and establishment, manual school placement, and coordinator-confirmed roster;
- dated school-service commitments, assignment-specific absence reporting,
  sequential substitute dispatch, addressed acceptance or decline, coordinator
  acknowledgement, delivery recovery, actual attendance, and immutable
  Completed, Cancelled, or Unfulfilled decisions;
- expense submission, private-file custody, scoped approval, rejection,
  reopening, separately authorized immutable settlement evidence, and
  acknowledged owner-notification recovery;
- content publication, contact messages, and social-event creation;
- scoped school-survey creation, anonymous response, closure, policy-controlled
  results, response counts, and CSV export.

These journeys were observed with synthetic local resources. This is not
production cutover evidence.

The confirmed native roster is a recurring semester weekday/block snapshot. A
coordinator can schedule a bounded commitment for one date from this roster.
Absences and substitute offers attach to that date. A terminal decision records
actual attendance and evidence. Cancellation creates no attendance occurrence;
partial service remains Unfulfilled. The local PostgreSQL, HTTP, and Chromium
journey passed with synthetic state, including scoped denial, retries, and
desktop/mobile accessibility checks. It does not prove current production data.

A mounted local HTTP rehearsal now verifies receipt approval-queue reads by a
scoped service bearer without a Person cookie. Unscoped and revoked grants,
revoked credentials, and mixed human and machine credentials are denied. Human
cookie and OAuth user-bearer reads still work. No deployed service credential
was exercised.

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

The same transaction reconciled all 2,923 source account rows. It imported
1,482 unchanged supported hashes and provisioned 1,410 passwordless native
user identities without credentials, sessions, mail, or email-verification
flags. It quarantined 31 rows: 13 inactive, 5 invalid, and 13 without accepted Person mappings.
One accepted Person has an account email without a domain dot. The native
login email schema rejects it, so that Person has no native login identity.
A verified address correction is required before production cutover; do not
relax login validation or invent an address from the backup.
Legacy usernames and company emails remain unsupported login aliases. The
import did not infer a current affiliation or placement.

A synthetic LegacyBackup credential signed in through native Better Auth. A
separate synthetic passwordless identity requested a native reset message,
received it through the local mail boundary, set its first password, and signed
in. A reused token failed. The backup contains no known real passwords, and
no real person or external mail provider was authenticated.

The local journey proved rollback after induced historical, credential, and
passwordless import failures. It proved one concurrent import, exact replay,
changed-source refusal, native backup/restore equivalence, restored replay,
and private cleanup. Replay also preserved a credential set after import. The
Person own-profile read and cohort gates passed.

The driver reads one consistent, read-only InnoDB source snapshot. It requires
an explicitly selected, empty native database for first import. Replay checks
the same source evidence and target references. This rehearsal created separate
disposable MariaDB and PostgreSQL processes on private Unix sockets. It did
not access or change the live system or transfer writer authority.
The backup has zero assignments for 2024 Høst. Its 92 assignments for 2024 Vår
were historical when the backup was made. It cannot prove current placements
or eventual live contents. Changes since this backup need reconciliation.

Unsupported credentials, legacy aliases, current placements, receipts, private
files, and settlement references remain. The local backup does not prove
current mailbox ownership or current production identity. Synthetic
operational paths do not infer current authority from historical facts.

The 2024 backup contains 2,206 receipt rows: 2,169 marked refunded, 32
rejected, and 5 pending. All have distinct visual IDs and absolute file paths.
2,142 owners resolve to accepted People; 64 owners were not accepted because
they are inactive. The authorized backup package contains only SQL, not the
2,206 file contents. Legacy account numbers are plaintext source fields;
the native receipt requires encrypted payment-account custody. A legacy
refunded status proves neither a payment transfer nor native settlement
evidence. Do not import file-less receipts or mark them settled. A verified
file archive, explicit owner and department mapping, payment-account custody,
and settlement references are still needed for the receipt migration.

## Next

Recruitment keeps recommendation, invitation, account claim, affiliation, and
placement separate. It does not infer an admission decision. The existing
journeys do not complete ongoing organization, school, or recruitment maintenance.

The authenticated read-only audit observed autumn recruitment in all three active
chapters and 16 pending expense claims across eight owners. Empty displayed
rosters do not establish that external schedules are empty. Browser observations
are not a consistent source snapshot. The six-table backup reader does not cover
current recruitment, appointments, demand, expenses, or outstanding messages.

Close the remaining replacement gates in this order:

1. Implement appointment, leadership, term-end, and offboarding administration.
   Keep Person identity, scoped authority, and retained external-account duties separate.
2. Implement school maintenance, questionnaire authoring, interviewer changes,
   and mailing-list controls. Resolve standalone team recruitment and reminders.
3. Obtain an authorized current source snapshot and reconcile active operational
   records. Correct the known invalid account email with verified evidence.
   Reconcile aliases and unsupported credentials. Obtain receipt files and
   payment-account custody; reconcile settlement references separately.
4. Resolve provider schema ownership and verify required mail, storage, recovery,
   and Worker credential resource behavior with authorized provider access.
5. Rehearse final reconciliation, writer transfer, recovery, and rollback.
   Production cutover requires separate authorization.

Create one active file under `docs/specs/` for the next journey. Remove it when
the accepted behavior is represented by [docs/system.md](docs/system.md), code,
and observable checks.

## Production gates

Production replacement is not authorized or rehearsed.

Before cutover:

- reconcile current Account credentials and recovery, legacy aliases, unsupported
  credentials, historical affiliations, placements, receipts, and private files;
- prove required mail and private-file delivery, retained SMS or external-account
  integrations, and separately authorized settlement evidence;
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
