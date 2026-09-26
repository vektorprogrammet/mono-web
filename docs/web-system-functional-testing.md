# Web-system functional testing

Status: implementation roadmap. [STATE.md](../STATE.md#evidence-boundary) records acceptance and remaining work.

## Goal and scope

Preserve web-system behavior while implementations change behind established boundaries.
The tests exercise functionality, not client design or usability.
Human testing owns visual design, comprehension, navigation preferences, and overall experience.

Browser automation must still exercise real controls, authentication, submissions, and visible results.
A control that cannot complete its action is a functional failure.
Screenshots and browser traces provide diagnostics, not visual-design acceptance criteria.

The [intended system](system.md) owns business meaning.
The [interface contracts](architecture.md#interface-contracts) own boundary responsibilities.
This plan references those sources rather than defining another business model.
[STATE.md](../STATE.md#next) owns delivery status.

## Contract architecture

```text
Business outcome and invariant
          |
Existing journey and step identities
          |
          +-- generated client and domain sequences
          |
          +-- browser -> HTTP -> service -> database and outbox
                    ^                           |
                    +----- fresh observation ---+
```

Each journey declares actors, prerequisite facts, actions, expected outcomes, forbidden outcomes, and required evidence.
Its contract describes what a person can accomplish, not a fixed sequence of pages or internal function calls.
The browser driver translates semantic actions into current controls.
A page redesign can change that driver without changing the business contract.

The boundaries remain explicit:

| Boundary                            | Functional contract                                                                       | Implementation free to change                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Person to web application           | Actions, permissions, recoverable errors, and displayed business outcomes                 | Layout, components, route composition, and client state representation |
| Browser or service caller to server | Authentication, scoped authorization, requests, responses, revisions, and replay behavior | Handlers, middleware, and transport implementation                     |
| Server to domain service            | Commands, queries, decisions, and typed failures                                          | Algorithms and internal decomposition                                  |
| Domain service to persistence       | Committed facts, constraints, atomicity, isolation, and retained evidence                 | SQL statements, table layout, indexes, and repository code             |
| Server to external system           | Durable effect identity, delivery status, retries, and private-file custody               | Provider and worker implementation                                     |

Human and machine principals need separate authorization checks.
A browser scenario does not establish service-principal behavior.

Tests assert observable contracts, not private state fields, exact SQL, internal call counts, or source text.
Database probes read semantic facts through small observer adapters.
A schema refactor can change those adapters without changing expected business outcomes.
An observer must not derive expected results from the mutation implementation under test.

## Existing foundations

Reuse these sources before adding another runner or abstraction:

- [Native assignment runner](../tools/e2e/run-real-native-recruitment-assignment.mjs): isolated runtime, canonical migrations, native authentication, and persistence evidence.
- [Interview-conduct browser scenario](../apps/dashboard/e2e/native-recruitment-interview-conduct.spec.ts): multiple actors, reload, and stale updates.
- [Placement browser runner](../apps/dashboard/e2e/run-real-native-placement.mjs): scenario manifest and parent-owned database lifecycle.
- [Playwright report sanitizer](../apps/dashboard/e2e/runtime-evidence-receipt.mjs): sanitized Playwright results and outcomes for runner evidence.
- [Interview properties](../apps/dashboard/app/foldkit/interview/update.property.test.ts): schema-generated inputs and client transition checks.
- [Scheduling transitions](../apps/dashboard/app/foldkit/scheduling/update.test.ts): stale observations, uncertain commands, and recovery.
- [CI workflow](../.github/workflows/tests.yml) and [Playwright configuration](../apps/dashboard/playwright.config.ts): existing execution and report ownership.
- [Database Layers](../packages/database/src/layers.ts): existing PGlite support with `btree_gist` and canonical migrations.
- [Socket fixture](../packages/database/src/test-support/postgres.ts): existing PGlite server and real `pg.Pool`, each limited to one connection.

Existing scenarios often start from separate seeded stages.
Passing those scenarios does not establish continuity across their stages.
The first new contract joins a complete workflow without reseeding intermediate outcomes.

## Local school-service gate

From a clean committed tree, run:

```bash
just golden school-service
```

Use the versions in the root manifest and lockfile. Install dependencies with `bun install --frozen-lockfile`.
The command requires Node, PostgreSQL server binaries with `btree_gist`, Chromium, and `unzip` for failure-trace processing.
Use Playwright's installed Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible local executable.
The project shell supplies Lefthook; it does not supply the complete acceptance toolchain.

The [parent](../tools/e2e/placement-check.ts) owns PostgreSQL, the native backend, and the loopback notification receiver.
The existing [browser child](../apps/dashboard/e2e/run-real-native-placement.mjs) builds and owns the dashboard and browser.
The golden scenario in [native-placement.spec.ts](../apps/dashboard/e2e/native-placement.spec.ts) uses separate native sign-in sessions.
It creates no business outcome through fixtures or direct success commands.

The controls establish affiliation, approval, placement, demand, proposal, confirmation, a dated commitment, and a Completed decision.
The decision uses the attendance that the service derives from the roster, the absences, and the coverage records.
A fresh volunteer session reads the resulting service without coordinator controls.
The test also checks an out-of-scope HTTP denial and a stale terminal denial through controls and HTTP.
The derived attendance meets the demand, so the controls and HTTP refuse an Unfulfilled decision.
A read-only PostgreSQL observer checks each transition and rejection through an independent connection.
It binds history, successful command receipts, roster snapshots, and notification work to those decisions.
The receiver checks the committed logical effect. It does not establish real-provider acceptance.

The command prints its parent PID, artifact directory, and final `receipt.json` path.
The receipt records the commit, source tree, runner and fixture digests, artifact hashes, result, and executed steps.
It requires no legacy revision or external authority files.
Only listed sanitized artifacts form the retained evidence: browser and HTTP observations, database checkpoints, loopback delivery, logs, and trace summaries.
Raw traces, browser result directories, credential manifests, PostgreSQL files, and owned processes do not remain after cleanup.
The receipt fails when browser evidence is absent, a required step fails, or cleanup fails.
Screenshots, accessibility audits, and visual preferences do not determine this gate.
The parent's separate `--browser` and `--api-only` modes retain the existing broader placement coverage.
These modes also refuse a coverer who is booked in the same interval. That check needs a second scheduled person.
Neither mode substitutes for the required golden browser command.

These test-driver faults establish that missing work cannot pass:

```bash
GOLDEN_SCHOOL_SERVICE_FAULT=omit-coverage just golden school-service
GOLDEN_SCHOOL_SERVICE_FAULT=absent-browser-evidence just golden school-service
```

Both commands must exit unsuccessfully. They change only the test driver, not production behavior.
With `omit-coverage`, the driver does not record the final coverage. The derived attendance then misses the demand, and `substitute-completed` fails.
For an interruption check, wait for `browser-active.json` in the printed directory, then send SIGINT to the printed parent PID.
The failed receipt and cleanup observations must show that all owned resources stopped.
Do not use the operator's demonstration ports or database for this command.

## Journey inventory

Keep one repository-owned native journey manifest.
Each entry links its business rule, executable scenarios, supported environments, and required evidence.
Generate the coverage report from that manifest and current run results.
The implementation-agnostic specification and its conformance checks are the parity authority.
Native CI must not require a sibling legacy repository or external migration authority files.

The following families define the initial scope, not a claim of complete coverage:

| Family                   | Functional outcome                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Account access           | Sign-in, recovery, session lifecycle, and authorized reads                                       |
| Recruitment              | Application, staff assessment, interview arrangement, conduct, and supported onboarding outcomes |
| Organization             | Membership and appointment changes with correct effective authority and retained history         |
| Schools                  | School details, department associations, and capacity maintenance                                |
| Placement                | Affiliation request, approval, placement, demand review, and roster confirmation                 |
| Dated service            | Date and interval scheduling, actual attendance, and supported terminal decisions                |
| Absence and substitution | Absence, admission outcome, coverage record, and actual coverage or unmet need                   |
| Reimbursement            | Private evidence, scoped review, and separate settlement evidence                                |
| Operational reads        | Directory, mailing recipients, and defined reports without cross-scope disclosure                |

An undefined product decision is an explicit gap, not a test expectation invented by the runner.
CMS, articles, generic events, and surveys remain outside the default core migration gate.
Required machine-caller contracts, migration rehearsals, and provider acceptance retain their separate suites.

## Evidence at each important transition

1. Perform the action through the real browser control.
2. Observe the actual HTTP outcome and current authority decision.
3. Read committed business facts from an independent database connection.
4. Check required history, command receipt, and outbox facts for that transition.
5. Observe the resulting state through a fresh read or browser reload.
6. Check another actor's view where the contract includes visibility or confidentiality.

Only prerequisite facts enter through fixtures.
The runner must not seed the outcome that the journey claims to establish.
Fixture instants are relative to the clock that the backend reads: the runner's fixed instant, or the time of seeding.
Then no fixture expires on a calendar date.
Expected denials must leave no unauthorized business mutation or unintended delivery work.
Security diagnostics can still record the denied attempt.

A committed business decision and provider delivery are separate outcomes.
A loopback receiver can establish the local delivery boundary, not acceptance of a real provider.
Repeated delivery attempts do not imply repeated business decisions.
Tests must not assert universal exactly-once delivery without a provider contract that supports it.

## Execution tiers

| Tier                                  | Purpose                                                                                           | Evidence limit                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pure models and Foldkit stories       | Broad transition, failure, and response-order exploration                                         | No real transport or persistence evidence                                     |
| Isolated PGlite systems, if qualified | Fast execution of compatible functional contracts and browser journeys                            | Embedded-engine evidence, not PostgreSQL server concurrency or crash recovery |
| Isolated PostgreSQL systems           | Golden browser workflows, production-driver behavior, independent sessions, and transaction races | Local system evidence, not deployed-provider acceptance                       |
| Authorized provider environment       | Actual provider transport, storage, and operational recovery                                      | Separate authority and acceptance requirements                                |

PGlite runs behind the backend persistence boundary, not inside the application browser as a replacement server.
The real application still uses its normal HTTP and authentication paths.
The browser must not call the database directly.

### PGlite qualification

PGlite already supports database-level tests; whole-system use remains a candidate optimization.
Its [upstream documentation](https://pglite.dev/docs/about) describes PostgreSQL compiled to WebAssembly with ephemeral and persistent storage.
The [socket adapter](https://pglite.dev/docs/pglite-socket) supports PostgreSQL clients.
Upstream documents a single-connection engine and warns that multiplexed connections differ from PostgreSQL server.
Independent PGlite instances can isolate parallel systems; they do not reproduce competing transactions inside one PostgreSQL server.

The [extension catalogue](https://pglite.dev/extensions/#btree-gist) includes `btree_gist`.
The application uses that extension, exclusion constraints, and advisory locks.
Extension availability alone does not establish application compatibility.

The socket fixture executes canonical SQL files but does not create the normal migration ledger.
The [runtime Layer](../packages/database/src/runtime-layer.ts) requires that ledger.
The [native backend](../apps/backend/src/main.ts) configures eight pool connections.
Qualification must preserve the shared pool used by Effect SQL and native authentication.
Replacing only `DatabaseTest` does not establish that complete composition.

The qualification slice must establish:

1. Pinned Bun, PGlite, PostgreSQL engine, socket adapter, and extension versions.
2. The unmodified canonical migration chain, migration ledger, repeat application, and required constraints and triggers.
3. Native authentication and the existing database drivers against one consistent database instance.
4. Equivalent parameter encoding, result decoding, timestamps, errors, transactions, and rollback for the supported contract subset.
5. Identical semantic results for the same scenarios on PGlite and PostgreSQL server.
6. Explicit ownership and isolation of each instance, application, browser session, file root, receiver, clock, and port.
7. Repeatable cold and warm measurements for startup, migration, seeding, full journey time, peak memory, and teardown.
8. A supported-case matrix that preserves server-backed requirements instead of silently skipping them.

Extend the existing socket fixture first; do not create a second PostgreSQL compatibility layer.
If it cannot preserve the required behavior, evaluate a narrow existing database Layer boundary.
Do not replace production SQL, weaken constraints, remove locks, or alter business rules to make PGlite pass.
Do not describe an in-memory commit as durable across process failure.

Keep concurrent-session races, lock contention, worker claims, transaction isolation, and crash recovery on PostgreSQL server.
Retain a required PostgreSQL run for each promoted golden journey, even when a faster tier also covers it.

Measure against an efficient PostgreSQL baseline, including isolated databases and reusable immutable schema templates where appropriate.
PGlite must demonstrate a useful measured gain before adoption.
Build and browser startup costs can dominate database startup costs.
No speedup or concurrency capacity is assumed in this plan.

## Generated functional sequences

Start with the existing Effect Arbitrary and `@effect/vitest` conventions.
Use Foldkit `Story` for message sequences and explicit command completion order.
Use `Scene` for selected control-to-message and visible-result contracts.
Neither simulation substitutes for the browser journey.

Generate reachable sequences from a valid starting state.
Keep broad schema-closure properties separate from business properties.
Use a small independent oracle, not the production update function as its own expected answer.

Initial generated actions include selection, editing, submission, refresh, response failure, delayed completion, retry, and recovery.
Important properties include stale-response rejection, draft retention, honest errors, revision conflicts, and preserved command identity after uncertain outcomes.
A request completion can arrive after another selection or edit.
Explicit completion ordering tests that logic; a sequential asynchronous runner does not establish concurrency coverage.

Record the seed, replay information, and minimized semantic action sequence.
Reset the isolated scenario before each replay and shrinking attempt.
Keep a deterministic regression when a minimized failure exposes a plausible business defect.
Use a dedicated stateful runner such as fast-check only when the existing tools leave a concrete gap.

## CI and resource ownership

The functional gate runs without production data, provider credentials, or shared development resources.
Use the same local command in CI.
Build the exact tested source once, then reuse that immutable application artifact across isolated scenarios.
Evidence records the tested source identity, not an unrelated branch head.
Use an explicit functional job in the existing CI workflow, separate from preview deployment and release jobs.
The job needs read-only repository access and no inherited provider credentials.
Do not execute untrusted pull-request code through a privileged deployment workflow.
Declare timeouts, required artifacts, and cleanup behavior explicitly.

Required checks must distinguish pass, fail, unsupported environment, and missing evidence.
A skipped required journey, missing artifact, or missing shard fails the aggregate gate.
A stale receipt from another source artifact cannot satisfy the gate.
A retry that passes remains a recorded first-attempt failure, not an unexplained green result.

Start with one heavy local execution under the existing resource policy.
Independent CI jobs or shards own separate mutable systems and explicit resource limits.
Increase concurrency only after measurements show acceptable memory and total runtime.
Database, cookie, file, clock, and worker isolation must hold before concurrent execution.
No runner uses the operator's interactive demonstration database.

Cache immutable dependencies and build artifacts, not mutable scenario results or authenticated browser sessions.
If fixture snapshots become worthwhile, derive them from canonical migrations and fixture inputs.
Key snapshots by those inputs and engine versions; invalidate them when any input changes.

Retain failure diagnostics through the existing evidence mechanism.
Use browser traces, network outcomes, server diagnostics, and targeted database observations.
Correlate journey steps with requests and existing command, entity, and effect identifiers.
Keep trace identity separate from business idempotency identity.
Redact credentials and private bytes. Keep artifact retention bounded.
Capture the original browser failure with `retain-on-failure` traces and no acceptance retries.
Upload an explicit sanitized artifact list, never a raw runtime directory with cookies or authorization headers.

UI accessibility and usability programs remain separate from this functional gate.
This scope does not require removal of existing accessibility checks.
Screenshots do not create pixel-baseline obligations for the golden suite.

### Continuous substitute coverage

The existing golden command continues through [substitute coverage](system.md#substitute-coverage).
The [source-owned checkpoints](../tools/e2e/golden-school-service.mjs) keep the original journey and add the absence-to-coverage sequence.
A substitute is an admission outcome. People agree on cover outside the system. The system records the absence and the person who covered it.
The fixture adds two applicants without an outcome and one department member. It creates no outcome, absence, or coverage record.

Before the Substitute outcome, the absent volunteer cannot name the applicant.
The manager records the outcome of both applicants in the browser. The server refuses a stale outcome version.
A department member reads the on-call contacts and records no outcome. A substitute cannot record cover for the absence of another person.
The volunteer records the coverage in the browser. The coordinator replaces the record and then withdraws it in the browser.
The volunteer records the coverage again. The completion derives attendance from that record, and the absence closes Covered with it.

Independent PostgreSQL reads check outcome revisions, coverage records, reservations, and audit actions at each checkpoint.
Each executed write adds one successful receipt. Refused commands and reads change no fact.
The observer does not retry commands or ignore failed invariants. Golden output remains within the existing sanitized artifact contract.
These synthetic local observations do not establish real-provider delivery or current production-data parity.

### Recruitment to first placement

The separate [recruitment observer](../tools/e2e/golden-recruitment.mjs) owns the ordered checkpoints for this continuous native journey.
The [browser scenario](../apps/dashboard/e2e/native-recruitment-first-placement.spec.ts) drives the public application, interview, onboarding, affiliation, and first placement.
Fixtures create prerequisites, not the outcomes under test. Independent PostgreSQL reads bind the same application and Person through the final placement.

Use the local gate prerequisites and a clean committed checkout:

```bash
just golden recruitment
```

The runner builds the homepage and dashboard from that source. It serves the homepage through an owned local HTTPS Worker.
Certificate trust applies only to the disposable local browser requests. The runner isolates provider configuration and uses loopback notification delivery.
No production access or provider credentials are required. Run only one heavy acceptance job at a time.

The journey distinguishes recommendation, invitation, account claim, affiliation, and placement. Failed invitation delivery recovers without another business decision.
An actor without the case capability cannot read staff assessments or issue invitations. Wrong-department affiliation approval fails without changed business facts.
Invitation links remain bearer capabilities; giving someone a valid link gives claim authority. Consumed-token replay remains denied.

A fresh volunteer login and reload must display the own placement without management controls. Another applicant must not receive it.
The own projection includes only active placements for the authenticated Person and selected department and semester.
It does not manufacture a confirmed roster, dated service, or attendance.

The command retains sanitized receipts, observations, diagnostics, and separate visual evidence outside the checkout.
It checks source identity after execution and removes owned processes, PostgreSQL, credentials, private traces, and local Worker state.
The source-owned runner defines the artifact inventory. The hosted `Browser journeys` job runs it; see [Hosted journeys](#hosted-journeys).
See [STATE.md](../STATE.md) for the exercised revision and evidence limits.

### Claim to settlement evidence

The [reimbursement runner](../tools/e2e/golden-reimbursement.mjs) owns the checkpoints for the continuous native receipt journey.
The [Receipt guide](../packages/domain/src/receipt/README.md) explains its service, authority, private storage, and recovery boundaries.

Use the local gate prerequisites and a clean committed checkout:

```bash
just golden reimbursement
```

The journey uses synthetic people, disposable PostgreSQL, private local files, and a loopback notification provider.
It connects submission, scoped approval, separate settlement authority, and the owner’s fresh-session result through actual dashboard controls.
Settlement records external evidence. The program does not execute a payment.

Independent database and file observations must agree with the browser’s claim, actors, decisions, and exact private bytes.
Negative commands require valid transport preconditions before they can establish an authorization denial.
Replay, concurrent commands, process restart, and unattended delivery recovery preserve the original business facts.

The gate checks resource bounds without changing machine limits. It retains source-bound, sanitized evidence outside the checkout.
Only one heavy acceptance job runs at a time. Owned runtime resources must be released after success, failure, or handled interruption.
Local observations do not establish current-data reconciliation, real-provider delivery, production readiness, or cutover authority.
See [STATE.md](../STATE.md) for the exercised source revision and remaining gates.

### Golden CI implementation

The [CI workflow](../.github/workflows/tests.yml) runs the existing journey through the [CI wrapper](../tools/e2e/golden-school-service-ci.mjs).
The [evidence inspector](../tools/e2e/golden-school-service-evidence.mjs) owns source, build, receipt, and artifact checks.
The wrapper derives upload paths from the checked files after staging. The workflow does not maintain another file inventory.
Credential checks cover decoded JSON fields and raw diagnostics. Unsupported files cannot enter staging.

From a clean committed tree, use the local gate prerequisites and run:

```bash
bun --no-env-file tools/e2e/golden-school-service-ci.mjs /tmp/golden-school-service-evidence
```

Use a new output directory outside the checkout for each run.
The wrapper keeps the first command outcome, including termination signals.
On handled interruption or runner failure, cleanup drains declared process groups before removal of private runtime files.
The generated upload set contains only checked evidence and the bounded CI summary.

[STATE.md](../STATE.md#evidence-boundary) records integrated acceptance and remaining evidence limits.
The golden school-service journey (slice A) and its CI gate (slice B) are accepted; the gate runs in the hosted `Tests` workflow.
The wrapper `tools/e2e/golden-school-service-ci.mjs` and its evidence checks own the failure criteria.

### Hosted journeys

The hosted `Tests` workflow runs these journeys on each push to `main` and each pull request.
Run the same journey locally with the listed command.

[//]: # "hosted-journeys: generated from the justfile, tools/conventions/src/journeys.ts, and .github/workflows/tests.yml by just layout write; do not edit"

`just layout write` generates this section and the matrix legs in `.github/workflows/tests.yml` from the names that `just golden`, `just e2e`, `just proof`, and `just rehearsal` accept.
Each name is one leg, unless `tools/conventions/src/journeys.ts` gives it a job of its own or excludes it with its reason.
A name runs the files that its command names, and in turn the files that those name. Each Playwright spec (`apps/*/e2e/**/*.spec.{ts,mjs}`) and each file of an acceptance probe (`tools/acceptance/**/*.{ts,mjs}`) runs under a name, unless the declaration excludes it.

| Command                                      | Hosted job                                                       |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `just golden school-service`                 | Golden school-service (required functional gate)                 |
| `just golden recruitment`                    | Browser journeys (golden recruitment)                            |
| `just golden reimbursement`                  | Browser journeys (golden reimbursement)                          |
| `just golden team-application`               | Browser journeys (golden team-application)                       |
| `just e2e applicant`                         | Public applicant (PostgreSQL and Chromium)                       |
| `just e2e contact`                           | Browser journeys (e2e contact)                                   |
| `just e2e admission-periods`                 | Browser journeys (e2e admission-periods)                         |
| `just e2e approval`                          | Browser journeys (e2e approval)                                  |
| `just e2e conduct`                           | Browser journeys (e2e conduct)                                   |
| `just e2e content-publication`               | Browser journeys (e2e content-publication)                       |
| `just e2e identity`                          | Native identity browser evidence (fresh PostgreSQL and Chromium) |
| `just e2e interview-response`                | Browser journeys (e2e interview-response)                        |
| `just e2e organization`                      | Browser journeys (e2e organization)                              |
| `just e2e owner`                             | Browser journeys (e2e owner)                                     |
| `just e2e profile`                           | Browser journeys (e2e profile)                                   |
| `just e2e recruitment`                       | Browser journeys (e2e recruitment)                               |
| `just e2e scheduling`                        | Browser journeys (e2e scheduling)                                |
| `just e2e schools`                           | Browser journeys (e2e schools)                                   |
| `just e2e settlement`                        | Browser journeys (e2e settlement)                                |
| `just e2e social-events`                     | Browser journeys (e2e social-events)                             |
| `just e2e substitutes`                       | Browser journeys (e2e substitutes)                               |
| `just e2e sign-in-pages`                     | Browser journeys (e2e sign-in-pages)                             |
| `just e2e unavailable-projections`           | Browser journeys (e2e unavailable-projections)                   |
| `just e2e onboarding`                        | Browser journeys (e2e onboarding)                                |
| `just e2e password-recovery`                 | Browser journeys (e2e password-recovery)                         |
| `just e2e recommendation`                    | Browser journeys (e2e recommendation)                            |
| `just e2e recommendation-applicant-progress` | Browser journeys (e2e recommendation-applicant-progress)         |
| `just e2e recommendation-co-interviewer`     | Browser journeys (e2e recommendation-co-interviewer)             |
| `just e2e recommendation-correction`         | Browser journeys (e2e recommendation-correction)                 |
| `just e2e recommendation-report`             | Browser journeys (e2e recommendation-report)                     |
| `just e2e recommendation-returning`          | Browser journeys (e2e recommendation-returning)                  |
| `just proof delivery-recovery`               | Browser journeys (proof delivery-recovery)                       |
| `just proof rule-reconciliation`             | Browser journeys (proof rule-reconciliation)                     |
| `just rehearsal organization-import`         | Browser journeys (rehearsal organization-import)                 |
| `just rehearsal receipt-import`              | Browser journeys (rehearsal receipt-import)                      |
| `just rehearsal current-assignment`          | Browser journeys (rehearsal current-assignment)                  |

These commands and files are not hosted:

| Command or file                                            | Reason                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just proof authorization-rules`                           | Fails on main after its migration preflight: the admission matrix step compares an AdmissionPeriod instance with a plain object (packages/database/runtime/authorization-rules-postgres-proof-main.ts)                          |
| `just rehearsal account-cohort`                            | Needs the PHP CLI of the legacy-data devenv profile; the hosted legs run the default profile                                                                                                                                    |
| `just rehearsal legacy-current-assignment`                 | Needs MariaDB from the legacy-data devenv profile; the hosted legs run the default profile                                                                                                                                      |
| `just rehearsal legacy-organization`                       | Needs MariaDB from the legacy-data devenv profile; the hosted legs run the default profile                                                                                                                                      |
| `just rehearsal legacy-receipt`                            | Needs MariaDB from the legacy-data devenv profile; the hosted legs run the default profile                                                                                                                                      |
| `just rehearsal legacy-candidate`                          | Needs MariaDB from the legacy-data devenv profile; the hosted legs run the default profile                                                                                                                                      |
| `bun run --cwd apps/dashboard e2e:real-oauth`              | Needs an external topology; without one, Playwright skips every test                                                                                                                                                            |
| `apps/dashboard/e2e/native-session-journey.spec.ts`        | Needs a running stack with the accounts of just seed, such as devenv up, and REAL_NATIVE_IDENTITY_E2E and DASHBOARD_ORIGIN set; no runner owns that topology, and without it every test skips                                   |
| `apps/dashboard/e2e/native-users-journey.spec.ts`          | Needs a running stack with the accounts of just seed, such as devenv up, and REAL_NATIVE_IDENTITY_E2E and DASHBOARD_ORIGIN set; no runner owns that topology, and without it every test skips                                   |
| `apps/dashboard/e2e/native-team-interest-journey.spec.ts`  | Needs a stack that e2e/native-team-interest-mailing-list-seed.mjs seeds, with REAL_NATIVE_IDENTITY_E2E set; no runner or recipe provides it, and without it every test skips                                                    |
| `apps/dashboard/e2e/native-mailing-lists-journey.spec.ts`  | Needs a stack that e2e/native-team-interest-mailing-list-seed.mjs seeds, with REAL_NATIVE_IDENTITY_E2E set; no runner or recipe provides it, and without it every test skips                                                    |
| `apps/dashboard/e2e/native-recruitment-assignment.spec.ts` | Superseded by native-recruitment-session-journey.spec.ts, which just e2e recruitment runs; nothing sets its REAL_RECRUITMENT_E2E variables, so every test skips                                                                 |
| `apps/homepage/e2e/preview-smoke.spec.ts`                  | Needs a deployed preview origin in PREVIEW_BASE_URL; without one, every test skips                                                                                                                                              |
| `apps/homepage/e2e/homepage-dev-journey.spec.ts`           | Needs a native backend: its Playwright web server serves the homepage alone, and the home page reads news from the API since 4efd0a2c, so it answers 503; it needs a runner that owns PostgreSQL, the backend, and the homepage |

[//]: # "hosted-journeys: end"

`Browser journeys` runs one journey on each runner, with `fail-fast` off.
Each journey starts its own PostgreSQL, ports, and Chromium; some runners use fixed ports, so two journeys must not share a runner.
The job uploads only the `/usr/bin/time` resource summary. Journey evidence stays in the job log.

`just layout` fails when the legs, this section, or the browser evidence scripts of the apps disagree with the accepted names and `tools/conventions/src/journeys.ts`.
It also fails on a Playwright spec or an acceptance probe file that no name runs and the declaration does not exclude, so a new check is hosted or excluded with its reason from the start.
A new name becomes a leg, so add it to a recipe only after its journey passes locally.

## Development sequence

Each implementation slice needs its own bounded contract and acceptance record.
This roadmap is not one multi-feature implementation specification.

| Slice                          | Deliverable                                                         | Dependency                               | Acceptance gate                                                                                        |
| ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A: first golden workflow       | Continuous school-service story on PostgreSQL                       | Existing runtime and business contracts  | Real controls, multiple actors, persisted decisions, reload, denial, and independent evidence          |
| B: required CI execution       | Local command in credential-free CI with exact-source evidence      | A                                        | Deliberate journey failure fails CI; missing required results also fail; cleanup runs after failure    |
| C: fast database qualification | Measured PGlite compatibility and adoption decision                 | A provides the comparison scenario       | Unmodified schema and supported contracts agree; performance evidence and explicit exclusions exist    |
| D: generated sequence coverage | Bounded client transition generators and minimized replay           | Existing client models; independent of C | Known stale-response and uncertain-command defects fail their properties; replay reproduces failures   |
| E: inventory expansion         | Named core journeys with evidence and supported-engine requirements | A and inventory mapping                  | Each added journey upholds its own contract; missing core obligations remain visible                   |
| F: measured execution scaling  | Safe sharding, build reuse, and qualified fixture reuse             | B plus observed resource measurements    | Isolation survives concurrent runs and interruption; measured throughput improves without weaker gates |

C and D do not block the PostgreSQL golden workflow or its CI gate.
An unsuccessful PGlite qualification leaves PostgreSQL as the working baseline.
No qualification result authorizes production deployment or changes migration readiness by itself.

Slices A and B are accepted; their specifications are retired and live in Git history.
Later slices receive separate specifications before implementation.

## Planning evidence and limits

This plan follows source inspection and the operator's functional-scope decision.
The existing interview property test file passed: 11 tests, including a schema property configured for 150 generated cases.
That run did not execute the full browser suite or establish PGlite compatibility.
No PGlite benchmark, adapter change, CI change, deployment, or provider action formed part of this planning task.
