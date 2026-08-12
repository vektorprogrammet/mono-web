# Live design spec 0002 — Symfony clean-checkout bootstrap

> **Summary:** One maintainer journey proving that a fresh `mono-web` checkout can install the locked Symfony dependencies under PHP 8.4, boot and analyse the server with deterministic CI-only inputs, validate ORM metadata on the existing SQLite test boundary, and run the complete discovered PHPUnit suite. The suite's known application failures remain an explicit red baseline. This is not green clean-checkout CI, a migration replay, a MySQL proof, or a production action.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0002` |
| Status | `accepted` — current implementation/evidence is Building-complete and pre-freeze at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`; this is not Experienceable, Conforming, or the charter's green clean-checkout CI gate. PHPUnit status `2`, lint `8`, and analyse `1` remain downstream remediation holds; historical `98edecd` remains non-conforming Drift |
| Lifecycle position | Building-complete / pre-freeze — runtime receipt and identity disposition are preparatory gate evidence only |
| Experienceable/Conforming gate | Not entered; no feature-lead freeze, one-to-one PR, operator-authorized hosted effect, or blind-first verification is claimed |
| Source/workflow evidence | HEAD `0dfa6b96d8f57f63da149576919b943468387587` |
| Runtime evidence | `agent://SymfonyDynamicVerifier` — sanitized bounded-bootstrap receipt |
| Independent identity disposition | PASS — `agent://CleanWorkflowCodeReview` |
| Owner | CI/migration-foundation feature lead; the product lead remains read-only to production code |
| Intended implementation lane | Stage 1 — Symfony clean-checkout bootstrap evidence |
| Base checkpoint | `mono-web` commit `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` |
| Created | `2026-08-10` |
| Journey count | One maintainer journey; one future implementation PR |
| Live-spec path | `mono-web/design-specs/0002-symfony-clean-checkout-bootstrap.md` |

