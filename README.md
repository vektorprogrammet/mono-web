# Vektorprogrammet native replacement

Vektorprogrammet connects volunteer university students with partner schools.
This repository contains the TypeScript replacement for the legacy PHP system.

Production still runs the legacy application. Native development and synthetic
local acceptance do not authorize production data access, deployment, or
cutover.

## Documentation

The durable documentation set is:

| File                                                                             | Authority                                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [README.md](README.md)                                                           | Repository map and local commands                                                   |
| [AGENTS.md](AGENTS.md)                                                           | Project development, verification, resource, and cleanup practices                  |
| [STATE.md](STATE.md)                                                             | Current migration state, evidence limits, and next work                             |
| [docs/system.md](docs/system.md)                                                 | Intended product, domain, ownership, authority, and journeys                        |
| [docs/architecture.md](docs/architecture.md)                                     | Runtime, dependencies, persistence, delivery, and interface boundaries              |
| [docs/operational-responsibility-map.md](docs/operational-responsibility-map.md) | Stakeholders, end-to-end processes, and replacement contracts                       |
| [docs/enterprise-models.md](docs/enterprise-models.md)                           | 4EM and ArchiMate views derived from the system documents                           |
| [docs/system-walkthrough.mdx](docs/system-walkthrough.mdx)                       | Layered reading guide with MDXCN figures                                            |
| [Placements developer guide](packages/domain/src/placements/README.md)           | Public imports, executable examples, API reference generation, and maintainer tasks |
| [Receipt developer guide](packages/domain/src/receipt/README.md)                 | Claim, approval, settlement evidence, private files, bounded reads, and recovery    |
| [Delivery recovery guide](docs/delivery-recovery.md)                             | Native worker configuration, lifecycle, retry limits, and recovery proof            |

Create one file in `docs/specs/` only while a non-trivial journey is active.
Remove the completed specification after its durable intent is present in the
system document, code, and observable checks.

Code and generated contracts are authoritative for current implementation.
Do not keep generated code reference, runtime evidence, screenshots, logs, or
dated migration reports in the repository.

