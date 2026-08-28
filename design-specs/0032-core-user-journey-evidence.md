# Goal-1 design spec 0032 - core user journey evidence

> **Summary:** One maintainer command starts the current Symfony application against a disposable database, drives the remaining accepted core user journeys in a real browser, and emits canonical runtime receipts for the exact source revisions. Existing recruitment runners may emit additional receipts when one executed flow genuinely covers another accepted journey. No source declaration, API-only probe, skipped test, or stubbed transport counts as user-journey evidence.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 runtime evidence for every accepted user-visible journey |
| Contract | `functional-parity-runtime-evidence/v1` |
| Lifecycle state | `Frozen` through amendment `0032.3`. Implementation/evidence pending. No product, provider, production, or operator authority is granted |
| Dependencies | 0024 zero-gap inventory, 0027 accepted journey authority, 0030 runtime evidence receipts |
| Current worktree | `/tmp/mono-web-final-integration` |
| Amendment | `0032.3` authorizes only the content-operations PHP server concurrency correction |
| Amendment base | `ddbd796145f43347f315a8e92259895f2c17dde1` |
| Revision status | Implementation/evidence pending |

## Amendment 0032.1 - deterministic background-operation evidence

This bounded amendment owns the `e2e:real-background-operations` evidence contract. It does not change Symfony or native product behavior.

The runner must control the clock for the positive info-meeting fixture. The fixture load and notification commands must use this clock.

The fixed `Europe/Oslo` instant must make the meeting occur today and in the future.

The runner must observe exactly one notification row with `info_meeting=false`. It must observe exactly one row with `info_meeting=true`.

Thus, the accepted multiset is exactly `{info_meeting:false,true}` for the fixture subscriber. A count-only assertion does not satisfy this contract.

One row does not satisfy this contract. An assertion that accepts one or two rows does not satisfy this contract.

Design spec 0051 is the sole receipt authority for `intent://journey:parity:interview_recruiter:v1`. This runner must not produce its legacy receipt.

This runner must produce receipts only for these accepted journeys:

- `intent://journey:parity:admission_operations:v1`.
- `intent://journey:parity:background_automation:v1`.
- `intent://journey:parity:background_delivery:v1`.

The runner must preserve its existing legacy observations for these three journeys. It must not weaken or replace their persisted-outcome checks.

Legacy observations remain local evidence only. They do not supersede native authority from design spec 0051.

This amendment authorizes evidence-harness edits only. It authorizes no provider call, production effect, deployment, credential change, or production-data access.

The existing operator boundary remains unchanged. An operator must separately authorize every external effect.

## Amendment 0032.2 - hybrid identity and school evidence

This amendment authorizes one bounded evidence topology for the current revision. Its revision status is implementation/evidence pending.

The original contract and all product semantics remain unchanged. Amendment `0032.1` also remains unchanged.

### Authority and origin boundaries

The current native origin must contain the current dashboard, backend, PostgreSQL database, and Better Auth service.

This native origin owns current mono authentication and the read observations for identity and school data.

Native read evidence must use `GET /api/admin/users`, `GET /api/admin/schools`, `/dashboard/brukere`, and `/dashboard/skoler`.

A separate disposable Symfony origin must own the legacy writes and legacy UI observations.

Legacy evidence must address `/api/login` and all legacy command endpoints on that explicit origin.

Legacy UI evidence must address `/login`, `/kontrollpanel/brukeradmin`, `/kontrollpanel/semesteradmin`, and `/kontrollpanel/skole/capacity/` on that origin.

The Symfony origin must use its own JWT and session. The runner must not translate a Better Auth cookie into legacy authentication.

The runner must address the Symfony origin explicitly. Native dashboard and backend requests must not use that origin.

The evidence harness must not add a proxy, route fallback, authentication fallback, or authentication translation.

The evidence harness must not add a product compatibility branch. It must not change the authority of any product route.

Thus, this topology is dual-authority and dual-origin evidence. It is hybrid cross-line evidence, not native replacement evidence.