This document records accepted intent and a Building-complete, pre-freeze bootstrap receipt at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`. It does not authorize a workflow push, PR, deployment, credential use, database action, migration, or production change. Experienceable and Conforming have not been entered: Experienceable requires feature-lead freeze of this accepted spec as a one-to-one PR opens under recorded operator authority with objective journey evidence, and Conforming requires blind-first review of the frozen spec, implementation, and objective evidence before rationale with no linked Drift.

## Goal, constraints, and values

### Goal

Give a maintainer a repeatable clean-checkout checkpoint for the Symfony line. Starting from the named base commit, the maintainer must be able to install the lockfile, provide only deterministic non-secret CI inputs, create a disposable JWT key pair, boot Symfony, run the existing lint/analyse/schema-metadata commands, and let the full PHPUnit suite finish. The result must state the application-test baseline honestly instead of turning a red suite into a green-looking infrastructure result.

### Constraints

- Pin the CI PHP runtime to **8.4**, matching the `php >=8.4` Composer platform contract in [`apps/server/composer.json`](../apps/server/composer.json#L19-L21), the lockfile platform in [`apps/server/composer.lock`](../apps/server/composer.lock#L13732-L13739), and [`apps/server/Dockerfile`](../apps/server/Dockerfile#L1-L13). The current workflow's PHP 8.5 value is an observed baseline mismatch, not the target of this accepted spec.
- Install the exact committed Composer lock with `composer install --no-progress --prefer-dist --optimize-autoloader` from `apps/server`. Never run `composer update`, rewrite `composer.lock`, or silently select a different dependency graph.
- Use the current CI extension set (`xml, ctype, iconv, intl, pdo_sqlite, dom, filter, gd, mbstring, sqlite3`) unless the named Composer/Docker evidence proves a required 8.4 correction. `pdo_mysql`, a MySQL service, and a persistent database are outside this journey.
- Supply values at the CI process boundary. Do not commit `.env`, `.env.local`, any other environment file, a secret, or a key. Existing tracked [`apps/server/.env.test`](../apps/server/.env.test) and the loaded Symfony configuration are the authorities; [`apps/server/.env.staging`](../apps/server/.env.staging) is not a CI template and must not be copied.
- Generate the JWT pair only in the existing ignored `apps/server/config/jwt/*.pem` paths. The pair is disposable test material, not a production credential. It must be removed on success and failure and must never enter an evidence artifact. The GitHub Actions implementation MAY use one shell spanning generation through `composer test` with an `EXIT` trap, or separate steps ending in a terminal cleanup/evidence step guarded by `if: always()`; the latter is permitted only for cleanup/evidence and must preserve the original test/job conclusion, unlike `continue-on-error`.
- Keep the test boundary as it exists: [`config/packages/test/doctrine.yaml`](../apps/server/config/packages/test/doctrine.yaml#L1-L17) selects in-memory SQLite, and [`tests/bootstrap.php`](../apps/server/tests/bootstrap.php#L17-L34) creates that test schema and loads fixtures. This is test bootstrap evidence only.
- Run the complete suite selected by [`phpunit.xml.dist`](../apps/server/phpunit.xml.dist#L16-L43), including `tests/App/`. No filter, suite exclusion, stop-on-first-failure, mutation of the test configuration, or `continue-on-error` may hide a result.
- The observed clean-checkout red baseline is exact for the static/bootstrap facts and must be reported without hiding status: PHP `8.4.23`/Composer `2.10.2` with locked install; the first observed warmup blocker was missing ignored `var/data` for dev SQLite, and a prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after `mkdir -p var/data`; any future post-`mkdir` warmup failure remains a fail-closed bootstrap falsifier; `composer lint` exits `8` with `217/752` files fixable; `composer analyse` exits `1` with `10` errors; and SQLite metadata validation exits `0`. PHPUnit result tuples are observation snapshots, not parser acceptance constants; record both [PHPUnit observation snapshots](#phpunit-observation-snapshots) and apply their structural invariants.
- This journey must not run `doctrine:migrations:*`, inspect or repair migration source, execute `doctrine:schema:create` as a migration substitute, use MySQL, touch operational data, or invoke deployment/provider paths. Full MySQL Doctrine replay is a separate downstream live spec.
- A product lead accepted this intent while remaining read-only to production code. A future writer changes only the named workflow path in an isolated worktree after acceptance and independent review.

### Values

- **Truth before green:** infrastructure success and application-test success are separate claims; a non-zero PHPUnit result is reported, not hidden.
- **Least authority:** no production credentials, provider, database, data, deployment, or remote effect is needed for this local/CI bootstrap path.
- **Canonical configuration:** reuse tracked test defaults and loaded `%env(...)%` references; add only the missing CI sentinels that the current dev/test container actually resolves.
- **Determinism:** pin the runtime family, lockfile, commands, environment names, SQLite boundary, and key lifecycle. Do not depend on a maintainer's local `.env` or ignored files.
- **Disposable state:** JWT files, Composer cache, Symfony cache, SQLite memory, and JUnit output are run artifacts. They are never authority and never committed.
- **One journey, one boundary:** this spec proves clean Symfony bootstrap and the honest suite baseline. It does not make claims about migration replay, domain correctness, deployment, or product parity.

## Current behavior and baseline

The observations below are grounded in the named base checkpoint and the status/handoff snapshots. The snapshots route the reader to the current facts; they do not replace the lifecycle or charter authorities.

| Area | Current observation at the base | Authority/evidence |
|---|---|---|
| CI runtime | The PHP job uses PHP `8.5`, the extension list above, Composer v2, lockfile install, `composer lint`, `cache:warmup --env=dev --no-optional-warmers` with only a dummy MySQL `DATABASE_URL`, `composer analyse`, test-environment `doctrine:schema:validate --skip-sync`, cache removal, and `composer test`. It has no MySQL service, no `pdo_mysql`, no `.env` provisioning, and no JWT generation. | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L38-L98) |
| Runtime contract and observation | Composer requires PHP `>=8.4`; the lock records the same platform; the server Docker image is PHP 8.4. The clean-checkout observation used PHP `8.4.23` and Composer `2.10.2` and installed the committed lock. The first observed warmup blocker was missing ignored `var/data` required by the dev SQLite path; no environment, JWT, or kernel failure was observed before that blocker. A prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after `mkdir -p var/data`; any future post-`mkdir` warmup failure remains a bootstrap falsifier. | [`composer.json`](../apps/server/composer.json#L19-L21), [`composer.lock`](../apps/server/composer.lock#L13732-L13739), [`Dockerfile`](../apps/server/Dockerfile#L1-L13), sanitized runtime observation in the branch-tip handoff |
| Environment | A clean checkout has no tracked `.env`. `.env.test` contains `APP_ENV=test`, `APP_DEBUG=1`, `CORS_ALLOW_ORIGIN='*'`, `DATABASE_URL=sqlite:///:memory:`, a test-only `APP_SECRET`, and an empty JWT passphrase. The services container also resolves named placeholders not present in `.env.test`, including the disabled integration values listed in [CI-only environment authority](#ci-only-environment-authority). | [`.env.test`](../apps/server/.env.test#L1-L7), [`config/services.yaml`](../apps/server/config/services.yaml#L1-L22), [`config/services.yaml`](../apps/server/config/services.yaml#L149-L168), [`config/packages/framework.yaml`](../apps/server/config/packages/framework.yaml#L1-L6), [`config/packages/lexik_jwt_authentication.yaml`](../apps/server/config/packages/lexik_jwt_authentication.yaml#L1-L5), [`config/packages/nelmio_cors.yaml`](../apps/server/config/packages/nelmio_cors.yaml#L1-L18) |
| JWT material | `config/jwt/*.pem` is ignored by [`apps/server/.gitignore`](../apps/server/.gitignore#L37-L46). A fresh checkout has no reproducible key material and the CI job has no generation step. The existing container recipe generates a pair, but its entrypoint also performs `schema:create` and fixture work, so the whole entrypoint is not a valid CI command for this spec. | [`.gitignore`](../apps/server/.gitignore#L37-L46), [`docker/entrypoint.sh`](../apps/server/docker/entrypoint.sh#L6-L33) |
| PHPUnit discovery | `phpunit.xml.dist` uses an exclusion-based `unit` suite over `tests/`, so `tests/App/` is discovered alongside the controller, availability, and API suites. `composer test` writes `var/test-results.xml` and returns PHPUnit's result status. | [`phpunit.xml.dist`](../apps/server/phpunit.xml.dist#L16-L43), [`composer.json`](../apps/server/composer.json#L103-L115) |
| Historical snapshot baseline | The earlier F1+F2 status/handoff snapshot recorded `1,167` tests, `54` failing methods, and zero `tests/App/` failures. That observation is historical and non-SQLite-compatible for this gate; it must not replace the current clean-checkout runtime baseline below. | [`docs/status-2026-08-10.md`](../../docs/status-2026-08-10.md#L158-L180), [`docs/handoff-2026-08-10.md`](../../docs/handoff-2026-08-10.md#L89-L110) |
| Current static/test baseline | The observed `composer lint` status is `8` (`217/752` files fixable); `composer analyse` status is `1` with `10` errors; SQLite metadata validation status is `0`; PHPUnit observations are the prior accepted run and the two identical `8a16ea9` runs recorded in [PHPUnit observation snapshots](#phpunit-observation-snapshots), not a fixed assertions/failures/errors/status gate. | Sanitized `2026-08-10` runtime observations in the branch-tip handoff; no repository evidence file |
| Current pre-freeze artifact receipt | Source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`; runtime `agent://SymfonyDynamicVerifier`; identity disposition `agent://CleanWorkflowCodeReview` PASS | PHP `8.4.23`/Composer `2.10.2`, locked install `0`, JWT/mkdir/warmup `0`, lint `8`, analyse `1`, metadata `0`, PHPUnit status `2` with terminal result at `206s`, parser evidence status `0`, exact 58 identities, `App\\Tests\\App\\` bucket `0`, warnings/skipped/incomplete/risky `0`, cleanup `0`, and Git clean. |
| SQLite test boundary | Test Doctrine hardcodes `pdo_sqlite` and `:memory:`. The test bootstrap creates schema and fixtures directly before tests; it does not execute migrations. `schema:validate --skip-sync --env=test` exits `0` in the observed run and checks ORM metadata, not migration reproduction. | [`config/packages/test/doctrine.yaml`](../apps/server/config/packages/test/doctrine.yaml#L1-L17), [`tests/bootstrap.php`](../apps/server/tests/bootstrap.php#L17-L34) |
| Migration boundary | The real migration gate is blocked: 49 files use the Migrations 1.x `Doctrine\\DBAL\\Migrations\\AbstractMigration` import while the lock installs Doctrine Migrations 3.9.5, and the recorded-version namespace also needs reconciliation. `doctrine_migrations.yaml` maps only `App\\Migrations`; the newest migration is MySQL-only and has non-transactional DDL. | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L80-L90), [`composer.lock`](../apps/server/composer.lock#L1367-L1389), [`config/packages/doctrine_migrations.yaml`](../apps/server/config/packages/doctrine_migrations.yaml#L1-L3), [`migrations/Version20170913114609.php`](../apps/server/migrations/Version20170913114609.php#L1-L29), [`migrations/Version20260810002046.php`](../apps/server/migrations/Version20260810002046.php#L1-L164) |
| Other boot paths | Local and Railway entrypoints use `doctrine:schema:create` and fixtures; they are not replay evidence. `deploy.sh` runs the migration command and exits 0 unconditionally, so its log cannot prove a successful migration. | [`docker/entrypoint.sh`](../apps/server/docker/entrypoint.sh#L17-L33), [`docker/railway-boot.sh`](../apps/server/docker/railway-boot.sh#L17-L34), [`deploy.sh`](../apps/server/deploy.sh#L16-L20) |

### Baseline interpretation

The clean-checkout observation is currently **red in three downstream remediation sets**; SQLite metadata is green in the observed run, and a prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after `mkdir -p var/data` following the first missing-path blocker. Any future post-`mkdir` warmup failure remains a fail-closed bootstrap falsifier. Lint is red at status `8` with `217/752` files fixable. Analyse is red at status `1` with `10` errors. PHPUnit result tuples are recorded as snapshots, not acceptance constants; the stable evidence contract is the structural set below. Any nonzero PHPUnit application result remains honest downstream remediation and preserves the final job's red status.

The earlier `1,167`/`54`/zero-`tests/App/` snapshot is historical and non-SQLite-compatible evidence, not this gate's baseline. Counts alone never establish identity equality: the future evidence must retain sanitized failure identities and require independent review for any changed identity, even when counts match.
### PHPUnit observation snapshots

These are observed runtime facts, not parser or evidence acceptance constants. The PHP source and workflow content were byte-identical across the comparison. The cause of the changed assertion/failure/error tuple is unproven; this spec claims no nondeterminism mechanism.

| Snapshot | Observation | Treatment |
|---|---|---|
| Prior accepted run | `1,167` tests, `3,156` assertions, `55` failures, `3` errors, status `2`; a complete run observed wall time `221s` | Historical observation only; retain as sanitized evidence context, not a required tuple. |
| Two repeated clean runs on integration candidate `8a16ea9` | Each run: `1,167` tests, `3,160` assertions, `52` failures, `2` errors, status `2`; failure/error identity sets were identical | Historical observation only; retain the tuple and identities, do not infer a cause or determinism mechanism, and do not let this snapshot override the current structural evidence. |
| Default Composer timeout attempt | `300s` process timeout at `732/1,167`, status `1`, no JUnit | Runtime Drift and falsifier; no result may be inferred from partial progress. |

The stable PHPUnit evidence contract is structural: the full unfiltered suite reaches a terminal summary and JUnit; console and JUnit agree; discovered tests do not fall below the reviewed floor of `1,167` without an independent disposition (increases are recorded, not Drift by themselves); the filesystem `tests/App/` bucket identified only by the exact namespace prefix `App\\Tests\\App\\` has zero failures and errors; warnings, skipped, incomplete, and risky remain zero; every failure/error identity and the original PHPUnit command status is emitted in sanitized evidence; and no status is hidden or overridden. A future status `0` is allowed only when console/JUnit are actually green and the static steps also decide the job state. Identity changes require independent review evidence, not parser failure.

This accepted spec intentionally does **not** satisfy the charter's green clean-checkout CI gate. The three red sets are downstream remediation holds before that gate passes, not blockers to this bounded bootstrap implementation. No failed status may be hidden, relabeled, or used as migration evidence.

## Intended behavior

After an accepted implementation realizes this intent:

1. The PHP job runs PHP 8.4 with the current SQLite-oriented extension set, sets the outer workflow cap explicitly to `timeout-minutes: 20`, and records the runtime version and extensions without exposing environment values.
2. Composer installs exactly from `apps/server/composer.lock` using the existing install command. The lockfile and source tree remain unchanged by installation.
3. The workflow supplies a small process-only map. Values inherited from `.env.test` remain canonical; only the missing placeholders required by the loaded dev/test service graph receive deterministic CI sentinels. No `.env` is created.
4. The workflow generates an encrypted private JWT key and its public pair in `apps/server/config/jwt/`, using the existing entrypoint recipe's algorithm and the CI-only passphrase. The generated files are ignored, are not printed or uploaded, and are removed through the chosen cleanup shape: a single-shell `EXIT` trap or a terminal cleanup/evidence step with `if: always()` that preserves the original test/job conclusion.
5. Before warmup, the workflow creates the ignored dev-SQLite directory with `mkdir -p var/data`. `php bin/console cache:warmup --env=dev --no-optional-warmers` must then boot Symfony successfully with the supplied process environment; the first observed blocker was the missing `var/data` path, and a prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after the `mkdir`. Any future post-`mkdir` warmup exit status other than zero is a bootstrap falsifier.
6. `composer lint` and `composer analyse` run as separate status-preserving steps after warmup. `composer analyse` consumes the step-6 dev-debug container dump produced by cache warmup and MUST remain after warmup and before cache removal. The current red baselines are lint status `8` with `217/752` files fixable and analyse status `1` with `10` errors; each is evidenced, not hidden. If a prior static step fails, later mandatory evidence steps MAY use `if: ${{ !cancelled() }}`; every failed command remains failed and the final job remains red. `if: always()` is cleanup-only.
7. `php bin/console doctrine:schema:validate --skip-sync --env=test` runs against the existing in-memory SQLite test configuration and must exit `0`. This is metadata validation only; it is not a schema creation or migration replay claim.
8. After clearing generated cache immediately before tests, the exact unfiltered `composer test` script runs without filters or early-stop options and reaches the complete PHPUnit summary and JUnit output. It must satisfy the structural contract in [PHPUnit observation snapshots](#phpunit-observation-snapshots), not a hardcoded assertions/failures/errors/status tuple: keep the reviewed `1,167` discovered-test floor unless an independent disposition records a lower count; record increases without treating them as Drift; require console/JUnit agreement; require zero failures/errors in the exact `App\\Tests\\App\\` filesystem bucket; require zero warnings/skipped/incomplete/risky; emit every failure/error identity and preserve the original command status. For this PHPUnit step only, set process env `COMPOSER_PROCESS_TIMEOUT=900`, bounded below the new PHP-job `timeout-minutes: 20` outer cap; terminal cleanup/evidence remains responsible for cleanup, and the command remains exactly `composer test`. Any nonzero application result remains honest downstream remediation and keeps the final job red. A future status `0` is allowed only when console/JUnit are actually green and the static steps also decide the job state. The prior and `8a16ea9` tuples remain snapshots, not acceptance constants. A later mandatory evidence step MAY use `if: ${{ !cancelled() }}`; `if: always()` remains cleanup-only.
9. The workflow prints a sanitized summary with exact statuses, counts, and failure/error identities. Its console parser must extract each labeled field independently using a matcher robust to either line start or comma-plus-space, for example `(?m)(?:^|,\\s*)Errors:\\s+(?<errors>[0-9]+(?:,[0-9]{3})*)` and `(?m)(?:^|,\\s*)Failures:\\s+(?<failures>[0-9]+(?:,[0-9]{3})*)`, rather than assuming an `Errors`/`Failures` order or requiring labels at line start. Apply the same independent form to `Tests`, `Assertions`, `Warnings`, `Skipped`, `Incomplete`, and `Risky`; normalize thousands separators. Missing, malformed, duplicate, or positionally misread labels are `Drift` and a nonzero evidence result. Structural completeness, console/JUnit agreement, the reviewed discovered-test floor, exact `App\\Tests\\App\\` zero-failure/error classification, zero warnings/skipped/incomplete/risky, sanitized identities, and preserved command status are the acceptance facts. Snapshot tuple differences and identity changes are observations requiring independent review, not parser falsehoods; this spec claims no cause for the `8a16ea9` difference. It must classify filesystem `tests/App/` only by the exact namespace prefix `App\\Tests\\App\\`, never by the broad `Tests\\App\\` substring. The prior and repeated current tuples are recorded exactly in [PHPUnit observation snapshots](#phpunit-observation-snapshots). Counts alone never claim baseline equivalence.
10. Cleanup removes generated JWT files, Symfony cache, `var/data`, temporary SQLite/var artifacts, and any sanitized local report as appropriate through the selected single-shell `EXIT` trap or terminal `if: always()` cleanup/evidence step. No key, environment file, source change, migration output, or production data remains in the checkout.

## CI-only environment authority

The future workflow must **reference and generate from these existing authorities**, not copy an omnibus staging or production environment. The values below are deterministic non-secret sentinels for a CI process; they are not credentials and must not be placed in a repository file.

### Values inherited or deliberately overridden from the test authority

| Name | CI value/phase | Authority and reason |
|---|---|---|
| `APP_ENV` | `dev` for cache warmup; `test` for metadata validation and PHPUnit | Symfony command environment; `.env.test` is the tracked test default. Never use `prod` in this journey. |
| `APP_DEBUG` | `1` | `.env.test`; retained for test boot diagnostics without production behavior. |
| `APP_SECRET` | `test_app_secret_for_testing_only` | `.env.test` and `config/packages/framework.yaml`; fixed non-secret test sentinel. |
| `CORS_ALLOW_ORIGIN` | `*` | `.env.test` and `config/packages/nelmio_cors.yaml`; no external origin is exercised. |
| `DATABASE_URL` | `sqlite:///:memory:` | `.env.test` and `config/packages/doctrine.yaml`; test Doctrine overrides the driver/path in `config/packages/test/doctrine.yaml`. This value must not be changed to MySQL in this slice. |
| `JWT_PASSPHRASE` | `ci-only-jwt-passphrase` | `config/packages/lexik_jwt_authentication.yaml` plus the ignored-key generation step. It intentionally overrides `.env.test`'s empty value and is not a production secret. |
| `COMPOSER_PROCESS_TIMEOUT` | `900` only in the PHPUnit process; unset for install, warmup, lint, analyse, and metadata | Composer process-timeout control. This bounded value addresses the observed default `300s` timeout, remains below the new PHP-job `timeout-minutes: 20` outer cap, leaves terminal cleanup/evidence responsibility in place, and does not alter the exact `composer test` command. |

### Missing loaded placeholders that need CI sentinels

The base `config/services.yaml` resolves these names even when the integration is disabled. The workflow must set them to inert deterministic values, with the disable flags true and no network call:

| Names | CI value shape | Authority |
|---|---|---|
| `GOOGLE_API_CLIENT_ID`, `GOOGLE_API_CLIENT_SECRET`, `GOOGLE_API_REFRESH_TOKEN` | `ci-disabled` | `config/services.yaml` `google_api`; its `disabled: true` flag remains authoritative for dev/test. |
| `LOG_CHANNEL` | `ci` | `config/services.yaml` `slack.log_channel`. |
| `SLACK_DISABLED` | `true` | `config/services.yaml` `slack.disable_delivery`. |
| `SLACK_ENDPOINT` | `http://127.0.0.1:9/disabled` | `config/services.yaml` `SlackMessenger`; loopback-only sentinel, never a real hook. |
| `GATEWAY_API_TOKEN` | `ci-disabled` | `config/services.yaml` `gateway_sms.api_token`. |
| `SMS_DISABLE` | `true` | `config/services.yaml` `gateway_sms.disable_delivery`. |
| `DEFAULT_FROM_EMAIL`, `ECONOMY_EMAIL`, `DEFAULT_SURVEY_EMAIL` | `ci@example.invalid` | `config/services.yaml` email/survey constructor arguments; `.invalid` prevents delivery. |
| `IPINFO_TOKEN` | `ci-disabled` | `config/services.yaml` `GeoLocation`; no geolocation request is permitted. |
| `GEO_IGNORED_ASNS` | `[]` | `config/services.yaml` `json:` processor; valid empty JSON is required. |

`RECAPTCHA_PUBLIC_KEY` and `RECAPTCHA_PRIVATE_KEY` are referenced only by the prod/staging EWZ configuration, which this dev/test journey does not load. `MAILER_DSN` and unrelated provider/storage names are not current loaded placeholders in the cited dev/test graph. The future writer must not invent or copy them. If a source configuration change makes another placeholder required, the workflow must fail closed and this spec must receive a product-lead-reviewed revision rather than silently growing an environment list.

No value in this section may come from GitHub secrets, a developer's home environment, a production/staging `.env`, a provider account, or operational data. The workflow must not print the process environment. Evidence records variable names and sentinel classification, not secret-like values or key contents.

## Deterministic JWT key lifecycle

The existing [`docker/entrypoint.sh`](../apps/server/docker/entrypoint.sh#L6-L12) is the algorithm reference, not a command to run: invoking the complete entrypoint would select `schema:create` and fixtures, which is outside this slice.
GitHub Actions may realize this lifecycle in either of two bounded shapes:

1. One shell spans key generation through `composer test` and registers an `EXIT` trap before writing keys.
2. Generation and checks use separate steps, followed by one terminal cleanup/evidence step with `if: always()`.

In the second shape, `if: always()` is permitted only for cleanup/evidence. It must preserve the captured PHPUnit status and the final job conclusion; it is not a test bypass and MUST NOT be used like `continue-on-error`.

The future CI step must:

1. Start from a fresh disposable checkout and assert that `apps/server/config/jwt/private.pem` and `public.pem` are not tracked or pre-existing. A stale ignored key in a reused worktree is a failed precondition; do not inspect or reuse it.
2. Set the non-secret `JWT_PASSPHRASE` from the process map above. Generate an RSA private key encrypted with that passphrase and derive the public key using the same OpenSSL recipe as the existing entrypoint. Suppress key material and passphrase output.
3. Keep the pair only under `apps/server/config/jwt/`; set restrictive private-key permissions; verify that both expected files exist and form a pair without printing their bytes or hashes.
4. In the one-shell shape, register an `EXIT` trap before generation that removes both generated PEM paths and any temporary key files, whether cache warmup, lint, analysis, metadata validation, or PHPUnit fails. In the multi-step shape, configure the terminal cleanup/evidence step with `if: always()` to remove the same paths and retain the original test/job conclusion. Do not upload the paths as CI artifacts.
5. After cleanup, assert absence of the generated PEM paths. A leftover key is a falsifier. A committed PEM, a key loaded from an operator secret, or a key copied from staging/production is an immediate `Drift` and security stop.

The key bytes are intentionally non-deterministic; the **lifecycle** is deterministic: same ignored paths, same non-secret passphrase source, same pair-generation algorithm, same no-output rule, and the same cleanup contract (single-shell `EXIT` trap or terminal `if: always()` cleanup/evidence step) on every exit path. No JWT token issuance, login journey, or authentication claim is part of this spec.

## Exact maintainer journey

One maintainer completes this one journey from a clean checkout of `mono-web` at the base checkpoint. The commands below are the evidence targets. The earlier implementation at `mono-web-clean-checkout-bootstrap-impl-20260810` commit `98edecd` remains a historical non-conforming artifact in `Drift`; the current bounded Building-complete, pre-freeze artifact is recorded separately at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`.

1. **Establish the checkpoint and clean boundary.** Start from `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` in a dedicated worktree. Confirm that no source, `.env`, PEM, provider credential, production data, or persistent database is supplied. The future PHP job must set the outer `timeout-minutes: 20` cap; do not read ignored secret-like files to decide whether the checkout is clean.
2. **Set up PHP 8.4.** Use the CI's existing `shivammathur/setup-php` shape with `php-version: "8.4"`, Composer v2, and the current extension list. Record the observed `php 8.4.23` and `Composer 2.10.2` (or a product-lead-reviewed 8.4-compatible equivalent) and a module check showing the required extensions. Do not add `pdo_mysql` or a MySQL service.
3. **Create the process-only environment.** Apply the values in [CI-only environment authority](#ci-only-environment-authority) to the job/command environment. Do not create `apps/server/.env`, modify `.env.test`, copy `.env.staging`, or print the environment. Use `APP_ENV=dev` for the warmup and `APP_ENV=test` for the metadata/test phases.
4. **Install the lock.** From `apps/server`, run exactly:

   ```sh
   composer install --no-progress --prefer-dist --optimize-autoloader
   ```

   The evidence must identify the committed lockfile and the successful install. Registry traffic needed to acquire locked packages is dependency-install traffic; it is not provider, production, or data access.

5. **Generate and guard JWT files.** Run the [deterministic JWT key lifecycle](#deterministic-jwt-key-lifecycle) after installation and before any Symfony console boot. Use either one shell with an `EXIT` trap spanning generation through `composer test`, or separate steps with a terminal `if: always()` cleanup/evidence step; in the latter shape, preserve the original test/job conclusion.
6. **Create the dev SQLite directory and warm the cache.** With the dev process environment, create only the ignored directory required by the existing dev Doctrine path, then run:

   ```sh
   mkdir -p var/data
   php bin/console cache:warmup --env=dev --no-optional-warmers
   ```

   The first observed fresh-checkout warmup blocker was missing `var/data`; a prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after `mkdir -p var/data`. Any future post-`mkdir` warmup failure, missing env, missing keys, invalid passphrase, kernel/container failure, or unexpected database/provider connection remains a bootstrap falsifier, not an application-test baseline.

7. **Run static checks as status-preserving steps.** Run the existing scripts separately and without changing their meaning:

   ```sh
   composer lint
   composer analyse
   ```

   The observed baseline is lint status `8` with `217/752` files fixable and analyse status `1` with `10` errors. Each command's original status must remain failed. If the lint step fails, a later mandatory evidence step MAY use GitHub `if: ${{ !cancelled() }}` so analysis, metadata, tests, and summary collection still run; do not use `continue-on-error`. `composer analyse` consumes the step-6 dev-debug container dump from cache warmup and MUST remain after warmup and before cache removal. `if: always()` remains cleanup-only.

8. **Validate ORM metadata on test SQLite.** With the test process environment, run exactly:

   ```sh
   php bin/console doctrine:schema:validate --skip-sync --env=test
   ```

   This command exited `0` in the observed run and must continue to pass against the existing in-memory SQLite configuration. If a static step failed, the metadata step MAY use `if: ${{ !cancelled() }}`; its own status remains authoritative. The evidence must show the test configuration's SQLite metadata path. Do not start a MySQL service, set a MySQL URL, run `doctrine:migrations:status`, run `doctrine:migrations:migrate`, run `doctrine:migrations:diff`, or call `doctrine:schema:create` as a replay substitute.

9. **Clear generated cache immediately before tests.** Keep `composer analyse` after warmup because it consumes the step-6 dev-debug container dump, and keep cache removal immediately before `composer test`:

   ```sh
   rm -rf var/cache
   ```

   This removes ignored generated cache only; it does not delete `var/data` before the static evidence is complete, source, `.env`, keys outside the generated paths, or any operational data.

10. **Run the complete suite and preserve its status.** For this PHPUnit step only, set process env `COMPOSER_PROCESS_TIMEOUT=900` (below the new PHP-job `timeout-minutes: 20` outer cap and leaving terminal cleanup/evidence responsibility in place), then run the Composer script exactly as defined in [`composer.json`](../apps/server/composer.json#L103-L115):

    ```sh
    composer test
    ```

    A prior accepted run and two repeated clean `8a16ea9` runs are recorded as observation snapshots in [PHPUnit observation snapshots](#phpunit-observation-snapshots); their differing assertion/failure/error tuples are not expected parser constants. With the PHPUnit-only `COMPOSER_PROCESS_TIMEOUT=900`, the command must reach completion and produce a terminal summary plus JUnit satisfying the structural contract: at least the reviewed `1,167` discovered tests unless independently disposed, console/JUnit agreement, zero `App\\Tests\\App\\` failures/errors, zero warnings/skipped/incomplete/risky, every failure/error identity emitted, and the original PHPUnit status preserved. The runner may capture that actual status for cleanup, artifact collection, and later evidence, but MUST NOT convert a nonzero application result to success; such a result remains downstream remediation and keeps the final job red. A future status `0` is allowed only when console/JUnit are actually green and static steps also decide the job state. A timeout, missing summary, missing JUnit, or partial progress never supplies a result. A later mandatory evidence step MAY use `if: ${{ !cancelled() }}`; it must not use `|| true`, `continue-on-error`, `--filter`, `--testsuite` narrowing, `--exclude`, or early-stop flags. `if: always()` is cleanup-only.

11. **Classify and print the result safely.** Record exact command status (whatever PHPUnit returned), duration as an observation rather than a gate, full discovered count, every failure/error identity, the JUnit path, and whether any environment/JWT/kernel/bootstrap error occurred. A Composer timeout, absent summary/JUnit, below-floor discovery without independent disposition, nonzero `App\\Tests\\App\\` failure/error count, missing warning/skipped/incomplete/risky fields, or partial progress (including `732/1,167`) is a falsifier; infer no result from it. Snapshot tuple differences are recorded facts, not parser failure, and identity changes are review-required evidence. The prior accepted snapshot (`3,156` assertions, `55` failures, `3` errors) recorded these three error identities:

    - `Tests\\App\\Controller\\ReceiptControllerTest::testEdit`
    - `Tests\\App\\Controller\\SchoolAdminControllerTest::testUpdateSchool`
    - `Tests\\App\\Controller\\SchoolAdminControllerTest::testShowSpecificSchool`

    The repeated clean `8a16ea9` runs each had exactly two errors, both SchoolAdmin errors (`Tests\\App\\Controller\\SchoolAdminControllerTest::testUpdateSchool` and `Tests\\App\\Controller\\SchoolAdminControllerTest::testShowSpecificSchool`); `Tests\\App\\Controller\\ReceiptControllerTest::testEdit` was absent from those error identities. That recorded identity difference is the observation in D-0002-10; do not infer a cause.

    Parse each labeled summary field independently using a matcher robust to either line start or comma-plus-space, for example `(?m)(?:^|,\\s*)Tests:\\s+(?<tests>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Assertions:\\s+(?<assertions>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Errors:\\s+(?<errors>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Failures:\\s+(?<failures>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Warnings:\\s+(?<warnings>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Skipped:\\s+(?<skipped>[0-9]+(?:,[0-9]{3})*)`, `(?m)(?:^|,\\s*)Incomplete:\\s+(?<incomplete>[0-9]+(?:,[0-9]{3})*)`, and `(?m)(?:^|,\\s*)Risky:\\s+(?<risky>[0-9]+(?:,[0-9]{3})*)`. Do not assume that `Errors` precedes `Failures` or parse counts positionally. Treat a missing, malformed, duplicate, or positionally misread label as `Drift` and a nonzero evidence result. The parser/evidence decision is based on structural completeness and agreement, not exact snapshot tuple. Classify the filesystem `tests/App/` bucket only by the exact namespace prefix `App\\Tests\\App\\`; a broad `Tests\\App\\` match must not count those tests as that bucket. Console and JUnit must agree; discovered tests below `1,167` require independent disposition, increases are recorded but do not by themselves open Drift; zero `App\\Tests\\App\\` failures/errors and zero warnings/skipped/incomplete/risky are required. All failure/error identities and the actual original PHPUnit command status are emitted sanitized. Identity changes require independent review evidence, not parser failure. The three red static/application sets remain downstream remediation before the charter's green CI gate.

12. **Clean up and close the local journey.** Execute the selected cleanup path (single-shell `EXIT` trap or terminal `if: always()` cleanup/evidence step), confirm generated PEMs are absent, discard ignored `var/cache`, `var/data`, and Composer artifacts, and retain only sanitized evidence. Do not run any deployment, provider, MySQL, migration, data, or remote action.

## Scope and allowed implementation paths

The future bounded writer may change only:

- `mono-web/.github/workflows/ci.yml` — the CI PHP job's PHP 8.4 runtime pin, explicit outer `timeout-minutes: 20` cap, process-environment/key lifecycle, failure-preserving evidence handling, and cleanup/artifact conditions;
- generated ignored run state under `mono-web/apps/server/config/jwt/*.pem`, `mono-web/apps/server/var/**`, and Composer's ignored vendor/cache locations — disposable outputs only, never source authority.

The future writer must not change `apps/server/composer.json`, `composer.lock`, `.env.test`, `.env.staging`, `.gitignore`, `tests/bootstrap.php`, `phpunit.xml.dist`, any `src/`, `config/`, `migrations/`, Docker/compose/entrypoint/deploy file, or any repository documentation. The writer must not create a helper script, a committed environment template, a test baseline file, a PEM fixture, or a migration workaround. The only mutable source authority reserved for this lane is `.github/workflows/ci.yml`; another lane requesting that path creates a shared-resource conflict and must be serialized.

No generated artifact may be committed. No source path, database, provider, deployment, credential, or operational data is a mutable resource of this lane.

## Non-goals

This slice does **not** include:

- satisfying the charter's green clean-checkout CI gate;
- fixing, accepting, suppressing, or reclassifying the current red static sets and observed PHPUnit application-result snapshots (prior accepted `55` failures/`3` errors; repeated `8a16ea9` `52` failures/`2` errors); changing application tests, fixtures, test discovery, or PHPUnit configuration; or claiming that any nonzero application result is healthy;
- Doctrine migration source/API repair, namespace reconciliation, version recording, empty-database replay, `doctrine:migrations:diff`, MySQL, `pdo_mysql`, persistent volumes, schema changes, production/staging data, A2/A7 normalization, or rollback of a real database;
- any manual `doctrine:schema:create` outside the existing SQLite test bootstrap, or any claim that SQLite metadata validation proves migration reproduction;
- production/staging credentials, secrets, PII, operational database access, external mail/SMS/Slack/Google/geo calls, provider calls, deployment, release, route cutover, or remote actions;
- changes to `apps/server` source/config/Docker files, environment files, Composer manifests/lock, or test authority; the workflow is the only future source mutation;
- Cloudflare/Alchemy preview work, the separate Effect v4 Receipt compatibility lane, team/domain investigation, SDK/frontend work, or any dependency on preview branch `af069395`;
- a user/product journey, domain-law proof, API/SDK parity proof, security acceptance, migration release, or production readiness claim.

## Authority, domain, contract, and interface references

- **Current status snapshot:** [`docs/status-2026-08-10.md` F1+F2 outcome](../../docs/status-2026-08-10.md#L158-L180) records the historical `1,167`/`54` test baseline and clean-checkout env/JWT blocker. The current prior/repeated PHPUnit observations and their runtime Drift are recorded in [PHPUnit observation snapshots](#phpunit-observation-snapshots); no snapshot replaces the structural evidence contract.
- **Program authority:** [`docs/product-lead-charter.md` §§1, 5–7, 9–12](../../docs/product-lead-charter.md#5-ordered-program-and-parallel-lanes) names clean-checkout CI and full Doctrine replay as separate production gates, allows disjoint Stage-1 lanes after Stage 0, and keeps credentials/data/deploy authority with the operator.
- **Accepted architecture authority:** [`docs/decisions/0001-cloudflare-topology-and-migration-architecture.md` §§1–6](../../docs/decisions/0001-cloudflare-topology-and-migration-architecture.md#1-metadata-and-authority-boundary) accepts the Stage-0 topology but grants no provider, database, credential, deploy, or production authority. This Symfony bootstrap lane is independent of the Wrangler and later Alchemy preview checkpoints.
- **Lifecycle authority:** [`docs/agentic-development-lifecycle.md` §§4–6, §9](../../docs/agentic-development-lifecycle.md#4-lifecycle-graph-and-gates) owns status, live-spec body, gates, bounded capsules, evidence limits, Drift, and operator boundaries.
- **Current handoff snapshot:** [`docs/handoff-2026-08-10.md` blockers](../../docs/handoff-2026-08-10.md#L103-L110) records that missing clean-checkout environment and JWT generation block a truthful green claim. It is a pointer, not acceptance authority.
- **Runtime and Composer interfaces:** [`apps/server/composer.json`](../apps/server/composer.json#L19-L115), [`apps/server/composer.lock`](../apps/server/composer.lock#L1367-L1389), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L38-L98), [`apps/server/phpunit.xml.dist`](../apps/server/phpunit.xml.dist#L4-L58), and the server config paths named in [Current behavior and baseline](#current-behavior-and-baseline).
- **SQLite boundary:** [`config/packages/test/doctrine.yaml`](../apps/server/config/packages/test/doctrine.yaml#L1-L17) and [`tests/bootstrap.php`](../apps/server/tests/bootstrap.php#L17-L34) are the existing test setup authority. The test bootstrap's schema creation is not a migration interface.
- **Domain authority:** [`docs/domain-model.md`](../../docs/domain-model.md) remains unchanged. No domain law, bounded-context journey, or temporal/event law is exercised by this infrastructure checkpoint.

## Dependency and resource graph

```text
accepted Stage-0 ADR 0001
  → this spec independently reviewed and product-lead accepted
  → one writer in a dedicated worktree at 12c1f3
  → PHP 8.4 + current SQLite extensions
  → Composer lock install
  → process-only CI sentinels + disposable JWT pair
  → Symfony dev cache warmup
  → lint + PHPStan analysis
  → test-environment SQLite ORM metadata validation
  → complete PHPUnit suite
  → structural PHPUnit evidence: terminal summary + JUnit, console/JUnit agreement, discovered-test floor `1,167` unless independently disposed, exact `App\\Tests\\App\\` zero failures/errors, zero warnings/skipped/incomplete/risky, all identities/status emitted, original status preserved
```

| Resource/edge | Required shape | Boundary |
|---|---|---|
| Base | Exact commit `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` | A predecessor returning to `Specified`/`Building` pauses this lane and records the changed base in Drift. |
| Runtime | PHP 8.4 with the current CI extension list | PHP 8.5 is current CI behavior, not this target; no MySQL extension/service. |
| Dependency graph | `composer install --no-progress --prefer-dist --optimize-autoloader` from committed lock | No update, lock rewrite, or package substitution. |
| Environment | Process-only deterministic non-secret sentinels from canonical config | No committed `.env`, secrets, provider values, or production/staging data. |
| JWT | One generated pair under ignored `apps/server/config/jwt/` | No reusable/committed/prod key; cleanup on every exit. |
| Database | Existing test `pdo_sqlite`/`:memory:` configuration | No persistent DB, MySQL, `pdo_mysql`, migrations, schema replay, or operational data. |
| Test graph | `phpunit.xml.dist` discovers all tests, including `tests/App/` | No suite narrowing or hidden failure; enforce the reviewed `1,167` discovered-test floor unless independently disposed, record increases without treating them as Drift, classify filesystem `tests/App/` only by exact namespace prefix `App\\Tests\\App\\`, and require zero failures/errors in that bucket. |
| Shared mutable path | `.github/workflows/ci.yml` reserved by this lane | Other lane writers must not mutate it concurrently; generated outputs are disposable, not shared authority. |
| Independent lanes | Preview `0001`, Effect v4 Receipt, and team/domain evidence | No dependency on `af069395`, provider state, SDK source, or domain artifacts; each keeps a disjoint worktree/path boundary. |
| Downstream edge | Full MySQL Doctrine replay after migration loader/source and data decisions | Separate accepted spec and operator-owned evidence are required. This bootstrap cannot satisfy that edge. The replay hold does not block this bounded SQLite bootstrap. |
## Evidence and verification plan

The future writer must produce objective evidence from the accepted base and the exact journey. The evidence destination is the sanitized **Evidence** section of the future one-to-one PR. Without remote authority, retain the branch-tip task handoff only; do not add an evidence file to the repository.

| Evidence | Claim | Required limits |
|---|---|---|
| Base/worktree record | The writer started from the named commit in a dedicated worktree | Include commit/path/branch; do not claim another branch's evidence. |
| PHP setup transcript | PHP 8.4, the required extension set, and the PHP job's explicit `timeout-minutes: 20` outer cap were selected | Record observed PHP `8.4.23`, Composer `2.10.2`, the timeout setting, and extension names; no secret/environment dump. Missing 8.4, missing/non-20 `timeout-minutes`, or added MySQL support is a falsifier. |
| Composer install output | The committed lock installed successfully | Record command/status and lock identity; registry traffic is install-only. No `composer update`. |
| Environment map record | Symfony received only the named deterministic CI sentinels | Record names, phase, and inert/disabled classification; never print the environment or source secrets. |
| JWT lifecycle record | An ephemeral ignored pair enabled boot and was removed | Record path existence/pair verification and post-cleanup absence only; never retain key bytes, hashes, or passphrase. |
| Cache-warmup output | Symfony kernel/container can boot under the clean CI inputs | Record `mkdir -p var/data` followed by `cache:warmup --env=dev --no-optional-warmers` exiting `0`; the first observed blocker was missing dev SQLite `var/data`, and a prior implementation branch plus the combined `8a16ea9` verifier observed warmup pass after `mkdir -p var/data`. Any future post-`mkdir` warmup failure is a fail-closed bootstrap falsifier, not an application-test baseline. |
| Lint/analyse output | Existing `composer lint` and `composer analyse` execute without status hiding | Record lint status `8` with `217/752` files fixable and analyse status `1` with `10` errors; preserve each status, use `if: ${{ !cancelled() }}` only to run later mandatory evidence after a failure, and keep analyse after warmup/before cache removal. These are remediation holds, not green evidence. |
| Schema metadata output | ORM metadata validates against test SQLite configuration | Record `doctrine:schema:validate --skip-sync --env=test` status `0`; `--skip-sync --env=test` is metadata evidence only, with no schema-create/migration claim. |
| PHPUnit transcript + JUnit | The full discovered suite reached completion and its result is known | Record PHPUnit-only `COMPOSER_PROCESS_TIMEOUT=900`, terminal summary and JUnit, console/JUnit agreement, discovered count (floor `1,167` unless independently disposed; increases recorded but not Drift by themselves), zero `App\\Tests\\App\\` failures/errors, zero warnings/skipped/incomplete/risky, every failure/error identity, and the actual original PHPUnit command status. Include the prior accepted and repeated `8a16ea9` observation snapshots as context; their differing tuples are not acceptance constants. Wall duration is observational, not a fixed gate; a timeout, missing summary/JUnit, or partial progress is a falsifier. |
| Cleanup record | Generated local state was removed | Confirm generated PEM absence and discard ignored `var/cache`, `var/data`, and other run output. Do not inspect or delete unrelated environment files. |
| Scope review | Only the workflow source path changed | Generated outputs are ignored; any other source/document/config path is a capsule violation. |

### Current pre-freeze artifact receipt

The current bounded artifact is recorded at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`. Runtime evidence is `agent://SymfonyDynamicVerifier`; independent identity disposition is PASS in `agent://CleanWorkflowCodeReview`. This receipt and disposition are preparatory gate evidence for the Building-complete artifact, not an Experienceable or Conforming transition. The sanitized receipt records PHP `8.4.23`/Composer `2.10.2`, locked Composer install status `0`, JWT generation status `0`, `mkdir -p var/data` status `0`, corrected cache warmup status `0`, lint status `8`, analyse status `1`, SQLite metadata status `0`, exact PHPUnit command status `2` with a terminal result at `206s`, committed parser process status `0`, parser evidence status `0`, and cleanup status `0` with a clean worktree.

The terminal/JUnit observation is `1,167` tests, `3,156` assertions, `55` failures, `3` errors, and zero warnings, skipped, incomplete, or risky tests. The exact 58-entry failure/error identity set is byte-equal to the prior accepted list; both lists have SHA-256 `bb32c2853cb925c3c4d542be3d5d4475ddf2ecf70731b7d7e6006417b5889858`. The exact `App\\Tests\\App\\` bucket has zero failures and errors. This independently closes D-0002-10 on the identity axis only.

This Building-complete, pre-freeze artifact is bounded bootstrap evidence, not the charter's green clean-checkout CI gate: PHPUnit status `2`, lint status `8`, and analyse status `1` remain downstream remediation holds. Hosted CI was not run. Local Nix PHP extension differences, including temporary extension setup during an initial local install probe, are a nonblocking environment boundary rather than hosted-runtime evidence. The superseded pre-correction warmup probe (status `1`, missing `session`) is retained as a nonblocking observation; the corrected run exited `0`. The `8a16ea9` `3,160`/`52`/`2` snapshot remains historical, its cause is unproven, and no determinism claim is made. Wall time is observational, not a fixed gate.

### Evidence boundary

This evidence proves only the PHP/Composer clean-checkout bootstrap, deterministic CI-only input path, ephemeral JWT lifecycle, dev SQLite directory creation, Symfony console cache boot, execution/status of existing lint/analyse commands, SQLite ORM metadata validation, and the complete PHPUnit result for the observed base. It does **not** prove a green CI gate, disposition of the three red remediation sets, application correctness, migration loading, full Doctrine replay, MySQL behavior, schema parity in a real database, domain law, SDK/API behavior, security acceptance, deployment, provider behavior, production data safety, route behavior, release readiness, or rollback of a real environment.

A deployment log, a workflow check marked successful by `continue-on-error`, a `if: always()` condition that overrides the test/job conclusion, a `if: ${{ !cancelled() }}` condition used to hide a failed command rather than run later evidence, a JUnit file without the complete console result, a parser that confuses `Tests\\App\\` with filesystem `tests/App/`, a schema-created SQLite fixture database, a fixed legacy tuple check, or a count-only assertion cannot pass this evidence boundary.

## Falsifiers and definition of done

Any of the following falsifies this slice or opens `Drift`, even if a later command appears to pass:
- PHP is not 8.4, the PHP job lacks `timeout-minutes: 20` or uses another outer cap, the extension evidence is incomplete, Composer did not use the committed lock, or `composer update`/a lock rewrite occurred.
- A provider, production/staging credential, operational data source, MySQL service, `pdo_mysql`, persistent volume, external integration call, deployment, or remote action is used.
- A committed `.env`, PEM, secret, real token, production/staging value, or generated key artifact is introduced; the workflow prints the environment, passphrase, key bytes, or key hashes; or a generated key remains after cleanup.
- The workflow executes the whole Docker/Railway entrypoint, `doctrine:schema:create`, a migration command, a migration diff, or a manually created schema and presents it as replay or metadata proof.
- After `mkdir -p var/data`, `cache:warmup` does not exit `0`, or `doctrine:schema:validate --skip-sync --env=test` does not exit `0`; any missing-env, missing-JWT, invalid-passphrase, kernel/container, fixture/bootstrap, or unexpected connection error is infrastructure Drift, not one of the downstream red baselines.
- The workflow does not execute lint and analyse as status-preserving steps, reports statuses other than the observed lint `8`/`217 of 752` and analyse `1`/`10 errors` without independent identity review, uses `continue-on-error`, or uses `if: ${{ !cancelled() }}` to override a failed command. `if: always()` is allowed only for terminal cleanup/evidence and is a falsifier when it overrides the preserved test/job conclusion.
- The suite is narrowed, skipped, filtered, stopped early, omits tests, times out, does not reach its PHPUnit summary/JUnit output, or uses `|| true` or an equivalent failure-hiding mechanism. A partial timeout result such as `732/1,167` with status `1` and no JUnit is not a test result and must not be inferred. The console parser assumes an `Errors`/`Failures` order, cannot extract labeled fields safely, or prints unsanitized environment/key/fixture data.
- The PHPUnit evidence does not satisfy the structural contract: no terminal summary/JUnit, console/JUnit disagreement, discovered tests below `1,167` without independent disposition, nonzero failures/errors in exact `App\\Tests\\App\\`, warnings/skipped/incomplete/risky not all zero, missing sanitized identities/status, or a hidden/overridden original command status. Snapshot tuples (`3,156`/`55`/`3`/status `2` and `3,160`/`52`/`2`/status `2`) are observations, not acceptance constants; increases are recorded and do not by themselves open Drift, while identity changes require independent review evidence.
- A future writer changes a path outside `.github/workflows/ci.yml` and disposable generated outputs, shares the workflow resource concurrently, broadens the capsule, or edits this spec silently.
- The result is presented as satisfying the charter's green clean-checkout gate, full Doctrine replay gate, production gate set, or downstream application-failure disposition.

**Done for this accepted spec's future implementation** means the PHP job explicitly sets `timeout-minutes: 20`, `mkdir -p var/data` makes cache warmup pass, SQLite metadata validation exits `0`, lint and analyse run with original red statuses preserved, the PHPUnit-only process sets `COMPOSER_PROCESS_TIMEOUT=900` below that outer cap, the complete unfiltered PHPUnit suite reaches a terminal summary and JUnit with console/JUnit agreement, discovered tests at least the reviewed floor `1,167` unless independently disposed, zero `App\\Tests\\App\\` failures/errors, zero warnings/skipped/incomplete/risky, every failure/error identity and actual original command status emitted sanitized, parser/evidence based on structural completeness rather than fixed tuples, wall duration reported only as observation, all three red static/application sets explicitly recorded as downstream remediation, cleanup proven through the chosen `EXIT` trap or terminal `if: always()` cleanup/evidence step, the workflow's original test/job conclusion preserved, and no disallowed resource/path touched. Prior and repeated tuples remain snapshots; any nonzero application result remains honest downstream remediation, and a future status `0` requires green console/JUnit plus static-step job decision. A timeout, missing summary/JUnit, or partial progress never counts as completion; this does not mean green CI or release readiness.

**Current pre-freeze artifact DoD assessment:** At source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`, the receipt satisfies the implementation-side bounded bootstrap conditions: locked install, ephemeral key cleanup, `var/data` creation, warmup and metadata status `0`, status-preserving lint/analyse, complete terminal PHPUnit/JUnit with structural parser evidence, the reviewed test floor and exact `App\\Tests\\App\\` zero hold, sanitized identities, and clean teardown. This is Building-complete/pre-freeze evidence only; the nonzero PHPUnit/lint/analyse statuses remain honest downstream holds, and Experienceable/Conforming have not been entered.

## Rollout, rollback, and cleanup

### Rollout boundary

There is no application rollout, provider rollout, database rollout, deploy, route cutover, release, or production effect in this spec. A future workflow change may cause a hosted CI run; opening/updating a PR or pushing a branch is an external workflow effect under the lifecycle and requires a recorded operator authorization. A local isolated run may produce only the disposable artifacts named above. No remote action is authorized by this accepted spec.

The accepted red-baseline decision requires the future writer to preserve each command's actual PHPUnit status and keep any nonzero application result red while downstream remediation holds remain; it does not require the prior `3,156`/`55`/`3` tuple or the repeated `3,160`/`52`/`2` tuple. A later mandatory evidence step MAY use `if: ${{ !cancelled() }}` after a failed static step; a terminal `if: always()` step may only collect evidence and clean up while preserving original command/job conclusions. No status override may make the check green.

### Rollback

- If the workflow implementation is abandoned, revert only the one-to-one `.github/workflows/ci.yml` change in its isolated branch. Do not revert another lane, alter the Composer lock, or edit authority documents.
- If a local run fails, stop at the failing step, preserve the sanitized failure evidence, execute the selected cleanup path (single-shell `EXIT` trap or terminal `if: always()` cleanup/evidence step), and discard the worktree or ignored state. Do not retry with a production/staging credential or broaden into MySQL/migrations.
- There is no database or provider rollback to infer from this slice. Any real schema/data rollback belongs to an operator-owned downstream replay spec with backup, preflight, inverse/restore, and authority records. The non-transactional DDL and deferred A2/A7 data work described in [`migrations-blocked-unique-constraints.md`](../apps/server/docs/migrations-blocked-unique-constraints.md#L47-L88) are explicitly outside this rollback.

### Cleanup

- Run the selected cleanup path on every exit: the single-shell `EXIT` trap, or the terminal cleanup/evidence step guarded by `if: always()`. In the latter shape, `if: always()` is cleanup/evidence-only and must preserve the captured test status and final job conclusion. Remove only generated `apps/server/config/jwt/private.pem`, `public.pem`, temporary key files, `var/cache`, `var/data`, SQLite/test output, and other known disposable artifacts from this run.
- Do not open, copy, print, or delete a developer/production `.env`, `.env.local`, or unknown ignored file. A forbidden environment file appearing in a fresh-checkout preflight is a stop/Drift condition, not a cleanup target.
- Do not retain raw JUnit/log output containing fixture details or environment values. Retain only the sanitized evidence required by this spec, and never commit it.
- Report any leftover file, process, lock, cache, or unexpected external effect. Cleanup is not success evidence when the journey itself failed.

## Conflicts and Drift log

| Entry | Observation/conflict | Treatment and return path |
|---|---|---|
| D-0002-1 | Current CI selects PHP 8.5 while Composer/Docker target PHP 8.4; the runtime observation is PHP 8.4.23/Composer 2.10.2. | **Closed for the current artifact:** source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587` records the PHP 8.4 correction and runtime evidence. The prior 8.5 value remains historical implementation drift; no 8.5 certification is inferred. |
| D-0002-2 | Fresh CI has no `.env` provisioning or JWT generation, and the first clean-checkout warmup blocker was missing ignored `var/data` for dev SQLite. | **Closed for the current artifact:** runtime evidence records JWT generation, `mkdir -p var/data`, and corrected warmup all at status `0`; the superseded pre-correction warmup probe remains a nonblocking observation. Any future post-`mkdir` boot failure remains Drift returning to `Specified` for intent change or `Building` for an implementation correction. |
| D-0002-3 | Runtime observations include a prior accepted run (`1,167` tests/`3,156` assertions/`55` failures/`3` errors/status `2`) and two byte-identical clean `8a16ea9` runs (`1,167`/`3,160`/`52`/`2`/status `2`) with identical failure/error identity sets. | **Historical observation:** retain both snapshots, make no causal or determinism claim, and use the current structural evidence contract. The current exact identity disposition is recorded in D-0002-10; nonzero application results remain downstream remediation. |
| D-0002-4 | The current metadata check is SQLite-only; Doctrine Migrations 3.9.5 cannot load the 49 old-import files and namespaces require reconciliation. | Keep this lane SQLite-only. Route migration source/API/namespace repair, empty MySQL replay, diff, and A2/A7 data work to a separate accepted downstream spec. |
| D-0002-5 | The existing Docker/Railway entrypoints use schema creation and fixtures, and `deploy.sh` swallows migration failure. | Do not use those paths as evidence. Any attempt to make this bootstrap depend on them is a new journey and a capsule violation. |
| D-0002-6 | Preview implementation `af069395` is a separate unmerged branch. | No dependency or shared path exists. A regression in the preview lane does not alter this Symfony bootstrap intent; a shared-resource conflict still enters Drift under the lifecycle. |
| D-0002-7 | A test result is infrastructure-red and application-red at the same time. | **Accepted decision:** evidence separates command/boot status from the three downstream red sets. The original red test/job conclusion is preserved; terminal `if: always()` is cleanup/evidence-only, and `if: ${{ !cancelled() }}` may only allow later evidence to run after a failed static step. |
| D-0002-8 | The summary contains both `Errors` and `Failures`, and identities under `Tests\\App\\` are not the filesystem `tests/App/` bucket. | **Closed for the current artifact's parser/evidence axis:** parser process and evidence statuses are `0`; independent labeled fields, console/JUnit agreement, sanitized identities, and exact `App\\Tests\\App\\` classification are recorded. Parser/order or namespace confusion remains a future Drift condition. |
| D-0002-9 | A repeat unfiltered PHPUnit run with Composer's default process timeout stopped exactly at `300s` after `732/1,167`, returned status `1`, and produced no JUnit; a prior complete run observed `221s` and the known `1,167`/`3,156`/`55`/`3` baseline. | **Closed by the current artifact's bounded evidence:** the full unfiltered PHPUnit command reached a terminal summary/JUnit with original status `2`; the committed workflow supplies `COMPOSER_PROCESS_TIMEOUT=900` only for the PHPUnit process and retains the PHP-job `timeout-minutes: 20` control. The `206s` wall time is observational and is not used to infer timeout or environment behavior. The default `300s` partial run remains a historical falsifier, not a current blocker. |
| D-0002-10 | Two clean identical runs on integration candidate `8a16ea9` produced `1,167` tests/`3,160` assertions/`52` failures/`2` errors/status `2`, while the prior accepted snapshot was `1,167`/`3,156`/`55`/`3`/status `2`; PHP source/workflow content was byte-identical and the cause is unproven. The repeated runs each had exactly two SchoolAdmin errors (`Tests\\App\\Controller\\SchoolAdminControllerTest::testUpdateSchool` and `Tests\\App\\Controller\\SchoolAdminControllerTest::testShowSpecificSchool`); `Tests\\App\\Controller\\ReceiptControllerTest::testEdit` was absent from those error identities, the recorded identity difference. | **Closed on the identity axis only:** independent PASS (`agent://CleanWorkflowCodeReview`) compared the current exact 58-entry set with the prior accepted list and found byte-identical lists (SHA-256 `bb32c2853cb925c3c4d542be3d5d4475ddf2ecf70731b7d7e6006417b5889858`). Retain the `8a16ea9` tuple as historical; its cause remains unproven, no determinism mechanism is claimed, and the closure does not green PHPUnit or CI. |

Any new conflict among this spec, the lifecycle, charter, ADR, domain authority, implementation, evidence, or runtime observation enters `Drift` with the conflicting artifacts, observation, owner, evidence, and proposed return (`Specified` if intent changes; `Building` if implementation alone changes). The current artifact's receipt closes D-0002-1, D-0002-2, D-0002-8, and D-0002-9, and closes D-0002-10 on the identity axis only; these are preparatory evidence closures, not a Conforming transition. PHPUnit/lint/analyse red statuses remain downstream holds. A snapshot, handoff, deployment log, or conversation cannot close Drift.

## Lifecycle gates

- **Specified:** this runtime-revised live spec exists at the stable path with one journey, observed snapshots, structural evidence contract, authority references, exact commands, evidence boundary, falsifiers, rollback, Drift, and capsule. Product lead re-accepted the revision on `2026-08-10`; status is the lifecycle enum `accepted`; runtime evidence (`agent://SymfonyDynamicVerifier`) and independent identity disposition PASS (`agent://CleanWorkflowCodeReview`) are recorded for current source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587` as preparatory gate evidence.
- **Building:** the current implementation/evidence receipt is complete for this bounded slice at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`; the product lead remains read-only. The lifecycle has not advanced to Experienceable.
- **Experienceable:** **not entered**. Enter only after the feature lead freezes this accepted spec as a one-to-one PR opens under recorded operator authority with objective journey evidence. Hosted CI was not run, and no PR or freeze is claimed.
- **Conforming:** **not entered**. Enter only after a blind-first verifier receives the frozen spec, implementation, and objective evidence before author rationale, and no linked Drift remains. The runtime receipt and identity PASS are preparatory evidence only. This slice remains explicitly outside the charter's green clean-checkout CI gate; PHPUnit `2`, lint `8`, and analyse `1` remain downstream remediation holds.
- **Release-ready / Operating:** not entered by this slice. The charter's green clean-checkout gate, full Doctrine replay, security evidence, parity journey, and any rollout/rollback authority remain separate prerequisites.

## Task capsule skeleton — future bounded writer

| Field | Capsule content |
|---|---|
| Spec ID/path | `0002`; `mono-web/design-specs/0002-symfony-clean-checkout-bootstrap.md` |
| Role/objective | Single writer `CleanBootstrapImplementer`; realize exactly one PHP 8.4 clean-checkout bootstrap journey and produce objective Composer, env/key lifecycle, Symfony boot, lint, analyse, SQLite metadata, full PHPUnit, red-baseline, and cleanup evidence. |
| Base/worktree | Start from the accepted `0002` spec branch tip whose code baseline is `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d`. Before mutation, manually verify isolation in `/tmp/mono-web-clean-checkout-bootstrap-impl-20260810` on branch `mono-web-clean-checkout-bootstrap-impl-20260810`; record the worktree and branch before mutation. Never use the main checkout or another lane's worktree. |
| Mutable authority | Only `mono-web/.github/workflows/ci.yml`, including the PHP job's explicit `timeout-minutes: 20` outer cap; generated ignored `apps/server/config/jwt/*.pem`, `apps/server/var/**`, and Composer vendor/cache outputs are disposable. |
| Forbidden actions | Every other source/config/test/doc/lock/migration/Docker/compose/deploy path; `.env` or secret commit; production/staging credentials/data; MySQL/`pdo_mysql`; migration commands/replay/diff; schema-create substitution; deployment/provider/remote actions; test filtering or failure hiding; edits to this spec; work on another lane's resource. |
| Dependencies/conflicts | Accepted Stage-0 ADR 0001 and accepted local preview spec are prerequisites for the Stage-1 program but no preview implementation dependency exists. Reserve `.github/workflows/ci.yml` for this lane. Full MySQL replay waits for separate migration source/API and data decisions. Effect v4 Receipt and team/domain lanes use disjoint worktrees/paths. |
| Context/law/interface refs | Lifecycle §§4–6, §9; charter §§1, 5–7, 9–12; ADR 0001 §§1–6; status/handoff snapshots for baseline; `composer.json`/lock, CI workflow, `.env.test`, server config, `phpunit.xml.dist`, test bootstrap, and this spec. No domain law or product interface is exercised. |
| Exact skills/procedures | Symfony/PHP 8.4 Composer and GitHub Actions CI procedure; read the lifecycle capsule/evidence rules and server testing rules. Do not load provider/deployment/data-migration procedures for this capsule. |
| Sensitive-data policy | Process-only deterministic non-secret sentinels; no `.env`, GitHub secrets, provider credentials, PII, operational data, external integrations, or key output. Generate only ignored ephemeral JWT files, never inspect/print their contents, and remove them on every exit. |
| Verification commands/scenarios | PHP 8.4/extensions and PHP-job `timeout-minutes: 20` (observed PHP `8.4.23`, Composer `2.10.2`); locked `composer install`; process env map; isolated key generation/cleanup via single-shell `EXIT` trap or terminal `if: always()` cleanup/evidence step; `mkdir -p var/data`; `cache:warmup --env=dev --no-optional-warmers` status `0`; `composer lint` status `8`/`217 of 752`; `composer analyse` status `1`/`10 errors` after warmup and before cache removal; `doctrine:schema:validate --skip-sync --env=test` status `0`; `rm -rf var/cache` immediately before the PHPUnit-only process env `COMPOSER_PROCESS_TIMEOUT=900`; exact command `composer test`; terminal summary/JUnit; console/JUnit agreement; discovered-test floor `1,167` unless independently disposed; zero exact `App\\Tests\\App\\` failures/errors; zero warnings/skipped/incomplete/risky; all failure/error identities and actual original PHPUnit status emitted sanitized; prior/repeated observation snapshots recorded; default-timeout Drift `300s`/`732 of 1,167`/status `1`/no JUnit; path-scope review. No fixed duration or legacy tuple is required. |
| Exit criteria | `var/data` creation makes warmup pass; metadata exits `0`; lint/analyse/test execute without status hiding; the PHP job sets `timeout-minutes: 20`, the PHPUnit-only process uses `COMPOSER_PROCESS_TIMEOUT=900` below that cap; full unfiltered PHPUnit reaches terminal summary/JUnit with console/JUnit agreement, discovered-test floor `1,167` unless independently disposed, zero exact `App\\Tests\\App\\` failures/errors, zero warnings/skipped/incomplete/risky, every failure/error identity and actual original command status emitted sanitized; all three red sets are downstream remediation holds, not a green gate; parser/evidence uses structural completeness rather than fixed snapshots; original test/job conclusion is preserved; generated state is removed; no disallowed path/effect occurs. Prior/repeated tuples are observation context, not required outputs; any nonzero application result remains honest downstream remediation, and future status `0` requires actually green console/JUnit plus static-step job decision. |
| Drift path | Stop on a falsifier; notify product lead and owning authority; link this spec, lifecycle, charter, ADR, status/handoff snapshot, and the observed artifact. Return to `Specified` for intent revision or `Building` for implementation correction. |
| Cleanup | Execute the selected key/cache/temp cleanup path (`EXIT` trap or terminal `if: always()` cleanup/evidence step); confirm generated PEM, `var/cache`, and `var/data` absence; discard ignored Composer outputs; retain only sanitized counts/statuses/failure identities; report leftovers and all external effects. |
| Operator authorization | None for a local isolated run. Any PR/push that triggers hosted CI is an external workflow effect and requires a recorded operator scope, actor, environment, expiry, and revocation. No deploy, provider, credential, data, or release authority is granted. |

## Accepted decisions and downstream holds

1. **Runtime revision and status:** the clean-checkout observation falsified the earlier baseline before implementation freeze. The product lead re-accepted this revised intent on `2026-08-10`; the current bounded artifact at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587` is Building-complete/pre-freeze on the bootstrap evidence contract, with runtime evidence `agent://SymfonyDynamicVerifier` and independent identity disposition PASS (`agent://CleanWorkflowCodeReview`) as preparatory gate evidence. The earlier implementation at `98edecd` remains a historical non-conforming artifact in `Drift`; the `8a16ea9` tuple remains historical with unproven cause and no determinism claim.
2. **Observed red baselines and invariants:** PHP `8.4.23`/Composer `2.10.2` locked install, PHP-job `timeout-minutes: 20`, `mkdir -p var/data` before the required warmup, which a prior implementation branch and the combined `8a16ea9` verifier observed passing, metadata status `0`, lint status `8`/`217 of 752`, and analyse status `1`/`10 errors` are recorded. Any future post-`mkdir` warmup failure remains a bootstrap falsifier. PHPUnit prior/repeated tuples are the snapshots in [PHPUnit observation snapshots](#phpunit-observation-snapshots), not fixed acceptance values. The evidence contract requires terminal summary/JUnit, agreement, discovered floor `1,167` unless independently disposed, zero exact `App\\Tests\\App\\` failures/errors, zero warnings/skipped/incomplete/risky, all identities/status emitted, and original status preserved; nonzero application results remain downstream remediation and status `0` requires actually green console/JUnit plus static-step job decision.
3. **Downstream remediation holds:** lint, analyse, and PHPUnit red sets remain explicit remediation work before the charter's green clean-checkout gate. They do not block this bounded bootstrap lane. No failure may be hidden or relabeled, and counts alone never establish identity equality.
4. **PHP target:** this lane remains accepted at PHP 8.4 to match Composer/Docker; the observed patch is 8.4.23. The current workflow's PHP 8.5 value is implementation drift to be corrected by the future writer; no 8.5 certification is inferred.
5. **Full Doctrine replay:** migration import/API repair, recorded-version namespace reconciliation, empty MySQL replay/diff, and A2/A7 data-shape/duplicate decisions remain downstream holds requiring a separate accepted spec and operator-owned evidence. They are not part of, or blockers to, this bounded SQLite bootstrap.

Status is the lifecycle enum `accepted` for the current Building-complete, pre-freeze artifact at source/workflow HEAD `0dfa6b96d8f57f63da149576919b943468387587`, based on runtime evidence `agent://SymfonyDynamicVerifier` and independent identity disposition PASS (`agent://CleanWorkflowCodeReview`) as preparatory gate evidence. PHPUnit status `2`, lint `8`, and analyse `1` remain downstream remediation holds; the charter's green clean-checkout gate is not satisfied. D-0002-9 is closed by the terminal full command and committed workflow timeout control, not by its `206s` observation; D-0002-10 is closed only on the identity axis; the `8a16ea9` tuple and unproven cause remain historical. Experienceable and Conforming remain unentered, and this artifact never authorizes a production action.