See [remaining migration work](STATE.md#remaining-migration-work) for the authoritative roadmap and [production gates](STATE.md#production-gates) for cutover requirements.
The local development instructions below do not establish migration completion.

## Repository map

[//]: # "layout: generated from tools/conventions/src/layout.ts by just layout write; do not edit"

| Path                    | Holds                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `apps/backend`          | Native Effect HTTP process and workers                                          |
| `apps/dashboard`        | Authenticated React Router and Foldkit application                              |
| `apps/docs`             | Documentation site that renders the repository documents                        |
| `apps/homepage`         | Public React application                                                        |
| `packages/domain`       | Business values, transitions, failures, and authority                           |
| `packages/database`     | PostgreSQL schema, persistence, locks, audit, and outbox                        |
| `packages/http-api`     | HTTP contracts, middleware declarations, and OpenAPI                            |
| `packages/sdk`          | Generated native API client                                                     |
| `tools/acceptance`      | Local API and browser acceptance probes of single journeys                      |
| `tools/conventions`     | Layout, guide, construct, and Effect exception checks and their generated files |
| `tools/e2e`             | Golden journeys, local journey drivers, and legacy migration commands           |
| `tools/oxlint`          | Project Oxlint rules                                                            |
| `tools/placements-docs` | Placements API reference generation and checks                                  |
| `tools/postgres`        | Disposable PostgreSQL clusters of the selected major                            |
| `tools/scripts`         | Local launcher, Git hook runner, job measurement, preview deployment, changelog |
| `tools/source-safety`   | Staged-tree scan for credentials and personal data                              |
| `tools/verification`    | Cross-application PostgreSQL proofs and migration rehearsals                    |
| `infra`                 | Worker preview deployment configuration                                         |
| `docs`                  | Intended system, architecture, operations, and active specifications            |
| `patches`               | Dependency patches that `patchedDependencies` in package.json applies           |
| `.github`               | Checks, Tests, Docs, and preview workflows and their actions                    |
| `.claude`               | Claude Code settings and project rules                                          |
| `.agents`               | Agent skills of the repository: the Effect house overlay                        |

Apps and packages never import `tools/`.
Context folders in `packages/domain/src`, `packages/database/src`, `apps/backend/src`, and `apps/dashboard/app/foldkit` carry the kebab-case name of a bounded context in [docs/model/contexts.cml](docs/model/contexts.cml).
Code that several contexts share lives in `shared-kernel`.
`just layout` checks the tree against [tools/conventions/src/layout.ts](tools/conventions/src/layout.ts), which lists the exceptions and their reasons.
Every app, package, and context folder has an `AGENTS.md` guide and a `CLAUDE.md` link to it; `just guides write` renders their generated part.
[docs/constructs.md](docs/constructs.md) lists the shared constructs and their consumers; `just constructs write` renders it.
[docs/effect-exceptions.json](docs/effect-exceptions.json) registers each suppression of an Effect rule; `just exceptions` checks it against the sites.

[//]: # "layout: end"

The legacy Symfony source lives in the separate
[vektorprogrammet](https://github.com/vektorprogrammet/vektorprogrammet) repository. It is an input to
migration decisions, not the target architecture.

## Toolchain

The [root manifest](package.json) and lockfile own tool versions and the dependency catalog.
The application uses Bun, TypeScript, Effect, PostgreSQL, React Router, Foldkit, Oxfmt, and Oxlint.
The PostgreSQL adapter pin preserves the pool shared by Database and Better Auth.
See [development practices](AGENTS.md#building-reference) before changing it.

`devenv shell` is the entry point, locally and in CI. Run a single command with `devenv shell -- <command>`.
[devenv.nix](devenv.nix) reads each version from the file that declares it and provides:

- Bun at `packageManager` and Node.js at the lowest `engines.node` major;
- PostgreSQL at the selected `engines.postgresql` major, on `PATH` and as the `devenv up` service;
- the Chromium build of the `@playwright/test` version in `bun.lock`, through `PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`;
- openssl, Git, and the Git hooks.

The `legacy-data` profile adds the legacy data tools: MariaDB, to restore and read legacy-shaped databases, and the
PHP 8.4 CLI without Composer, to make legacy-format bcrypt hashes. Enter it with `devenv --profile legacy-data shell`.
`just rehearsal account-cohort` and the `legacy-*` rehearsals refuse to start without it. The default shell has no
legacy tools.
[devenv.lock](devenv.lock) pins nixpkgs. Bun and Playwright come from the historical nixpkgs revision that shipped
their exact versions, selected through the `nixpkgs-multiverse` input.
The Checks and Tests workflows run their steps in the same shell through [.github/actions/devenv](.github/actions/devenv/action.yml).

`devenv shell` installs the Git hooks, except when `CI` is set. Hooks check; they never rewrite or restage files.
Every hook runs a `just` recipe. The pre-commit hook checks formatting and lint on staged files.
Then it type checks and tests the packages that the staged change modifies.
It uses a temporary Git worktree of the staged tree, so unstaged and untracked files do not change the result.
A change outside all packages, for example to documentation only, runs no type check or test.
A merge without conflicts type checks and tests the merge result, including the dependents of the changed packages.
Every commit, including a merge, also scans each file in the staged tree with
[tools/source-safety](tools/source-safety/src/source-safety.ts), whatever the task cache holds. The scan rejects
paths that name credential, backup, or database material, secrets and personal data in dotenv files and SQL, and
invalid UTF-8. `just source-safety` runs it by hand; `just check` includes it.
Every commit, including a merge, also checks the staged tree against the [repository map](#repository-map) with
`just layout --staged`: the declared top-level entries and package directories, bounded context folder names, no
`tools/` import from apps or packages, root scripts, recipe mentions in documentation, and the generated sections.
`just layout` checks the working tree; `just check` includes it.
The pre-push hook runs `just check` and the tests of packages changed from `main`.
It checks the working tree, not the pushed commits. Push from a clean worktree.
While hooks run, the hook runner (prek) moves unstaged changes aside and restores them afterwards.
Hook type checks and tests wait for a machine-wide slot, as described in [AGENTS.md](AGENTS.md#verification-and-resources).
Run the hooks by hand with `just hooks` or `just hooks --hook-stage pre-push`, or skip them once with `git commit --no-verify`.

The root manifest declares a type-only Effect patch. It preserves union-command
requests and callable Fetch inputs across runtimes. SDK type checks cover both
contracts, including Bun types. Remove the patch when upstream declarations pass
those checks without it.

`engines.postgresql` lists the supported PostgreSQL majors, `"17 || 18"`. The hosted Supabase database runs 17.
The highest major, 18, is the default. `VEKTOR_POSTGRES_MAJOR` selects another supported major for one environment,
for example `VEKTOR_POSTGRES_MAJOR=17 devenv shell`. devenv re-evaluates the shell when the variable changes.
A major outside the set fails the shell and every PostgreSQL command, with a message that names the set.
The `devenv up` data directory belongs to the major that created it; PostgreSQL refuses to start it with another major.

Tests, proofs, journeys, and CI use only the selected PostgreSQL major. The
[PostgreSQL toolchain](tools/postgres/index.ts) runs the first `postgres` on `PATH`
and fails for any other major. The devenv package includes the contrib extensions, such as `btree_gist`.
The Tests workflow runs every suite with the default major and the backend and database suites with each other supported major.

Run commands inside `devenv shell`, from this repository root. The root [justfile](justfile) is the command surface:
`just` lists its recipes, and hooks and CI workflows call them.

[//]: # "commands: generated from the justfile by just layout write; do not edit"

| Group     | Recipe                            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| check     | `just check [args...]`            | Check layout, constructs, guides, Effect exceptions, source safety, format, lint, types, and the HTTP contract. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                            |
| check     | `just check-types [args...]`      | Type check every package and assert the HTTP contract. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                                     |
| check     | `just constructs [args...]`       | Check docs/constructs.md against the @construct tags and the imports; `just constructs write` renders it.                                                                                                                                                                                                                                                                                                                                                                         |
| check     | `just exceptions [args...]`       | Check that every suppression of an Effect rule names its entry in docs/effect-exceptions.json, and every entry its current sites and versions.                                                                                                                                                                                                                                                                                                                                    |
| check     | `just format [args...]`           | Format with Oxfmt, or check the format with `just format --check`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| check     | `just guides [args...]`           | Check the AGENTS.md guide and CLAUDE.md link of every app, package, and context folder; `just guides write` renders them.                                                                                                                                                                                                                                                                                                                                                         |
| check     | `just layout [args...]`           | Check the repository layout and its generated sections: the README and AGENTS.md tables and the hosted journey legs; `just layout write` renders them.                                                                                                                                                                                                                                                                                                                            |
| check     | `just lint [args...]`             | Lint with Oxlint in type-aware mode after generating the React Router route types, a heavy job (AGENTS.md#verification-and-resources).                                                                                                                                                                                                                                                                                                                                            |
| check     | `just measure [args...]`          | Run a heavy job under the machine-wide heavy lock and measure it, or show the ledger with `just measure --report`.                                                                                                                                                                                                                                                                                                                                                                |
| check     | `just migration-hashes [args...]` | Check the migration registry and the checksums of applied migrations; `just migration-hashes write` records new ones.                                                                                                                                                                                                                                                                                                                                                             |
| check     | `just model <action>`             | Run the Alloy commands of docs/model/authority.als (check) or validate docs/model/contexts.cml (validate), a heavy job.                                                                                                                                                                                                                                                                                                                                                           |
| check     | `just source-safety`              | Scan every file in the Git index for credentials, personal data, and SQL data.                                                                                                                                                                                                                                                                                                                                                                                                    |
| check     | `just test [args...]`             | Test every package, a heavy job (AGENTS.md#verification-and-resources). Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                    |
| develop   | `just build [args...]`            | Build every package through Turbo. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| develop   | `just changelog [args...]`        | Regenerate CHANGELOG.md from conventional commits, or compare it with `--check`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| develop   | `just dev [args...]`              | Start the homepage, dashboard, and backend against BACKEND_PG_URL. `devenv up` runs it.                                                                                                                                                                                                                                                                                                                                                                                           |
| develop   | `just docs [script]`              | Serve the documentation site, or run another of its scripts, such as `just docs build`.                                                                                                                                                                                                                                                                                                                                                                                           |
| develop   | `just land <branch>`              | Land a branch on main in the main checkout, then remove its worktree and delete it. It does not push.                                                                                                                                                                                                                                                                                                                                                                             |
| develop   | `just seed`                       | Provision the native journey accounts in the `devenv up` database.                                                                                                                                                                                                                                                                                                                                                                                                                |
| hooks     | `just check-staged [args...]`     | Type check and test the packages that the staged tree changes (pre-commit and merge hooks).                                                                                                                                                                                                                                                                                                                                                                                       |
| hooks     | `just hook-slot [args...]`        | Run a command in one of the machine-wide hook slots under the shared heavy lock (lint and pre-push hooks).                                                                                                                                                                                                                                                                                                                                                                        |
| hooks     | `just hooks [args...]`            | Run the Git hooks by hand, for example `just hooks --hook-stage pre-push`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| journeys  | `just e2e <suite>`                | Run a browser suite: admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, onboarding, organization, owner, password-recovery, profile, recommendation, recommendation-applicant-progress, recommendation-co-interviewer, recommendation-correction, recommendation-report, recommendation-returning, recruitment, scheduling, schools, settlement, sign-in-pages, social-events, substitutes, or unavailable-projections. |
| journeys  | `just fixture <name> [args...]`   | Build a PostgreSQL fixture in JOURNEY_SEED_PG_URL: recommendation-preupgrade.                                                                                                                                                                                                                                                                                                                                                                                                     |
| journeys  | `just golden <journey>`           | Run a golden journey: school-service, recruitment, reimbursement, or team-application.                                                                                                                                                                                                                                                                                                                                                                                            |
| journeys  | `just proof <name> [args...]`     | Run a PostgreSQL proof: authorization-rules, delivery-recovery, or rule-reconciliation.                                                                                                                                                                                                                                                                                                                                                                                           |
| migration | `just migration <name> [args...]` | Run an operator migration command: legacy-service (the service cutover) or legacy-receipt.                                                                                                                                                                                                                                                                                                                                                                                        |
| migration | `just rehearsal <name> [args...]` | Run a migration rehearsal, where account-cohort and the legacy ones need the legacy-data profile: organization-import, receipt-import, current-assignment, account-cohort, legacy-current-assignment, legacy-organization, legacy-receipt, or legacy-candidate.                                                                                                                                                                                                                   |

[//]: # "commands: end"

A fresh checkout builds, checks, and tests with:

```bash
devenv shell
bun install --frozen-lockfile
just build --concurrency=1
just check-types --concurrency=1
just test --concurrency=1
just lint
just format --check
```

Run heavy jobs through `just measure`, which holds the machine-wide heavy lock ([AGENTS.md](AGENTS.md#verification-and-resources)). Turbo concurrency does not bound each package runner.
For focused tests, use the bounded commands in [AGENTS.md](AGENTS.md#commands).
The domain aggregate includes fixture programs and D1 proofs. The dashboard aggregate includes a bundle gate.
Do not pass Vitest flags through the domain aggregate script.

An affected package graph can run separately:

```bash
just check-types -F @vektorprogrammet/backend --concurrency=1
bun run --cwd packages/http-api generate
```

Homepage builds require a clean committed source artifact. Do not weaken that provenance guard for a dirty operator tree.
Only the bundle build applies the guard. Homepage type checks, tests, and the development server accept a dirty tree.
Use a separate source-matched committed snapshot for acceptance, as described in [AGENTS.md](AGENTS.md#verification-and-resources).

### Documentation site

[The documentation site](https://vektorprogrammet.github.io/mono-web/) renders the documents above in place.
[apps/docs](apps/docs/site.ts) names the published sources and their navigation.
The build mirrors them into an ignored Vocs pages directory; edit only the source documents.
The build fails on a relative link to a path that does not exist. It does not check anchors.
A link to a published document opens its page. A link to another repository file opens it on GitHub.

```bash
bun install --frozen-lockfile
just docs
just docs build
```

Every Markdown file in `docs/` and `docs/specs/` must appear in a navigation section.
The [documentation workflow](.github/workflows/docs.yml) builds the site on each push to `main` and publishes it to GitHub Pages.
The walkthrough figures use the vendored MIT MDXCN component. Its [manifest](apps/docs/components/mdxcn/provenance.json) records upstream provenance.

### Local native development

Use a dedicated local PostgreSQL database with synthetic data. Do not use a shared database or a production tunnel.
The backend applies schema migrations and can write application data. The launcher does not create or reset PostgreSQL.

`devenv up` starts the devenv PostgreSQL service on `127.0.0.1:$PGPORT` (5480), creates the `vektorprogrammet`
database and owner role on first start, and then runs `just dev` with `BACKEND_PG_URL` set to that database.
The data stays in `.devenv/state/postgres`. If the port is taken, `devenv up` stops and names the process that holds it.
Export `BETTER_AUTH_SECRET` first: at least 32 characters, stable across restarts.
`devenv up postgres` starts only the database. Without `devenv up`, set `BACKEND_PG_URL` in your shell
to a loopback PostgreSQL database URL without query parameters.

```bash
just dev --help
devenv up
```

`just dev` starts the homepage, dashboard, and native Bun backend through the existing Turbo tasks.
Its help output defines the ports, dashboard mount, and private-file paths. All HTTP listeners use `127.0.0.1`.
Database records and private files persist across restarts. Ctrl+C stops the owned application tasks, not existing services.

While `devenv up` runs, provision the native journey accounts of a new synthetic database before sign-in:

```bash
just seed
```

The recipe runs [the seed](apps/dashboard/e2e/native-users-journey-seed.mjs) against the `devenv up` database with the
local identity deployment and the default dashboard origin.

The seed creates synthetic profiles and authority facts. Its source defines the development account credentials.
Open the homepage URL printed by the launcher, select **Logg inn**, and sign in to the dashboard.
The **Brukere** page reads the native PostgreSQL directory.

External mail and notification delivery remain disabled. Contact submission without trusted ingress fails closed.
The launcher does not inherit provider configuration, and the backend does not load package `.env` files.
These boundaries do not prevent database writes.

The homepage development server accepts local edits and labels its provenance `working-tree`.
Release builds still require clean committed source.
No development command authorizes production access or cloud provisioning.

### Current-assignment migration rehearsal

Run the original synthetic boundary and the reviewed-source journey separately:

```bash
just rehearsal current-assignment
devenv --profile legacy-data shell -- just rehearsal legacy-current-assignment --evidence-dir=/tmp/vektor-assignment-review
```

The reviewed-source journey also requires the selected PostgreSQL major. Its evidence directory must not exist.
It creates private, disposable MariaDB and PostgreSQL instances and uses synthetic legacy-shaped data.
It removes those instances after the run and retains an owner-only `report.json`. It does not access production or external providers.

The operator cutover command requires explicit assignment and Organization choices. Its help output defines the connection and review-file arguments:

```bash
just migration legacy-service --help
```

`--current-assignments=none` leaves current assignments unimported. A private review file selects the reviewed-source path.
The [review schema](packages/domain/src/placements/current-assignment-contracts.ts) defines the required evidence.
Current production data, human review, provider acceptance, and cutover authority remain separate gates.

### Reviewed Organization migration

Run the reviewed Organization journey:

```bash
devenv --profile legacy-data shell -- just rehearsal legacy-organization --evidence-dir=/tmp/vektor-organization-review
```

This journey requires the selected PostgreSQL major and a new evidence directory. It uses synthetic records and private, disposable databases.
The cutover requires `--organization=none` or `--organization=PATH`. The first choice leaves Organization unchanged.

The [review schema](packages/domain/src/organization/review.ts) defines the required source evidence, intervals, and exclusions.
Organization resolves appointments through accepted Person mappings. Historical appointments and board membership do not imply current department or global authority.
Current source data, human review, provider acceptance, and cutover authority remain separate gates.

### Reviewed receipt migration

Run the reviewed receipt journey:

```bash
devenv --profile legacy-data shell -- just rehearsal legacy-receipt --evidence-dir=/tmp/vektor-receipt-review
```

This journey requires the selected PostgreSQL major, a clean committed tree, and a new evidence directory.
It uses invented records, private file bytes, and disposable databases. It does not access production or external providers.

The receipt command runs separately, after accepted Person and reference reconciliation:

```bash
just migration legacy-receipt --help
```

The [review schema](packages/domain/src/receipt/review.ts) defines the required source, ownership, department, date, account, and file evidence.
The command requires explicit connections, target identity, review, archive, custody roots, and payment key.
It requires an existing database schema and owner-only review, key, and custody paths.
SQL acceptance and file reconciliation remain separate. Exit status `2` means accepted receipts still need reconciliation.
Legacy refunded status never creates settlement evidence. Historical import still requires the missing file archive and reviewed ownership evidence.

### Combined migration candidate

Run the combined synthetic journey:

```bash
devenv --profile legacy-data shell -- just rehearsal legacy-candidate --evidence-dir=/tmp/vektor-candidate-review
```

The command requires the selected PostgreSQL major, a clean committed tree, and a new evidence directory.
PHP generates compatible synthetic password hashes. The command uses no production data or external providers.

The existing cutover and receipt commands share one source, accepted Person identities, and PostgreSQL target.
Native authentication and operational reads exercise those imported identities before and after logical database and private-file restore.
The restore retains the authentication secret and payment key. SQL and private files remain separate commit domains.

The report accounts for imported, quarantined, and excluded occurrences. It retains unresolved native receipt changes instead of overwriting them.
Successful rehearsal checks do not mean that the candidate is complete or ready for production.
The command retains a private report and checksummed source archive, then removes its disposable databases and private temporary data.

The authorized historical-backup rehearsal remains separate. See [migration status](STATE.md#historical-backup-rehearsal) for its scope and remaining input requirements.

## Change rule

Implement one complete operational journey at a time:

```text
intended outcome
  -> active specification
  -> domain and transport contract
  -> persistence and runtime
  -> real UI/API/PostgreSQL observation
  -> production reconciliation and cutover gate
```

A native route is not migration completion. Replacement requires the complete
journey, correct authority, historical reconciliation, external-effect
recovery, writer transfer, and explicit operator authorization.