This amendment authorizes evidence-harness edits only. It grants no product, provider, production, deployment, credential, or operator authority.

### Authorized journey evidence

The runner must emit evidence for exactly these two journey references:

- `intent://journey:parity:identity_admin:v1`
- `intent://journey:parity:school_scheduling:v1`

The `identity_admin` receipt must contain exactly these four step identifiers:

- `identity-admin-api-operation`
- `identity-admin-command-write`
- `identity-admin-legacy-route`
- `identity-admin-mono-route`

The `school_scheduling` receipt must contain exactly these four step identifiers:

- `school-scheduling-api-operation`
- `school-scheduling-command-write`
- `school-scheduling-legacy-route`
- `school-scheduling-mono-route`

The run must not emit a receipt for another journey. One receipt must not contain a step from the other journey.

### Evidence claim limit

The receipts can claim current native authentication and current native read routes.

The receipts can also claim the observed legacy writes and legacy UI pages on the explicit Symfony origin.

The receipts must not claim native identity creation. They must not claim native semester creation, school creation, or capacity scheduling.

The receipts must identify these observations as hybrid evidence. They must not describe them as native replacement evidence.

### Fixture binding and cleanup

The runner must use one hybrid fixture identifier. Its fixture digest must bind these exact committed sources in this order:

1. `apps/server/tests/Fixtures/OrgOperationsJourneyFixture.php`
2. `apps/dashboard/e2e/native-schools-directory-seed.mjs`

The digest input must contain each source path and its bytes in a deterministic ordered manifest. A single-source digest does not satisfy this contract.

Each receipt must bind the hybrid fixture identifier and the combined fixture digest.

The source manifest must bind these exact runner sources:

- `apps/dashboard/e2e/run-real-symfony-org-operations.mjs`
- `apps/dashboard/e2e/real-symfony-org-operations.spec.ts`

Cleanup must stop the dashboard, native backend, Symfony server, and PostgreSQL server after success or failure.

Cleanup must delete all temporary PostgreSQL and SQLite data. It must also delete generated secrets, sessions, caches, logs, uploads, and reports.

No implementation or receipt satisfies this amendment until the bounded topology passes and produces deterministic evidence.

## Amendment 0032.3 - content-operations server concurrency correction

This amendment authorizes one correction in `apps/dashboard/e2e/run-real-content-ops.mjs`. Its implementation and evidence are pending.

The runner must set `PHP_CLI_SERVER_WORKERS=8` in the environment of the PHP built-in server.

This environment value is the only authorized implementation change. The runner must not change a timeout or a `waitUntil` value.

The runner must not change product code, product behavior, journey semantics, evidence observations, or the receipt contract.

### Required runtime evidence

The server log must show multiple PHP worker process identifiers before the browser tests start.

The first browser request sequence must serve page assets and font files immediately. It must not depend on Playwright cancellation or a navigation timeout.

All four existing browser tests must pass unchanged in one run:

- `e2e/real-content-publication.spec.ts`
- `e2e/real-survey-admin.spec.ts`
- `e2e/real-platform-ops.spec.ts`
- `e2e/real-framework-runtime-plumbing.spec.ts`

The exact receipt set must remain unchanged. This requirement includes the journey identifiers, step identifiers, fixture binding, source manifest, and observations.

The existing cleanup contract remains unchanged. Cleanup must stop the parent server and all worker processes after success or failure.

Cleanup must also remove all disposable data, generated secrets, sessions, caches, logs, uploads, browser results, and reports.

No implementation or receipt satisfies this amendment until one run produces all required evidence and completes deterministic cleanup.

## User journey

1. The maintainer checks out the exact mono revision selected by accepted intent.
2. The maintainer creates a fresh disposable SQLite database and loads deterministic fixtures.
3. The runner starts the current Symfony application on loopback only.
4. Playwright drives each named public or authenticated journey through rendered UI.
5. Every write journey observes its success page or a fresh read after submission.
6. The runner sanitizes the passing Playwright JSON report.
7. The runner emits one canonical receipt per accepted journey, covering that journey's exact accepted step identifiers.
8. The maintainer combines the generated receipts into the external runtime-evidence authority.
9. The parity command accepts the receipts only when revisions, source digests, journey references, steps, runner digests, fixture digests, and results match.

