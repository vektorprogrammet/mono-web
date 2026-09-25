# State

Lifecycle: build

## Current

The standalone team-application journey now has [source-bound local acceptance](#team-application-journey).
It replaces the legacy flow at parity with team-scoped reads, leader-only deletion and intake changes, outbox delivery, and a submission rate limit.
The reimbursement journey keeps its [local acceptance](#reimbursement-golden-journey). Production and provider actions remain unauthorized.

Documentation reconciled against source and retained local evidence on 2026-09-24.
Production still uses legacy PHP. Local implementation and acceptance do not authorize replacement.

The operator selected a portable Bun backend with PostgreSQL, not a Cloudflare Worker backend.
Development remains local. Paid infrastructure provisioning is deferred until migration cutover preparation.
The operator selected DigitalOcean as the host on 2026-09-25. Deployment and provisioning stay deferred until cutover preparation.
No cloud provisioning or source-data upload is authorized yet.
The 2024-08-22 private legacy backup remains the working source for import and parity rehearsals. Its schema shape is expected to match current production; its contents are historical, not current.
The native target is PostgreSQL 18, declared once as `engines.postgresql` in the root manifest.
`main` was pushed to `origin` on 2026-09-25, so hosted CI now runs.
The previous Cloudflare development contract is superseded, not accepted. The backend Worker composition and its Alchemy development stage were removed on 2026-09-25.
Its Hyperdrive transport conflicts with the PostgreSQL advisory locks that the native backend uses.
The existing local Bun runtime remains the development path. Provider adapters and deployed acceptance remain unverified.
Production cutover still requires provider proof, migration rehearsal, and rollback acceptance.

The canonical `bun dev` command now starts both frontends and the native Bun backend.
It requires an explicit local PostgreSQL URL and a stable authentication secret.
The existing Turbo tasks own the application processes. PostgreSQL remains a separate prerequisite.
External delivery is disabled; database records and local private files remain persistent.
See [local development](README.md#local-native-development) for configuration and synthetic account provisioning.

Local Chromium acceptance verified homepage rendering, native sign-in, and active and inactive PostgreSQL directory records.
The session and records survived a stack restart. Interruption and a startup port conflict released the owned application listeners.
A missing configuration failed before startup, and a dirty homepage release build remained blocked.
Native form sign-in also passed without JavaScript at both supported dashboard mounts.
The login documents preserve the form Origin without exposing URL paths or query strings in the Referer header.
Acceptance used synthetic data in an isolated local PostgreSQL cluster, not production data or provider services.

The [PR preview workflow](docs/specs/worker-pr-previews.md) implements exact-head frontend builds, deployment, probes, review comments, and cleanup.
These provider actions remain unobserved. Frontend previews do not prove authenticated full-system operation.
The preview specification also requires workspace validation before deployment. The workflow itself does not establish that gate.
Close this local gate before claiming preview completion.

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

The codec passed on Node 24.20.0 and local workerd, including concurrent requests and explicit overload.
The workerd observation belongs to the superseded Worker investigation, not the selected Bun deployment target.
It did not exercise Worker-plus-PostgreSQL authentication or establish Cloudflare isolate limits.
The selected production host still needs credential, connection, memory, and CPU qualification under the real workload.

The native replacement has substantial local functionality. Production still
runs the legacy PHP application.

The earlier runtime architecture observation used revision
`9e07114700ee5c6520d6276f7129d95184937b7c`.
It is not the revision of all subsequent work. See [Evidence boundary](#evidence-boundary) for later scoped acceptance.

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

Organization lifecycle acceptance passed locally on 2026-09-24 with synthetic people and disposable PostgreSQL.
The real dashboard covered appointment creation, revision, suspension, reinstatement, ending, national appointments, and separate account access controls.
Mounted HTTP checks covered current scope on old sessions, replay, conflicting commands, stale revisions, overlapping transactions, and commit-failure rollback.
Disabled accounts lost cookie, sign-in, recovery, human OAuth, and refresh access. Fresh authentication worked after re-enable without reviving old credentials.
Overlapping administrator commands preserved one usable administrator. Scoped ending preserved unrelated appointments, affiliation, placement, credentials, and history.
The acceptance fixes reject blank reasons, return `invalid_grant` for unusable-session refresh, and correct narrow layout and preview landmarks.
These observations do not prove production migration or provider behavior.

Scoped school administration passed local acceptance on 2026-09-24 with synthetic data and disposable PostgreSQL.
The real dashboard covers school creation, contacts, activation, department associations, and weekday capacity by department and semester.
Shared details require authority over every associated department. A scoped leader can maintain only their own capacity plans.
Real HTTP and PostgreSQL checks cover replay, revocation, competing revisions, dependency denial, and atomic rollback with same-request recovery.
The browser also covers stale edits, actual database failure, keyboard submission, pending controls, and retained capacity selection after refresh.
The 390px view has no horizontal page overflow and no automated accessibility violations.
Placement demand and roster commands remain separate and unchanged. These observations do not establish production migration or provider readiness.

Recruitment maintenance passed local browser and HTTP/PostgreSQL acceptance with synthetic data on 2026-09-24.
Global administrators author questionnaires. Scoped department leaders maintain primary and co-interviewers before completion or cancellation.
Assigned questions, answers, schedules, invitations, responses, corrections, and onboarding retain their identities and evidence.
Thirteen grouped checks covered current authority, replay, six overlapping transaction scenarios, and two forced commit failures with same-request recovery.
The browser covered all question kinds, ordering, activation, staffing changes, history, stale drafts, keyboard retry, and pending controls.
Both 390px views had no horizontal overflow or automated accessibility violations after corrections.
Notification checks used the existing local recording adapter, not external delivery. These observations do not establish production or provider readiness.
Scoped mailing recipients passed local browser and HTTP/PostgreSQL acceptance on 2026-09-24.
The read resolves canonical semesters, accepted historical service, active placements, overlapping team appointments, and current Profile contacts.
Current authority and recipient facts share one snapshot. Infrastructure failures cannot become empty or partial success.
The dashboard retains department, semester, and cohort selections and exposes copyable addresses.
This is a recipient read, not subscription administration, mail delivery, or provider synchronization.

Requested interview rebooking passed local acceptance on 2026-09-24 at product revision `8fe59f3e`.
Authorized staff can replace a schedule after the applicant requests a new time. Previous schedules and responses remain immutable.
The populated PostgreSQL upgrade preserved existing records and added migration 63. Exact replay, rollback recovery, and repeated replacement cycles passed.

Forced overlaps covered replacement, cancellation, staffing, applicant responses, and both notification claim paths. Superseded work started no new provider attempt.
The browser covered draft recovery, keyboard submission, reload, old-link denial, fresh-link acceptance, and 390px layouts without horizontal overflow.
Automated accessibility checks found no violations; the conflict dialog had one incomplete check. These checks do not establish full accessibility compliance.

Focused regressions, maintained scheduling and response journeys, type checks, changed-file lint, and generated contract checks passed.
Source-bound evidence is retained outside the repository at `/tmp/vektor-rebooking-acceptance-8fe59f3e/`.
Notification acceptance used the local recording adapter. It does not establish external mail arrival or provider readiness.

Coordinator identity cards passed local acceptance on 2026-09-24 at product revision `de57e160`.
Absence cards identify the absent person through the matching assignment, with a stable-ID fallback when no name exists.
Terminal cards show the deciding actor identifier and actual attendees, not the planned roster. Empty attendance is explicit.

The maintained PostgreSQL and browser journey passed. Independent browser checks covered five absence cards and seven terminal cards across all three outcomes.
Reload, keyboard scope refresh, wrong-scope navigation, and 390px layouts passed. The accessibility scan reported zero violations and zero incomplete checks.

Changed-file lint and dashboard type checks passed. Notification delivery used only an owned loopback capture server.
Source-bound evidence is retained at `/tmp/vektor-coordinator-identities-acceptance-de57e160/`.

The Economy owner query uses shared schemas with `SqlSchema.findAll`.
Settlement HTTP calls the complete `Economy.recordReceiptSettlement` operation.
The service checks authority within the transaction. HTTP retains response receipts and revision preconditions.
Local acceptance covered query privacy, exact replay, forced rollback, same-key retry, and denial after grant revocation.
The omitted-department submission regression is also fixed. See [architecture](docs/architecture.md#domain-services) for the boundary.

## Historical backup rehearsal

The latest historical-backup rehearsal passed at committed source `6b8b1c4b` on schema migration 67.

A local cutover rehearsal used the private 2024-08-22 legacy backup.
The MariaDB source account had SELECT-only grants. A separate PostgreSQL
database received the native import. The driver reconciled 2,893 of
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

The [backup reader](tools/e2e/legacy-source-snapshot.ts) uses six tables when Organization and receipts are not selected:
users, departments, semesters, schools, school-department links, and assistant history.
The cutover imports references, accepted People, selected Organization, historical service, reviewed assignments, and Accounts in one target transaction.
The backup rehearsal explicitly leaves Organization and current assignments unimported.
The [reviewed assignment adapter](tools/e2e/legacy-current-assignment-snapshot.ts) uses the supported Placements import boundary.
It requires snapshot-bound review evidence, accepted Person mappings, and source reference provenance.
The original synthetic assignment path remains restricted.
The original [synthetic receipt adapter](apps/backend/src/receipt/import-snapshot.ts) retains its source and payment-account restrictions.
The [reviewed receipt importer](apps/backend/src/receipt/reviewed-import.ts) runs separately after accepted Person and reference reconciliation.
It binds explicit owner, department, date, account, and private-file evidence through an immutable cohort ledger.
Accounts use authenticated encryption. Replay preserves native edits and original ciphertext, then observes private bytes again.
File promotion failure remains pending and recoverable. Imports create no authority, human audit events, notification work, or settlement evidence.

The [reviewed Organization importer](packages/database/src/organization/reviewed-cohort.ts) uses accepted Person mappings and department provenance.
Every membership needs source-bound review evidence and an explicit interval or exclusion.
Historical appointments and board membership never imply current department or global authority.
Reviewed current leaders receive only native department scope. Exact replay preserves later native edits.

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

Most defined core journeys have local synthetic acceptance. The canonical local development journey is also accepted.
Full migration still requires implementation, operational decisions, current-data reconciliation, provider acceptance, and an authorized cutover.
A working local stack does not close these gates. No production activity or external provider delivery was observed.

### Functional journey automation

The [web-system functional testing plan](docs/web-system-functional-testing.md) protects functional boundary contracts, not client design or usability.
The continuous [golden school-service journey](docs/specs/golden-school-service-journey.md) is accepted locally.
Run `bun run test:golden-school-service` from a clean committed tree with the declared toolchain.

Integrated revision `0fa70ed43ae33cba9e72a7567209ad9b01001551` passed all 13 checkpoints with the Effect CLI and backend Config changes present.
Its receipt is `/tmp/vektor-placements-0096-4zRaLC/receipt.json`.
Separate native sessions, real controls, independent PostgreSQL reads, command receipts, history, and loopback delivery agreed.
Required denials covered wrong scope, insufficient attendance, and a stale terminal command.

Candidate `c5f93b35f1fc241d11af3b23ada65716ebb5fa63` also passed deliberate failure and interruption checks.
Omitted attendance and missing browser evidence each failed with exit 1; active-browser SIGINT produced exit 130 and the matching receipt.
Those receipts are `/tmp/vektor-placements-0096-sYhMpr/receipt.json`, `/tmp/vektor-placements-0096-K04Fq0/receipt.json`, and `/tmp/vektor-placements-0096-ouMCQE/receipt.json`.
Artifact hashes, process exit, and port release were checked independently. Private traces, credentials, and disposable databases were removed.

The [golden CI contract](docs/specs/golden-school-service-ci.md) is implemented and accepted locally.
Combined revision `32ef5875b6223005cfc0a731c0c34f1415af66f7` passed the CI wrapper with both workstreams integrated.
Its retained evidence is `/tmp/vektor-golden-combined-1790289368863`.
The receipt covers all 13 checkpoints. Independent inspection checked source, build bytes, artifact hashes, and the exact 13-file upload set.
Seven recorded processes were absent, and all four recorded ports accepted new listeners.
The final-source [failure and interruption records](docs/specs/golden-school-service-ci.md#local-acceptance-record) remain distinct from this integration run.

Hosted success, failure, cancellation, artifact-service behavior, and repository protection remain unobserved.
The [preserved failure limits](docs/specs/golden-school-service-ci.md#preserved-failure-limits) include an earlier HTTP 503 with an unproven cause.
No retry or product timeout change hides that failure. Local acceptance does not establish hosted execution or real-provider readiness.

Later slices add generated sequences and measured execution scaling.
Existing PGlite database and socket fixtures are the basis for whole-system qualification.
PGlite performance and full native composition remain unmeasured. PostgreSQL server retains concurrency and recovery acceptance.

### Developer documentation and parallel workstreams

The [documentation roadmap](docs/module-developer-documentation.md) separates consumer contracts from implementation explanations.
The [Placements guide](packages/placements/README.md) retains the accepted pilot and its tool-choice record.
The pilot included an independent agent-reader exercise, not an unfamiliar-human usability study.

The [documentation CI gate](packages/placements/README.md#ci-and-retained-artifacts) is integrated locally.
It checks public examples, generates the reference once, and binds output to a clean source revision and exact file inventory.
Retained-artifact acceptance does not regenerate the reference.
Source links identify real repository paths. Hosted URL availability remains unobserved.
Branch revision `3cad903ae076c4dc4a9f6b0f978ddf7d71e2414f` passed generation and retained-artifact acceptance.
Seven regressions passed, including source links, artifact rejection, ignored SIGTERM, and descendants that outlive their leader.
The completed documentation specifications are retired. The guide, source declarations, examples, and executable checks retain their contracts.

The earlier E2E and documentation branches remain available from planning base `c89a5512`.
The Substitutes and documentation-CI branches start from `2804f9d4`. All four branches are integrated locally.

| Workstream       | Local branch                           | Worktree relative to this repository | Accepted guide or contract                                                    |
| ---------------- | -------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| E2E              | `test/golden-journey-ci-0924`          | `../mono-web-e2e`                    | [Golden CI contract](docs/specs/golden-school-service-ci.md)                  |
| Documentation    | `docs/placements-developer-guide-0924` | `../mono-web-docs`                   | [Placements guide](packages/placements/README.md)                             |
| Substitutes      | `feat/substitutes-journey-0925`        | `../mono-web-substitutes-0925`       | [Substitutes guide](packages/domain/src/substitutes/README.md)                |
| Documentation CI | `docs/placements-ci-0925`              | `../mono-web-docs-ci-0925`           | [Retained artifacts](packages/placements/README.md#ci-and-retained-artifacts) |

The [testing roadmap](docs/web-system-functional-testing.md#development-sequence) owns journey sequencing.
The documentation roadmap owns documentation sequencing. Shared paths require an integration handoff.
One heavy job runs at a time. Operator demonstration resources remain outside these workstreams.
No publication, hosted CI execution, repository-protection change, or deployment is claimed.

### Substitutes operational journey

The [Substitutes guide](packages/domain/src/substitutes/README.md) documents the complete service boundary and executable example.
Substitutes owns pool preferences and the canonical application year. Placements retains coverage and actual service outcomes.
The caller retains current authority, transaction ownership, transport preconditions, and response receipts.

Combined revision `29be0ffed4f6d11eac4547e6e0ebb4b39d966414` passed the CI wrapper and all 31 ordered checkpoints.
The retained evidence is `/tmp/vektor-substitutes-final-ci-1790293716196`.
Independent PostgreSQL observations connect pool changes to the eligible application and Person, including assignment conflicts and offer reservations.
The journey distinguishes notification delivery, offer acceptance, coordinator acknowledgement, actual attendance, and occurrence-linked absence closure.
Wrong-recipient and stale commands fail without changing business facts. Failed delivery recovers through the loopback provider.

The parent checked all artifact hashes, the exact 13-file upload inventory, seven stopped processes, and four released ports.
The first combined run rejected unlisted screenshots. The producer no longer writes them into golden evidence; the artifact guard remains unchanged.
The original failure summary remains at `/tmp/vektor-substitutes-combined-ci-1790293430378/ci-summary.json`.
Three isolated service regressions and the public-import example passed. The former test-order failure was reproduced before correction.
Type checks passed for the affected domain, database, backend, dashboard, E2E, and verification packages.
The completed operational specification is retired. This local proof does not establish current-data parity or real-provider acceptance.

### Recruitment and delivery recovery

Combined revision `9965f0c6f77b3dfa518ed6d4020e6152ed92ebf7` passed three serial local acceptance commands on 2026-09-25.

| Command                                                                                | Observed result                                                                                                         | Retained evidence                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `bun run test:golden-recruitment`                                                      | All 19 checkpoints passed, from public application to a fresh volunteer session with the first placement.               | `/tmp/vektor-placements-0096-W2xup1/receipt.json`                 |
| `bun run verify:delivery-recovery`                                                     | All 10 observations passed, including unattended recovery, payload drift, stale claims, interruption, and root failure. | `/tmp/vektor-delivery-recovery-GG5Rm8/evidence.json`              |
| `bun --no-env-file tools/e2e/golden-school-service-ci.mjs <absolute-output-directory>` | The CI wrapper and all 31 school-service checkpoints passed.                                                            | `/tmp/vektor-repaired-final-school-1790299189033/ci-summary.json` |

The volunteer projection returns only active placements for the authenticated Person, department, and semester.
The browser displayed the first placement without coordinator controls. A placement remains separate from a confirmed roster or dated commitment.
All six placement persistence tests passed after correction of a fixture-ID collision.
The parent checked the recruitment and school-service artifact hashes, 32 stopped processes, and 13 released ports across the three runs.
The runners removed their private databases, credential manifests, and browser traces.
The consumer contracts remain in the system document, the Placements guide, and the delivery guide. Both completed specifications are retired.
These synthetic local observations do not establish current-data reconciliation, real-provider behavior, or production readiness.

Earlier integrated runs failed during local Worker startup, before browser acceptance.
Two installed Workerd platform executables contained JavaScript launchers, hard-linked to wrappers that recursively launched the same files.
Restoration from the locked package archives separated the launchers from their native executables. No application source or machine limits changed for this repair.
The original overwrite operation remains unknown. The diagnosis and corrupted launchers remain outside the repository at `/tmp/vektor-workerd-repair-1790299070365`.

### Reimbursement golden journey

Integrated revision `7af9e51d2f03b528fecdfaeaae86cd3f208aba4b` passed serial local acceptance on 2026-09-25.
The runtime used Bun 1.3.10, Node 22.22.0, PostgreSQL 17.11, synthetic people, private local files, and a loopback provider.

| Mode                                                   | Observed result                                           | Retained receipt                                |
| ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------- |
| `bun run test:golden-reimbursement`                    | All 12 primary checkpoints and resource probes passed.    | `/tmp/vektor-reimbursement-EX1Szj/receipt.json` |
| `GOLDEN_REIMBURSEMENT_FAULT=after-submitted`           | Expected exit 1 after submission; cleanup passed.         | `/tmp/vektor-reimbursement-WGVN3O/receipt.json` |
| `GOLDEN_REIMBURSEMENT_FAULT=interrupt-after-submitted` | Expected exit 1; SIGTERM reason retained; cleanup passed. | `/tmp/vektor-reimbursement-yq4xwF/receipt.json` |

Both fault modes use the same root command. They are expected failures, not successful business journeys.
Independent PostgreSQL and private-byte observations bind submission, scoped approval, separate settlement evidence, replay, denials, restart, and unattended recovery.
The fresh owner sees the settlement evidence. Approval remains distinct from payment, and the program executes no payment.
Actual Next and First controls traverse all three queues: owner pages contain 50 and 2 records; approval and settlement pages contain 50 and 1.
The resource corpus preserves 52 claims and recovers all 261 outbox entries. Oversized intake returns 413 without changing business facts.
Concurrent uploads preserve exact opaque bytes when the worker is disabled. The installed Effect multipart parser replaces Bun parsing that lost leading-zero bytes.

The loopback fixture observed one active request. Blocked attempts aborted after 498 and 500 milliseconds, then recovered with unchanged envelopes.
This bounds local client attempts, not work that a remote provider continues after an abort. Retry eligibility remains intact.
Desktop and narrow screenshots were inspected; narrow tables scroll horizontally. Recorded accessibility checks found no serious violations.
The largest sampled aggregate RSS was 3.96 GiB across 32 processes. These are runner-and-descendant samples, not measured peaks or allocation-free guarantees.
The parent verified 31 artifact hashes and inventories, 991 source-file hashes, 107 stopped recorded processes, 12 released ports, and removal of all private directories.

All 55 focused regressions passed. Six affected package type checks passed with non-failing Effect suggestions.
The public-import example and changed-source Oxlint checks passed. Upload regressions also passed under Node 24.20.0 after finite fixture encoding was isolated.
Checks were invoked explicitly; the commit hook reported that Lefthook was unavailable.
The [receipt guide](packages/domain/src/receipt/README.md) owns consumer and maintainer guidance. The completed specification is retired.
Current-data reconciliation, unresolved operational policies, real-provider acceptance, cutover, and rollback remain separate gates.

### Team-application journey

Integrated revision `c9303fab43d1c532c44e7d249450b0b490111f1e` passed serial local acceptance on 2026-09-25.
The runtime used Bun 1.3.13, Node 24.20.0, PostgreSQL 17.11, Chromium, synthetic people, and a loopback provider.
Bun 1.3.13 differs from the `packageManager` pin of 1.3.10.

| Mode                                                      | Observed result                                            | Retained receipt                                          |
| --------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `bun run test:golden-team-application`                    | All 17 checkpoints passed; cleanup verified.               | `/tmp/vektor-golden-team-application-eyx7z1/receipt.json` |
| `GOLDEN_TEAM_APPLICATION_FAULT=after-submitted`           | Expected exit 1 after submission; cleanup verified.        | `/tmp/vektor-golden-team-application-44WEPg/receipt.json` |
| `GOLDEN_TEAM_APPLICATION_FAULT=interrupt-after-submitted` | Expected exit 143 with SIGTERM retained; cleanup verified. | `/tmp/vektor-golden-team-application-AmLSsI/receipt.json` |

Independent PostgreSQL observations bind the public page, form, replay, rejected submissions, staff reads and denials, session revocation, deletion, intake changes, expired deadline, stale revision, provider failure, and unattended recovery.
An independent review of all 24 contract items found them satisfied and reported seven defects; all seven are fixed and covered by the run above.

Open privacy decisions: the legacy form has no consent notice, and applications have no retention purge. Native keeps both gaps at parity.
Import of legacy team applications is a separate reconciliation task. Organization `Team.email` still accepts text that is not a mailbox; open intake requires a deliverable mailbox, but the write boundary should validate it.

### Maintenance found during this work

The native `main` also gained Lefthook hooks, a split of fast checks and long tests in CI, a measured resource ledger (`bun run measure-job`), derived generated artifacts, and typed outbox claim loss.
An ingress regression from `042e808d` had answered `credential.invalid` for absent credentials on every secured route; `b74cda24` restored `credential.missing`, and seven suites that had pinned the regression were corrected.
Migrations 70 and 71 add receipt outbox quarantine and converge upgraded databases with fresh schema checks.
Migration 72 truncates every stored instant to milliseconds, truncates clock defaults, and adds a `<table>_<column>_ms` CHECK to each `timestamptz` column except the Migrator's bookkeeping column. It aborts, with nothing changed, when truncation makes a strict interval CHECK or a membership UNIQUE index collide. The next free migration id is 73.

Instants: the domain `Instant` codec (`DateTime.Utc`), millisecond storage, and a canonical JSON guard against non-plain objects are on `main`. Domain fields still use `Rfc3339InstantSchema`; the authority instant (M2), per-slice cutovers (M3), and deletion of the string helpers (M4) remain.
Receipt keyset cursors still carry microsecond text (`packages/database/src/receipt/cursor.ts`). They stay exact because stored values are milliseconds; M3 moves them to `Instant`.
Parameters bound through raw `pg` `query` calls (the identity and OAuth adapters, `service-principal-grants-live.ts`, and the cohort importers in `packages/database/src` and `packages/placements/src/server/current-assignment-cohort.ts`) and through `sql.in` or `sql.unsafe` are not typed; only the `Database` template rejects a `DateTime` argument.

In progress on separate branches: PostgreSQL 18 and staged-change checks in pre-commit.
Typed endpoint problems, phases 0 and 1: handlers can fail with `Problem<Code>` values that HttpApiBuilder encodes against the endpoint's declared union. Only security middleware declares credential problems. `ProblemBoundaryLive` answers a defect with `internal.error`.
The generated SDK fails with a `Problem`. The dashboard reads it only through `nativeProblemFrom` in `apps/dashboard/app/lib/native-problem.ts`, which accepts nothing but the SDK's own `Problem` value; the homepage reads it through `isProblem` and `problemBody`. Team applications are migrated. Every other group still renders raw problem Responses through `toHttpApiResponse`.
Code that trusts a convention is fixed when a change touches it (see [AGENTS.md](AGENTS.md#construction-over-trust)).
Known instances: hand-written operation ids outside content, dashboard navigation paths, a fixed admissions `retry-after`, fixed ports in older browser runners, and hosted runs of the preview, Alchemy, and SDK publish workflows.
Also: `apps/homepage/src/lib/public-application.ts` lists its problem codes by hand and omits `header.malformed`; the homepage problem mappers (`mapPublicApplicationError`, `publicTeamApplicationPageFailure`, `failedPublicTeamApplication`) still accept a plain problem-shaped object besides the SDK's `Problem`; four operations do not declare the `internal.error` the boundary can answer (`organization.readAppointmentManagement`, `organization.executeLifecycle`, `contact.submitContactMessage`, `admissions.readReturningAssistantOptions`); `apps/backend/src/contact/http.ts` re-checks the server token and answers every rejection as `credential.invalid`.
Operator step after the PostgreSQL 18 change reaches staging: run `docker compose down --remove-orphans` to remove the orphaned `receipt-postgres` container.

### Remaining migration work

| Workstream                      | Remaining deliverable                                                                                                                                                               | Completion gate                                                                                                                                                                 | Authority                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Operational scope               | Resolve the obligations below. Implement required outcomes or define an explicit transition process.                                                                                | Each active core case has a supported journey and a responsible owner. Unresolved policy is not silently waived.                                                                | Product decisions for policy; local implementation for defined contracts.          |
| Real-source import coverage     | Rehearse authorized current data through the combined import boundaries. Define import or handover for pending operational work.                                                    | Each occurrence has an evidenced mapping and disposition. Current assignments and authority need current evidence. Receipts need verified private bytes and ownership evidence. | Local implementation. Current production reads need authorization.                 |
| Current-data reconciliation     | Obtain a consistent current snapshot, private file archive, and external-work inventory. Resolve identity, authority, quarantine, and payment evidence.                             | Rehearse the complete reconciled candidate, not only the historical backup. Verify identity-level accounting and retained private bytes.                                        | Authorized source access and human decisions for ambiguous facts.                  |
| Portable deployment preparation | Select the Bun host, PostgreSQL service, private storage, mail, and required integrations. Configure ingress, secrets, migrations, worker supervision, backups, and failure alerts. | The exact candidate preserves PostgreSQL locking and private-file custody. Required delivery work has an explicit runner and recovery path.                                     | Local preparation now; provider selection and provisioning at cutover preparation. |
| Provider acceptance             | Exercise real authentication, scoped access, private-file writes and reads, required delivery, restart, retry, revocation, and restore.                                             | Observe the actual selected providers. Verify deployment limits and operational recovery. Local capture adapters and frontend previews are not substitutes.                     | Explicit provider and credential authorization.                                    |
| Cutover and retirement          | Reconcile the final delta, fence legacy writers, verify rollback after native writes, and transfer ownership. Retain required archives and retire legacy dependencies.              | One authoritative writer; no unexplained delta, lost pending effect, missing required file, or unresolved active case. Required readers and writers no longer depend on PHP.    | Separate production authority for transfer, rollback, and retirement.              |

The Bun composition already applies database migrations and starts configured background workers.
The obsolete Worker migration and scheduled-handler mismatch is not a requirement to rebuild that runtime.
Deployment acceptance must verify the selected composition and every required delivery path.
PR preview acceptance remains separate tooling work; it does not establish production readiness.

Delivery status and remaining integration:

- The [recruitment worker](apps/backend/src/recruitment/worker.ts) now runs under native Bun lifecycle supervision when its HTTP notification Layer is configured. Local development explicitly disables it. Synthetic PostgreSQL and loopback HTTP acceptance verified retry, stale-claim recovery, retained payloads, interruption, restart, and root failure. Real-provider acceptance remains open.
- Password-reset and receipt delivery now have supervised external Bun workers. Internal ingress and disabled modes do not claim work.
- The [delivery guide](docs/delivery-recovery.md) defines explicit configuration, bounded reset retries, ambiguity quarantine, receipt recovery, and shutdown behavior.
- The committed local recovery command exercises actual Bun processes, disposable PostgreSQL, and loopback delivery. Real-provider acceptance remains open.

The combined synthetic candidate rehearsal passed across the implemented import boundaries.
It binds source evidence across separate SQL and file-custody phases and accounts for unresolved or excluded work.
The next candidate needs authorized current data, reviewed authority and assignments, private receipt bytes, and an inventory of pending work.
Reviewed current-assignment import still needs an authorized current snapshot and evidence from responsible humans.
The historical backup cannot supply current assignments. Historical membership must not become current authority by inference.

### Operational scope decisions

The operator decided the open operational obligations and the parity re-baseline questions on 2026-09-25.
Each decision becomes one design specification under `docs/specs/` before implementation. A decision is scope, not acceptance.

| Area                                     | Decision                                                                                                                                                                                                                                                         | Size            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Semesters (P7)                           | Derive future semesters from the calendar. No manual step.                                                                                                                                                                                                       | S               |
| Accounts for non-applicants (P8)         | Staff invitation that is not bound to an application.                                                                                                                                                                                                            | M               |
| Global administrators (P9)               | Grant and end commands with audit, plus a one-time bootstrap grant at cutover.                                                                                                                                                                                   | S-M             |
| Organization upkeep (P10)                | Revise and deactivate commands with dashboard screens for departments, teams, positions, and fields of study. Evaluate NTNU or DBH (HK-dir) as the source for fields of study.                                                                                   | M               |
| Open recruitment cycle (P11)             | Cut over in a quiet window between cycles; create new periods natively. Openings happen in January and August.                                                                                                                                                   | constrains date |
| Legacy data without an import path (P12) | Default to a retained, access-controlled read-only archive. Import only where an active workflow needs it.                                                                                                                                                       | per cohort      |
| Messages (P3)                            | Implement admission-opening notices with subscription consent and unsubscribe, accept-interview reminders, and staff interview digests. Retire info-meeting notices. Email only; no SMS.                                                                         | M               |
| Team applications (P2)                   | Add a privacy notice to the form and purge applications after a fixed period (period to be set). Import applications that are open at cutover.                                                                                                                   | S-M             |
| Interview no-show (P4)                   | A distinct no-show outcome with evidence, then rebook or close. Staff corrections through an admin-only audited command.                                                                                                                                         | S-M             |
| Service corrections (P5)                 | Name the correction cases and authority, then add supersession commands that keep history.                                                                                                                                                                       | M               |
| Mailing and Google Workspace (P1)        | Native list administration and automated Workspace synchronization.                                                                                                                                                                                              | M-L             |
| Coordinator reports (P6)                 | A read-only archive export at cutover. Build each report when a named consumer exists.                                                                                                                                                                           | S-M each        |
| Public page text and sponsors (P13)      | An editor UI in the dashboard.                                                                                                                                                                                                                                   | M               |
| Legacy features (P14)                    | Keep the team-interest form, in-app feedback, and party/stand screens. Retire Slack notices, the shared file browser, and the changelog. Replace server-side IP geolocation (ipinfo.io) with an optional browser-side location choice; no third-party IP lookup. | varies          |
| Parity registers (P15)                   | Retire the external parity registers. The implementation-agnostic specification and its conformance checks become the parity authority.                                                                                                                          | S               |

The full parity map is retained outside the repository at `/tmp/vektor-parity-rebaseline/parity-map.md` (84 capability rows: 27 evidenced, 16 native without evidence, 9 missing, 17 policy).
The 2024 backup contradicted two earlier "dead" dispositions: 702 admission-opening notices and 18 accept-interview reminders were sent in 2024 by a scheduler outside the repository.

Current-source reconciliation must establish active cases, external schedules, and responsible humans. Source routes and historical backup counts cannot establish current workload.

These priorities are not a requirement to serialize independent preparation:

```text
Defined operational outcomes ---------------+
Real-source adapters -> authorized data ----+--> reconciled candidate
Portable hosting -> authorized provider run +        |
                                                    v
                                  writer fence + final delta + rollback proof
                                                    |
                                                    v
                                  authorized transfer -> verified retirement
```

### Reconciliation prerequisites

- Obtain an authorized consistent current snapshot and its watermark. Browser observations do not substitute for it.
- Reconcile current identity and mailbox ownership. Correct the known invalid login email with verified evidence.
- Resolve unsupported credentials and legacy aliases. Preserve post-import credentials on replay.
- Reconcile active authority separately from Accounts, historical membership, and volunteer affiliation.
- Obtain receipt file bytes and digests. Apply the implemented encrypted account custody with reviewed owner, department, and account evidence.
- Reconcile settlement references separately. A legacy refunded flag is not evidence of payment.
- Inventory external schedules, open cases, and pending notifications. Empty screens do not prove an empty workload.
- Reconcile combined teaching blocks and ambiguous membership groups before imposing legacy uniqueness assumptions.
- Define a final-delta strategy. Exact replay refuses changed source; rerunning the initial importer is not incremental migration.

The earlier authenticated audit observed autumn recruitment in three active chapters and 16 pending claims across eight owners.
Those observations are historical, not current counts or a consistent source snapshot.

Recruitment keeps recommendation, invitation, account claim, affiliation, and placement separate.
A separate admission decision needs a defined owner and lifecycle before implementation.

Changelogs, articles, generic events and surveys, certificates, and nonessential statistics are not default cutover gates.
An active core obligation cannot disappear under that exclusion. Retained data still needs an explicit archive or migration disposition.

### Architecture work

Close remaining service boundaries through a concrete operational journey, not a repository-wide framework rewrite.
Placements now exposes complete commands and queries through its service contract.
Substitutes now exposes complete commands and pool queries through its [service boundary](packages/domain/src/substitutes/README.md).
Use the [Economy boundary](docs/architecture.md#domain-services) as the precedent for a complete command and schema-derived query.
No XState, EventLog, or PersistedQueue adoption follows from dependency compatibility.
Keep acceptance obligations for a replacement in [AGENTS.md](AGENTS.md#boundary-practices).

For each new journey, create one active contract under `docs/specs/`.
After acceptance, remove that contract once durable intent, code, and observable checks cover it.

## Production gates

Production replacement is not authorized or rehearsed.

Before cutover:

- close required operational outcomes or obtain an approved, owned transition process;
- reconcile identities, credentials, authority, recruitment, placements, claims, private files, and pending effects against the current source;
- resolve or explicitly disposition each quarantine, unsupported credential, alias, and missing evidence item;
- verify the selected Bun deployment, PostgreSQL locks, required delivery providers, private storage, and separately authorized settlement evidence;
- qualify sustained operation, worker supervision, failure alerts, backup, restore, and credential resource limits;
- choose and rehearse a final-delta method; exact replay of the initial importer is not incremental migration;
- fence legacy writers and external schedules before native ownership starts;
- verify rollback after native writes, including native-only facts and pending external effects;
- obtain explicit operator authority for production transfer and each external or destructive action.

After transfer, verify that all required readers and writers use the native system.
Retire PHP and obsolete provider composition only after those dependencies and required archives have an accepted disposition.

Team membership must never stand in for volunteer affiliation. A recommendation
must never stand in for an explicit coordinator outcome.

## Evidence boundary

Code and generated contracts describe implementation. Checks prove only the behavior exercised on their exact source artifact.
No single local result proves replacement-wide or production readiness.

| Retained acceptance            | Source snapshot                            | Observed scope                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency and quality upgrade | `6d74709edfcacedc91263f39bcc9003ca5739c80` | 14 workspace type/build prerequisites, 194 backend tests, five SDK tests, five domain properties, lint and formatting. Native Schools browser journey used synthetic PostgreSQL state.                                                              |
| Economy boundary               | `e3177b24aefc53e8b53b0803dd6cf2e92b0bae14` | Nine affected type/build prerequisites and 53 focused tests. Real Chromium, native authentication, generated SDK, disposable PostgreSQL, and a loopback notification sink. Query, replay, rollback, retry, revocation, and settlement observations. |

The first two records refer to disposable snapshot commits, not commits in the operator worktree.
Organization runtime checks used committed source: `596f9284` for credentials and transactions, then `b08d87e3` for the corrected preview landmark.
The latter commit changed only preview markup and removed implementation-pinning preview tests.
The maintained runner passed at `4ac57e0b` after its receipt queries adopted the canonical HTTP command identity.
Eleven affected type/build prerequisites, 19 focused tests, the browser regression, and generated OpenAPI checks passed.
The final credential probe also exercised successful refresh before disable and after fresh authentication following re-enable.
The organization record is `/tmp/vektor-organization-acceptance-b08d87e3/acceptance.json`.
The earlier records are `/tmp/vektor-upgrade-acceptance-cuFpfJ/acceptance.json` and `/tmp/vektor-economy-acceptance-FeFz12/acceptance.json`.
School administration used committed source `34d9109a`; the earlier full browser journey used `0d466283` before the capacity-selection fix.
Fourteen grouped HTTP/PostgreSQL checks, the maintained Chromium/PostgreSQL runner, 24 focused tests, and 11 affected type/build prerequisites passed.
The final browser run covered retained capacity selection, scoped controls, real database failure, and same-request recovery.
The school record is `/tmp/vektor-school-acceptance-34d9109a/acceptance.json`, with a checksummed archive of the committed source.
Recruitment maintenance HTTP/PostgreSQL acceptance used committed source `79fd4e28`.
The browser exercised questionnaire and staffing changes at `76a2dbbd` and `01c23bdd`; final mutation and reload checks used `74b037e2`.
The maintained assignment runner passed at `8485e6e3`; scheduling and conduct passed at `ed0246cb`.
Thirty-nine focused tests, eleven affected type/build prerequisites, and generated API checks passed at `ed0246cb`.
The record is `/tmp/vektor-recruitment-acceptance-79fd4e28/acceptance.json`. It distinguishes notification-adapter recording from external provider proof.
Scoped mailing-recipient acceptance used committed source `b082e628`.
The baseline reproduced missing assistant recipients, ignored semester filtering, and boundary-only appointment inclusion.
Twenty-six mounted HTTP/PostgreSQL checks covered recipients, scope, current-session revocation, reference errors, and infrastructure failure recovery.
Four maintained Chromium cases, seventeen focused tests, eleven affected type/build tasks, and generated API checks passed.
The final browser covered a current leader with an ended administrator grant, keyboard submission, retained selection, scope denial, and clipboard copying.
The 390px mailing surface had no horizontal overflow or automated accessibility violations.
The record is `/tmp/vektor-mailing-acceptance-b082e628/acceptance.json`, with a checksummed archive of the accepted source.
Local native development acceptance used committed source `47305540`.
The final Chromium journey followed the homepage login link, submitted the native form without JavaScript, and read the PostgreSQL directory.
The retained record also covers both dashboard mounts, restart persistence, missing configuration, port-conflict cleanup, and dirty release-build rejection.
Nineteen focused homepage tests passed. The affected type-check graph completed twelve tasks, including ten cached results.
The record is `/tmp/vektor-local-dev-acceptance-eRSdyG/acceptance.json`.
Native command ownership has scoped local acceptance. Placements now owns portable contracts and its private PostgreSQL implementation in one package.
HTTP adapters call complete Placements and Recruitment commands. Cross-application proofs now live in `tools/verification`.
Placement API and Chromium acceptance used `dbaad29e`; it covered concurrency, replay, coverage, and all three terminal service outcomes.
Schools rendered native records through successful same-origin reads. The cancellation form retained focus through outcome changes.
Compiled Recruitment and relocated completion-delivery acceptance passed at `2bd1b758`, including browser persistence and owned-process cleanup.
The receipt rehearsal passed at `b0eea924`, including import quarantine, replay, delivery recovery, browser reopening, and database/file restore.
Worker lifecycle acceptance used `4d58d4cd`; local disablement, claim recovery, interruption, retry, and root failure passed.
Fifteen affected type/build tasks, 47 focused tests, generated-contract checks, scoped lint, and formatting passed.
Nine prohibited imports were rejected. Placements HTTP no longer imports its ten former database helpers; Recruitment no longer exposes twelve wildcard export groups.
The record is `/tmp/vektor-command-ownership-P0ppoX/acceptance.json`, with a checksummed source archive and scope-specific receipts.
No provider, production data, or external delivery was exercised. Owned runtime resources and integrated worktrees were removed.
Reviewed current-assignment acceptance used committed source `5d4001e8` and schema migration 65.
Real MariaDB and PostgreSQL exercised the SELECT-only reader, operator CLI, and supported Placements importer with synthetic source records.
Nine reviewed assignments produced three placements and two affiliations; six assignments were quarantined. Nineteen refusal cases passed.
Snapshot-bound Person identity, valid cross-snapshot replay, per-row relationship quarantine, concurrent import, and whole-cutover rollback passed.
The original Person and synthetic assignment rehearsals passed at the same revision. Twenty-three focused tests and sixteen affected type-check tasks also passed.
The record is `/tmp/vektor-reviewed-assignment-release-0924/acceptance.json`, with a checksummed source archive.
The historical backup rehearsal was not rerun. No production source, provider, deployment, or cutover was exercised.

Reviewed Organization acceptance used committed source `bd2fcbc1` and schema migration 66.
Real MariaDB and PostgreSQL exercised eleven source tables, the operator CLI, and the native authority resolver with synthetic records.
Nineteen occurrences produced nine accepted appointments, nine quarantines, and one explicit exclusion. Fifteen refusal cases passed.
Exact Person binding, reviewed intervals, department-only leadership, native edits, concurrent import, append-only evidence, and whole-cutover rollback passed.

The existing reviewed-assignment and Person rehearsals passed at the same source revision. Sixty-three focused tests and sixteen affected type-check tasks passed.
The record is `/tmp/vektor-org-accepted-0924/acceptance.json`, with a checksummed source archive.
The historical backup and previous Organization browser rehearsal were not rerun. No production source, provider, deployment, or cutover was exercised.

Reviewed receipt acceptance used committed source `05f05974` and schema migration 67.
Real MariaDB and PostgreSQL exercised the SELECT-only reader, receipt CLI, account encryption, and private-file custody with invented records.
Twenty-seven occurrences produced three accepted claims, twenty-three quarantines, and one explicit exclusion. Thirty-one acceptance checks passed.
The checks covered source ownership, cross-snapshot replay, native edits, concurrent import, rollback, promotion failure, and logical database/file restore.
Legacy refunded claims produced approval only. No grants, human audit events, notifications, or settlement evidence appeared.

The original synthetic receipt, reviewed Organization, and reviewed-assignment rehearsals passed at the same source revision.
Twenty-three focused receipt tests and sixteen affected type-check tasks passed.
The record is `/tmp/vektor-receipt-accepted-0924/acceptance.json`, with a checksummed source archive.
No historical receipt data, production source, external provider, deployment, or cutover was exercised. Restore acceptance does not simulate power loss.

Combined candidate acceptance used committed source `6b8b1c4b` and schema migration 67.
Seven combined checks and 77 native boundary checks passed through real MariaDB, PostgreSQL, authentication, and private-file custody.
Four imported People and Accounts shared identities with five appointments, one current assignment, one historical-service row, and two receipts.
Each cohort retained quarantine evidence. Organization and receipt reviews each excluded one occurrence.
A deliberate later receipt edit remained pending instead of being overwritten. Successful checks did not imply candidate completeness.

Source-change rejection, whole-cutover rollback, process interruption, file recovery, replay, and logical database/file restore passed.
The restore retained the authentication secret and payment key. Imported identifiers passed Organization HTTP through canonical domain decoding.
Six focused Organization tests passed. Sixteen affected type-check tasks succeeded, including fourteen cached tasks. Scoped lint and formatting passed.

The separate historical-backup rehearsal passed at the same source revision. Its counts appear in [Historical backup rehearsal](#historical-backup-rehearsal).
Current Organization authority, current assignments, receipt bytes, mailbox ownership, and settlement evidence remain unresolved by that backup.
The record is `/tmp/vektor-candidate-accepted-0924/acceptance.json`, with synthetic and historical reports and a checksummed source archive.
Owned runtime databases and private temporary data were removed. No provider, production source, deployment, or cutover was exercised.
Native acceptance used Request/Response boundaries without a network listener or browser. Restore acceptance does not simulate power loss.

Each directory retains source provenance and evidence outside the product repository. Temporary storage is not a permanent archive.
No repository-wide all-packages test pass or deployed provider journey is claimed.

The documentation refresh inspected source and retained metadata. The subsequent organization acceptance exercised local runtime boundaries only.
Historical tracked material remains in Git history. Earlier unique umbrella documentation was preserved in a local checksummed archive before removal.
