# State

Lifecycle: build

This file records current state only. Remove an item when it is resolved. Git keeps the history.

## Current

Production uses the legacy PHP application. Production replacement is not authorized or rehearsed.
The legacy source is in the [vektorprogrammet](https://github.com/vektorprogrammet/vektorprogrammet) repository; the former `apps/server` continues there as branch `modernize/mono-web-server` (`908368a8`), with the same tree (`023b85bd`) as mono-web `b6438cb2`. The removal commit is `ea124143`; its parent `1277be8b` still contains `apps/server`.
Local implementation and acceptance do not authorize production, provider, or source-data actions.

Operator decisions:

- The backend is a portable Bun process with PostgreSQL, not a Cloudflare Worker.
- DigitalOcean is the selected host (2026-09-25). Provisioning and deployment stay deferred until cutover preparation.
- No cloud provisioning or source-data upload is authorized.
- The private 2024-08-22 legacy backup is the working source for import rehearsals.
  Its schema shape is expected to match current production. Its contents are historical, not current.
- The native target is PostgreSQL 17 or 18 (default 18); hosted Supabase runs 17 (operator decision, 2026-09-25).
  The root manifest declares the set once as `engines.postgresql`; `VEKTOR_POSTGRES_MAJOR` selects a major per environment.
- `main` is pushed to `origin` (2026-09-25), so hosted CI runs.
  The SDK is not published (operator decision, 2026-09-25). `@vektorprogrammet/sdk` is private; the Release SDK workflow and Changesets are removed.

Development stays local. `bun dev` starts both frontends and the native Bun backend; PostgreSQL is a separate prerequisite.
See [local development](README.md#local-native-development). External delivery is disabled in local development.

## Evidence boundary

Each row is the latest local acceptance of its area. All runs used synthetic or historical data, disposable PostgreSQL, and local or loopback delivery.
No row proves production data, a real provider, a deployment, or cutover. Evidence lives outside the repository; temporary storage is not an archive.
"Probes" means disposable checks retained in the evidence directory; no maintained root command replays them.

| Area                                               | Revision                  | Command                                                                                                            | Evidence                                                                  | Unverified boundary                                           |
| -------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Local development and native sign-in               | `47305540`                | `bun dev` and probes                                                                                               | `/tmp/vektor-local-dev-acceptance-eRSdyG/acceptance.json`                 | Provider services                                             |
| Organization lifecycle and account access          | `b08d87e3`                | Probes                                                                                                             | `/tmp/vektor-organization-acceptance-b08d87e3/acceptance.json`            | Production migration, providers                               |
| School administration and capacity                 | `34d9109a`                | Probes                                                                                                             | `/tmp/vektor-school-acceptance-34d9109a/acceptance.json`                  | Production migration, providers                               |
| Recruitment maintenance                            | `79fd4e28` to `ed0246cb`  | Probes                                                                                                             | `/tmp/vektor-recruitment-acceptance-79fd4e28/acceptance.json`             | External mail delivery                                        |
| Interview rebooking                                | `8fe59f3e`                | Probes                                                                                                             | `/tmp/vektor-rebooking-acceptance-8fe59f3e/`                              | External mail delivery; full accessibility compliance         |
| Scoped mailing recipients                          | `b082e628`                | Probes                                                                                                             | `/tmp/vektor-mailing-acceptance-b082e628/acceptance.json`                 | Subscription administration, delivery, provider sync          |
| Coordinator identity cards                         | `de57e160`                | Probes                                                                                                             | `/tmp/vektor-coordinator-identities-acceptance-de57e160/`                 | External delivery                                             |
| Economy query and settlement                       | `e3177b24` (snapshot)     | Probes                                                                                                             | `/tmp/vektor-economy-acceptance-FeFz12/acceptance.json`                   | Real payment, providers                                       |
| Golden school service, with substitutes (31 steps) | `49f38ccc` (hosted CI)    | `Tests` workflow, job `golden-school-service`                                                                      | GitHub Actions run `36118163912`                                          | Repository protection, real providers                         |
| Golden recruitment (19 steps)                      | `9965f0c6`                | `bun run test:golden-recruitment`                                                                                  | `/tmp/vektor-placements-0096-W2xup1/receipt.json`                         | Real providers                                                |
| Unattended delivery recovery (10 observations)     | `9965f0c6`                | `bun run verify:delivery-recovery`                                                                                 | `/tmp/vektor-delivery-recovery-GG5Rm8/evidence.json`                      | Real providers                                                |
| Golden reimbursement (12 steps, 2 fault modes)     | `7af9e51d`                | `bun run test:golden-reimbursement`, `GOLDEN_REIMBURSEMENT_FAULT=after-submitted\|interrupt-after-submitted`       | `/tmp/vektor-reimbursement-{EX1Szj,WGVN3O,yq4xwF}/receipt.json`           | Real payment, remote provider after abort                     |
| Golden team application (17 steps, 2 fault modes)  | `c9303fab`                | `bun run test:golden-team-application`, `GOLDEN_TEAM_APPLICATION_FAULT=after-submitted\|interrupt-after-submitted` | `/tmp/vektor-golden-team-application-{eyx7z1,44WEPg,AmLSsI}/receipt.json` | Real providers                                                |
| Placements documentation CI                        | `49f38ccc` (hosted CI)    | `bun run --cwd packages/placements docs:ci <dir>`                                                                  | GitHub Actions run `36118163912`                                          | Source URL availability, repository protection                |
| Reviewed current-assignment import                 | `5d4001e8` (migration 65) | `bun run rehearsal:legacy-current-assignment`                                                                      | `/tmp/vektor-reviewed-assignment-release-0924/acceptance.json`            | Current source data, human review                             |
| Reviewed Organization import                       | `bd2fcbc1` (migration 66) | `bun run rehearsal:legacy-organization`                                                                            | `/tmp/vektor-org-accepted-0924/acceptance.json`                           | Current source data, human review                             |
| Reviewed receipt import                            | `05f05974` (migration 67) | `bun run rehearsal:legacy-receipt`                                                                                 | `/tmp/vektor-receipt-accepted-0924/acceptance.json`                       | Historical receipt files; power loss during restore           |
| Combined candidate and historical backup           | `6b8b1c4b` (migration 67) | `bun run rehearsal:legacy-candidate` and the private backup run                                                    | `/tmp/vektor-candidate-accepted-0924/acceptance.json`                     | Current authority, assignments, receipt bytes, mailbox owners |

`e3177b24` is a disposable snapshot commit, not a commit on `main`.
The golden fault modes are expected failures that prove cleanup, not successful journeys.
Other implemented journeys have local observations without a retained record: identity, OAuth, password recovery, profile, directory, team interest,
admission periods, public applications, interview scheduling and conduct, onboarding, placement rosters, content, contact, social events, and school surveys.

### Historical backup rehearsal

The rehearsal used the private 2024-08-22 backup through a SELECT-only MariaDB account and a separate PostgreSQL target.
The [backup reader](tools/e2e/legacy-source-snapshot.ts) reads users, departments, semesters, schools, school-department links, and assistant history.
It left Organization and current assignments unimported. Its census facts drive the import decisions:

- People: 2,893 of 2,923 reconciled; 30 quarantined.
- References: 5 departments, 28 semesters, 44 schools, 43 school-department links.
- Assistant service: 1,690 of 1,815 rows imported; 125 quarantined (105 invalid, 10 unmapped, 10 duplicate targets). 1,681 distinct historical affiliations.
- Accounts: 1,482 supported hashes imported unchanged; 1,410 passwordless identities without credentials, sessions, or mail; 31 quarantined (13 inactive, 5 invalid, 13 without an accepted Person).
- One accepted Person has an account email without a domain dot. The login schema rejects it, so that Person has no login identity.
  Correct the address with verified evidence before cutover. Do not relax login validation or invent an address.
- Assignments: 0 for 2024 Høst; 92 for 2024 Vår, historical when the backup was made. The backup cannot prove current placements.
- Receipts: 2,206 rows (2,169 refunded, 32 rejected, 5 pending). 2,142 owners resolve to accepted People; 64 owners are inactive.
  The backup has SQL only, not the 2,206 files. Account numbers are plaintext; native receipts require encrypted account custody.
  A legacy refunded status proves neither payment nor native settlement. Do not import file-less receipts or mark them settled.
- Messages: 702 admission-opening notices and 18 accept-interview reminders were sent in 2024 by a scheduler outside the repository.

Legacy usernames and company emails are not supported as login aliases. No import infers current affiliation, placement, or authority from history.

## Known gaps

Fix an instance when a change touches it (see [AGENTS.md](AGENTS.md#construction-over-trust)).

- Typed endpoint problems: every backend group fails with declared `Problem` values; the raw problem path is gone.
  Defects found and left open: `packages/database/src/content/postgres.ts` never recognizes a department foreign-key violation (503, not 422);
  `Schema.Struct({})` request bodies accept excess members; a sanitizer rejection of article HTML answers 500; a lost serialization race
  inside the survey, content, school, or recruitment-maintenance domain answers 503, not 409 (survey and content errors keep only the cause's text);
  the dashboard maps a command's `transaction.conflict` to its unknown-error branch (`receipt-view.ts`, `__foldkit.surveys.ts`).
- `apps/homepage/src/lib/public-application.ts` lists its problem codes by hand and omits `header.malformed`.
  The homepage problem mappers (`mapPublicApplicationError`, `publicTeamApplicationPageFailure`, `failedPublicTeamApplication`) still accept a plain problem-shaped object besides the SDK's `Problem`; the dashboard reads problems only through `nativeProblemFrom`.
- Instants: domain fields still use `Rfc3339InstantSchema`, not `Instant` (`packages/domain/src/time.ts`).
  The authority instant (M2), per-slice cutovers (M3), and deletion of the string helpers such as `compareRfc3339Instants` (M4) remain.
- Receipt keyset cursors carry microsecond text (`packages/database/src/receipt/cursor.ts`). They stay exact because storage is millisecond; M3 moves them to `Instant`.
- Parameters bound through raw `pg` `query` calls, `sql.in`, or `sql.unsafe` are not typed. Only the `Database` template rejects a `DateTime` argument.
  Raw calls include the identity and OAuth adapters, `packages/database/src/service-principal-grants-live.ts`, the cohort importers in `packages/database/src`,
  and `packages/placements/src/server/current-assignment-cohort.ts`.
- Raw `pg` files still write advisory-lock SQL and copy lock keys by hand. The exceptions of `anti-slop/no-raw-advisory-lock-sql` in `oxlint.config.ts` list them;
  each leaves that list when it moves to Effect SQL and `lockAdvisory`. The rule does not cover `tools/`, where `tools/e2e/legacy-cutover-references.ts`
  and `tools/verification/organization-import-rehearsal.test.ts` also write advisory-lock SQL.
- The raw `pg` identity adapters `packages/database/src/auth-engine.ts` and `packages/database/src/password-recovery.ts` read `NOT access_disabled` by hand
  instead of `accountAccessEnabled` in `packages/database/src/identity-access.ts`.
- `Team.email` (`packages/domain/src/organization/schema.ts`) accepts text that is not a mailbox. Open team intake requires a deliverable mailbox; the write boundary does not check it.
- Hand-written operation ids outside content, hand-written dashboard navigation paths, a fixed admissions `retry-after`, and fixed ports in older browser runners.
- PR previews (operator decision, 2026-09-25): Cloudflare Worker Previews of the homepage and dashboard only, as `vektor-preview-homepage` and `vektor-preview-dashboard`, which `wrangler preview` creates on first use ([contract](docs/specs/worker-pr-previews.md)).
  They need the `CLOUDFLARE_API_TOKEN` repository secret (operator step); no hosted run has deployed one yet. They have no backend, so pages that read the API show the unavailable state.
  A native backend preview host is the planned follow-up: full-stack per-PR previews on DigitalOcean App Platform (`digitalocean/app_action` with `deploy_pr_preview`) so previews rehearse the production platform.
- Pending operator teardown: the retired `dev-main` Alchemy stage (vektor.phibkro.org Workers and the workstation's `vektor-preview-*` systemd units); its code is deleted from this repository.
- Hosted `Tests` run `36191536836` passed every job at `6c812703`, including the PostgreSQL 17 lane.
- The golden CI gate once failed at `ae5928fe` after a dashboard GET returned HTTP 503; a later diagnostic run passed and the cause is unproven. Evidence: `/tmp/golden-ci-success-ae5928fe`.
- `devenv shell` is the toolchain entry: Bun, Node, PostgreSQL, openssl, Chromium, and prek Git hooks; `--profile legacy-data` adds MariaDB and the PHP 8.4 CLI for the legacy data rehearsals. CI runs in the same shell; its hosted cost is unmeasured.

## Next

Full migration needs implementation, operational decisions, current-data reconciliation, provider acceptance, and an authorized cutover.
The [testing roadmap](docs/web-system-functional-testing.md#development-sequence) owns journey sequencing: generated sequences and measured execution scaling come next.
PGlite performance and full native composition are unmeasured.

### Operator steps pending

- Staging deploys run `docker compose down` without `--remove-orphans`. After the PostgreSQL 18 change reaches the `staging` branch,
  run `docker compose down --remove-orphans` once on the staging host to remove the orphaned `receipt-postgres` container.

### Remaining migration work

| Workstream                      | Remaining deliverable                                                                                                                                          | Completion gate                                                                                                                                                                 | Authority                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Operational scope               | Implement the [scope decisions](#operational-scope-decisions) or define an explicit transition process.                                                        | Each active core case has a supported journey and a responsible owner. Unresolved policy is not silently waived.                                                                | Product decisions for policy; local implementation for defined contracts. |
| Real-source import coverage     | Rehearse authorized current data through the combined import boundaries. Define import or handover for pending operational work.                               | Each occurrence has an evidenced mapping and disposition. Current assignments and authority need current evidence. Receipts need verified private bytes and ownership evidence. | Local implementation. Current production reads need authorization.        |
| Current-data reconciliation     | Obtain a consistent current snapshot, private file archive, and external-work inventory. Resolve identity, authority, quarantine, and payment evidence.        | Rehearse the complete reconciled candidate, not only the historical backup. Verify identity-level accounting and retained private bytes.                                        | Authorized source access and human decisions for ambiguous facts.         |
| Portable deployment preparation | On DigitalOcean, select the PostgreSQL service, private storage, mail, and integrations. Configure ingress, secrets, migrations, workers, backups, and alerts. | The exact candidate preserves PostgreSQL locking and private-file custody. Required delivery work has an explicit runner and recovery path.                                     | Local preparation now; provisioning at cutover preparation.               |
| Provider acceptance             | Exercise real authentication, scoped access, private-file writes and reads, required delivery, restart, retry, revocation, and restore.                        | Observe the selected providers. Verify deployment limits and recovery. Local capture adapters and frontend previews are not substitutes.                                        | Explicit provider and credential authorization.                           |
| Cutover and retirement          | Reconcile the final delta, fence legacy writers, verify rollback after native writes, and transfer ownership. Retain required archives and retire legacy code. | One authoritative writer; no unexplained delta, lost pending effect, missing required file, or unresolved active case. Required readers and writers no longer depend on PHP.    | Separate production authority for transfer, rollback, and retirement.     |

The recruitment, password-reset, and receipt delivery workers run under Bun supervision. The [delivery guide](docs/delivery-recovery.md) defines their configuration and recovery.
The Bun composition applies migrations and starts configured workers. Deployment acceptance must verify that composition and every required delivery path.

### Operational scope decisions

The operator decided these on 2026-09-25. Each becomes one design specification under `docs/specs/` before implementation. A decision is scope, not acceptance.

| Area                                     | Decision                                                                                                                                                                                                                                                                                                                                                | Size            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Semesters (P7)                           | Derive future semesters from the calendar. No manual step.                                                                                                                                                                                                                                                                                              | S               |
| Accounts for non-applicants (P8)         | Staff invitation that is not bound to an application.                                                                                                                                                                                                                                                                                                   | M               |
| Global administrators (P9)               | Grant and end commands with audit, plus a one-time bootstrap grant at cutover.                                                                                                                                                                                                                                                                          | S-M             |
| Organization upkeep (P10)                | Revise and deactivate commands with dashboard screens for departments, teams, positions, and fields of study. Evaluate NTNU or DBH (HK-dir) as the source for fields of study.                                                                                                                                                                          | M               |
| Open recruitment cycle (P11)             | Cut over in a quiet window between cycles; create new periods natively. Openings happen in January and August.                                                                                                                                                                                                                                          | constrains date |
| Legacy data without an import path (P12) | Default to a retained, access-controlled read-only archive. Import only where an active workflow needs it.                                                                                                                                                                                                                                              | per cohort      |
| Messages (P3)                            | Implement admission-opening notices with subscription consent and unsubscribe, accept-interview reminders, and staff interview digests. Retire info-meeting notices. Email only; no SMS.                                                                                                                                                                | M               |
| Team applications (P2)                   | Add a privacy notice to the form and purge applications after a fixed period (period to be set). Import applications that are open at cutover.                                                                                                                                                                                                          | S-M             |
| Interview no-show (P4)                   | A distinct no-show outcome with evidence, then rebook or close. Staff corrections through an admin-only audited command.                                                                                                                                                                                                                                | S-M             |
| Service corrections (P5)                 | Name the correction cases and authority, then add supersession commands that keep history.                                                                                                                                                                                                                                                              | M               |
| Mailing and Google Workspace (P1)        | Native list administration and automated Workspace synchronization.                                                                                                                                                                                                                                                                                     | M-L             |
| Coordinator reports (P6)                 | A read-only archive export at cutover. Build each report when a named consumer exists.                                                                                                                                                                                                                                                                  | S-M each        |
| Public page text and sponsors (P13)      | An editor UI in the dashboard.                                                                                                                                                                                                                                                                                                                          | M               |
| Legacy features (P14)                    | Keep the team-interest form, in-app feedback, and party/stand screens. Retire Slack notices, the shared file browser, and the changelog. Replace server-side IP geolocation (ipinfo.io) with an optional browser-side location choice; no third-party IP lookup.                                                                                        | varies          |
| Parity registers (P15)                   | Retire the external parity registers. The implementation-agnostic specification and its conformance checks become the parity authority. Done 2026-09-25: `tools/parity` is deleted; its source-safety rules run as `tools/source-safety`.                                                                                                               | S               |
| Team intake owner (D3)                   | TeamApplications owns intake (open/closed, deadline) with its own revision; it moves off Organization's team row.                                                                                                                                                                                                                                       | M               |
| Year of study owner (AD7)                | Admissions owns the application's year of study; Substitutes reads it.                                                                                                                                                                                                                                                                                  | S               |
| Positions (D10)                          | Positions become managed reference data; appointment free-text titles are mapped once at import.                                                                                                                                                                                                                                                        | M               |
| Onboarding (D7)                          | Two aggregates: Recruitment owns the onboarding invitation; Identity owns the one-time account claim.                                                                                                                                                                                                                                                   | M               |
| Domain event payloads                    | Identifiers plus closed non-personal values (booleans, instants, revisions, enumerated states). No names, contact details, or free text.                                                                                                                                                                                                                | —               |
| Credentials (O8-1, O8-2)                 | Exactly one credential per request; a session cookie with a bearer is rejected. The onboarding claim token is a single-use requirement bound to its target, not a second principal.                                                                                                                                                                     | S               |
| Grants and roles (O8-3)                  | Ending a global-administrator grant never changes role authority, uniformly.                                                                                                                                                                                                                                                                            | S               |
| Boards (O8-4)                            | Styret (department scope) and Hovedstyret (national scope) are units like teams; board positions carry capabilities with that reach. A seat implies no global-administrator grant.                                                                                                                                                                      | M               |
| Authority model (O8-5 to O8-10)          | Add RosterMember, OfferCandidate, and Applicant role types; scheduling membership is a named requirement; derive the pool holder now and key the pool by Person at the Substitutes cutover; payment destinations become Economy data; contact stays anonymous with its quota; school contacts stay data.                                                | M               |
| Reach and delegation (O8-11 to O8-14)    | Only Styret positions reach their department; ordinary team leaders act within their team. Department work for a team is an explicit, time-bounded delegation, managed by Styret leadership in its department and by Hovedstyret or a global administrator for national teams. The global-administrator grant keeps its organisational actions for now. | M               |
| Package layout                           | Layer-first packages with CML context folders in every layer. Placements folds back into `packages/domain` and `packages/database`; a context's service owns complete commands everywhere.                                                                                                                                                              | M               |
| Substitutes scope (interview)            | Substitute is an admission outcome: admitted but unplaced applicants are on call. Record absences and who covered each lesson date; coordination stays in Slack. Remove the offer and dispatch flow.                                                                                                                                                    | M               |
| Placement scheduling (interview)         | Port the legacy automated scheduler (weekday availability, bolk, school capacity) as a pure domain function that drafts placements; Skolekoordinering adjusts the draft manually.                                                                                                                                                                       | M               |
| Certificates (operations scan)           | In scope. Skolekoordinering records days served per assistant at semester end; Styret generates certificates for its department.                                                                                                                                                                                                                        | M               |
| Surveys (operations scan)                | Stay in Google Forms. The system supplies the data Evaluering needs (assistants per bolk, schools) instead of hosting surveys.                                                                                                                                                                                                                          | S               |

The parity map is at `/tmp/vektor-parity-rebaseline/parity-map.md` (84 capability rows: 27 evidenced, 16 native without evidence, 9 missing, 17 policy).
Changelogs, articles, generic events and surveys, certificates, and nonessential statistics are not default cutover gates.
An active core obligation cannot disappear under that exclusion. Retained data still needs an explicit archive or migration disposition.
Recruitment keeps recommendation, invitation, account claim, affiliation, and placement separate. A separate admission decision needs an owner and lifecycle first.

### Reconciliation prerequisites

- Obtain an authorized consistent current snapshot and its watermark. Browser observations do not substitute for it.
- Reconcile current identity and mailbox ownership. Correct the known invalid login email with verified evidence.
- Resolve unsupported credentials and legacy aliases. Preserve post-import credentials on replay.
- Reconcile active authority separately from Accounts, historical membership, and volunteer affiliation.
- Obtain receipt file bytes and digests. Apply encrypted account custody with reviewed owner, department, and account evidence.
- Reconcile settlement references separately. A legacy refunded flag is not evidence of payment.
- Inventory external schedules, open cases, active chapters, and pending notifications. Empty screens do not prove an empty workload.
- Reconcile combined teaching blocks and ambiguous membership groups before imposing legacy uniqueness assumptions.
- Define a final-delta strategy. Exact replay refuses changed source; rerunning the initial importer is not incremental migration.

### Architecture work

Close remaining service boundaries through a concrete operational journey, not a repository-wide rewrite.
The [Economy boundary](docs/architecture.md#domain-services) is the precedent for a complete command and a schema-derived query.
For each new journey, create one active contract under `docs/specs/`. Remove it after acceptance.

## Production gates

Before cutover:

- close required operational outcomes or obtain an approved, owned transition process;
- reconcile identities, credentials, authority, recruitment, placements, claims, private files, and pending effects against the current source;
- resolve or explicitly disposition each quarantine, unsupported credential, alias, and missing evidence item;
- verify the Bun deployment, PostgreSQL locks, required delivery providers, private storage, and separately authorized settlement evidence;
- qualify sustained operation, worker supervision, failure alerts, backup, restore, and credential hashing limits on the selected host;
- choose and rehearse a final-delta method;
- fence legacy writers and external schedules before native ownership starts;
- verify rollback after native writes, including native-only facts and pending external effects;
- obtain explicit operator authority for production transfer and each external or destructive action.

After transfer, verify that all required readers and writers use the native system.
Retire PHP and obsolete provider composition only after those dependencies and required archives have an accepted disposition.
Team membership never stands in for volunteer affiliation. A recommendation never stands in for an explicit coordinator outcome.
