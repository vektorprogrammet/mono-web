# State

Lifecycle: build

## Current

Documentation reconciled against source and retained local evidence on 2026-09-24.
Production still uses legacy PHP. Local implementation and acceptance do not authorize replacement.

The operator selected a portable Bun backend with PostgreSQL, not a Cloudflare Worker backend.
Development remains local. Paid infrastructure provisioning is deferred until migration cutover preparation.
DigitalOcean, Netlify, and other managed-database hosts remain candidates, not selected deployments.
Free plans can be evaluated, but no cloud provisioning or source-data upload is authorized.
The [previous Cloudflare development contract](docs/specs/cloudflare-development-provider-boundary.md) is superseded, not accepted.
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

The following counts describe earlier observations, not a fresh database measurement.

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

The [backup reader](tools/e2e/legacy-source-snapshot.ts) covers six tables:
users, departments, semesters, schools, school-department links, and assistant history.
The cutover imports references, People, history, and Accounts in one target transaction.
It explicitly leaves current assignments unimported. A newer snapshot does not extend this reader.
The [assignment cohort](packages/database/src/current-assignment-cohort.ts) requires `synthetic: true`.
The [receipt adapter](apps/backend/src/receipt/import-snapshot.ts) also requires synthetic source and payment-account evidence.
Both need real-source reconciliation contracts and adapters, not removal of their safety checks.

Organization import also needs integration with accepted Person mappings.
The [organization adapter](packages/domain/src/organization/import.ts) derives membership Person IDs from numeric legacy user IDs.
The [real Person adapter](tools/e2e/legacy-person-snapshot.ts) creates `legacy-person-<id>` identities instead.
Adding organization source tables without reconciling those identities cannot establish correct membership or authority.

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

### Remaining migration work

| Workstream                      | Remaining deliverable                                                                                                                                                               | Completion gate                                                                                                                                                              | Authority                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Operational scope               | Resolve the obligations below. Implement required outcomes or define an explicit transition process.                                                                                | Each active core case has a supported journey and a responsible owner. Unresolved policy is not silently waived.                                                             | Product decisions for policy; local implementation for defined contracts.          |
| Real-source import coverage     | Extend the six-table reader and import contracts for required current state, private files, and pending work.                                                                       | Each source occurrence has an evidenced mapping and disposition. Synthetic-only assignment and receipt adapters do not qualify.                                              | Local implementation; current production reads need authorization.                 |
| Current-data reconciliation     | Obtain a consistent current snapshot, private file archive, and external-work inventory. Resolve identity, authority, quarantine, and payment evidence.                             | Rehearse the complete reconciled candidate, not only the historical backup. Verify identity-level accounting and retained private bytes.                                     | Authorized source access and human decisions for ambiguous facts.                  |
| Portable deployment preparation | Select the Bun host, PostgreSQL service, private storage, mail, and required integrations. Configure ingress, secrets, migrations, worker supervision, backups, and failure alerts. | The exact candidate preserves PostgreSQL locking and private-file custody. Required delivery work has an explicit runner and recovery path.                                  | Local preparation now; provider selection and provisioning at cutover preparation. |
| Provider acceptance             | Exercise real authentication, scoped access, private-file writes and reads, required delivery, restart, retry, revocation, and restore.                                             | Observe the actual selected providers. Verify deployment limits and operational recovery. Local capture adapters and frontend previews are not substitutes.                  | Explicit provider and credential authorization.                                    |
| Cutover and retirement          | Reconcile the final delta, fence legacy writers, verify rollback after native writes, and transfer ownership. Retain required archives and retire legacy dependencies.              | One authoritative writer; no unexplained delta, lost pending effect, missing required file, or unresolved active case. Required readers and writers no longer depend on PHP. | Separate production authority for transfer, rollback, and retirement.              |

The Bun composition already applies database migrations and starts configured background workers.
The obsolete Worker migration and scheduled-handler mismatch is not a requirement to rebuild that runtime.
Deployment acceptance must verify the selected composition and every required delivery path.
PR preview acceptance remains separate tooling work; it does not establish production readiness.

Delivery status and remaining integration:

- The [recruitment worker](apps/backend/src/recruitment/worker.ts) now runs under native Bun lifecycle supervision when its HTTP notification Layer is configured. Local development explicitly disables it. Synthetic PostgreSQL and loopback HTTP acceptance verified retry, stale-claim recovery, retained payloads, interruption, restart, and root failure. Real-provider acceptance remains open.
- [Password-reset mail](apps/backend/src/password-recovery/drain-main.ts) has a one-shot drain command. Its production execution and recovery need explicit ownership.
- Receipt commands already attempt post-commit delivery and stale-claim recovery. The [receipt drain](apps/backend/src/receipt/drain-main.ts) adds explicit retry. Verify unattended recovery after failure and restart; do not assume an HTTP request or manual command will arrive.

The recommended next local slice is real-source current-assignment reconciliation, with explicit mappings and provenance.
The historical backup can exercise rejection and accounting, but it cannot supply current assignments.
Broader reader coverage must not turn historical membership into current authority or remove synthetic-only safety checks.

### Remaining operational obligations

The source review distinguishes missing native outcomes from undefined policy. None of the unresolved obligations is waived.

| Obligation                  | Source finding and next boundary                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mailing administration      | Scoped recipient reads have local acceptance. Arbitrary list administration and Workspace synchronization need a separate operational requirement and contract.                                                                                                                                                                      |
| Standalone team recruitment | Legacy receives an independent team application, sends a receipt and team notification, and permits scoped review. Native team-interest reads do not replace it. Confirm active cases and the responsible owner. Intake, review, retention, and any handover need an explicit contract. Do not invent hiring states or appointments. |
| Reminders                   | Legacy defines applicant reminders, staff digests, and separate admission subscribers. Source does not establish production cadence. Native invitation retry and requested rebooking are not reminders. Reminder cadence, SMS, subscriber consent, and human follow-up ownership remain undecided.                                   |
| Interview no-show           | Neither source establishes a distinct nonattendance outcome. `NO_CONTACT` means not yet contacted, not absent. Decide whether observed nonattendance needs its own evidence and rebooking contract or an explicit handover. Do not infer nonattendance from elapsed time.                                                            |
| Service corrections         | Ordinary placement edits exist. Frozen commitments and terminal evidence have no reversal or supersession command. Legacy history edit/delete is not a safe substitute. Define correction cases, authority, evidence, and downstream effects before adding reversal.                                                                 |
| Coordinator reads           | Identity cards have local acceptance. Historical lookup, exports, and aggregate reports need a named operational consumer and an explicit contract, not generic chart parity.                                                                                                                                                        |

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
- Obtain receipt file bytes and digests. Define encrypted payment-account custody and map owners and departments.
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
Placements and Substitutes still expose direct database calls from the backend.
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
Each directory retains source provenance and evidence outside the product repository. Temporary storage is not a permanent archive.
No repository-wide all-packages test pass or deployed provider journey is claimed.

The documentation refresh inspected source and retained metadata. The subsequent organization acceptance exercised local runtime boundaries only.
Historical tracked material remains in Git history. Earlier unique umbrella documentation was preserved in a local checksummed archive before removal.