## Required journeys

The core Symfony browser suite must execute these accepted journeys:

- `applicant-admission`: submit an open-department application and observe confirmation or a fresh persisted read.
- `contact-public`: submit the public contact form and observe its success state without delivering external mail.
- `content-public`: open public content rendered by the current server.
- `files-media`: load a real user-visible media asset through a rendered page.
- `identity-self`: authenticate a fixture user and open that user's profile.
- `receipt-self`: submit a receipt with an image and observe it on a fresh personal receipt read.
- `survey-participate`: submit an available survey and observe its configured completion state.
- `team-interest-self`: submit the public team-interest form and observe its confirmation or fresh persisted read.

Existing real recruitment suites may additionally bind their executed flows to these accepted journeys when the behavior is the same user action:

- applicant assignment also covers `recruitment-review-applicants`.
- invitation response also covers `applicant-notify-self` and `interview-candidate`.

The existing assignment, scheduling, invitation-response, review-applicants, applicant-notify-self, and interview-candidate receipts remain separate accepted journey receipts even when they share one passing artifact.

## Constraints

- Use the current mono Symfony source, templates, controllers, persistence, and security configuration. Do not copy the legacy checkout into the runtime.
- Use a file-backed database below a newly created temporary directory. Refuse an in-memory, development, production, or non-temporary database path.
- Bind listeners to `127.0.0.1` and fail if the selected port is already occupied.
- Disable or sink Slack, SMS, email, Google, Gateway, and other external integrations. A successful test must not depend on external network access.
- Use deterministic fixture source files committed in the mono repository.
- A receipt names the runner and browser spec source references from the exact source manifest.
- One receipt can cover multiple steps only within one accepted journey.
- A shared Playwright artifact may support multiple receipts only when its named passing test executes each claimed journey.
- Do not treat source rows, API metadata, direct database writes, skipped tests, fixture HTTP stubs, or manually authored JSON as runtime journey evidence.
- Receipt generation is optional when no receipt environment variables are present; partial receipt configuration fails closed.
- Cleanup always stops child processes and deletes temporary databases, generated keys, caches, logs, uploads, and reports.

## Definition of done

- A named command runs the core Symfony browser suite from a clean checkout.
- All eight required core tests pass against a disposable current-server database.
- Applicant, contact, receipt, survey, and team-interest submissions each cross the rendered UI, controller, validation, and persistence boundary.
- Identity evidence includes successful authentication and an authenticated profile read.
- Files/media evidence includes a successful browser response for an actual rendered asset.
- The core runner emits eight schema-valid, canonical receipts for the exact accepted journey and step identifiers.
- Existing recruitment runners emit schema-valid receipts for the six accepted recruitment and equivalent self-service journeys listed above.
- A deterministic merge command produces one canonical runtime-evidence register and rejects duplicate receipt identifiers.
- A second run with identical source, fixtures, and browser results emits identical receipt bytes.
- The parity package type check and focused receipt tests pass.
- All named browser journeys pass.
- Exact-head parity reports zero unresolved journey coverage references and zero forbidden states attributable to runtime evidence.

## Falsifiers

- A test passes after replacing a form submit with a direct database insert.
- A public GET-only smoke test satisfies a write journey.
- A fixture HTTP stub satisfies the current Symfony journey.
- A skipped or empty Playwright report emits accepted evidence.
- A receipt covers a step from a different accepted journey.
- A runner emits a receipt for a journey whose named browser test did not run.
- A stale source revision, stale runner digest, missing source reference, or changed fixture satisfies coverage.
- The browser test sends real mail, Slack, SMS, or third-party traffic.
- The runner can point at a non-disposable database.
- Temporary credentials, local paths, browser output, timestamps, or database contents appear in canonical receipt bytes.
- Two input registers containing the same receipt identifier with different content merge successfully.
