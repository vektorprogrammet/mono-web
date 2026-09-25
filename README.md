# Vektorprogrammet native replacement

Vektorprogrammet connects volunteer university students with partner schools.
This repository contains the TypeScript replacement for the legacy PHP system.

Production still runs the legacy application. Native development and synthetic
local acceptance do not authorize production data access, deployment, or
cutover.

## Documentation

The durable documentation set is:

| File                                                                             | Authority                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [README.md](README.md)                                                           | Repository map and local commands                                                          |
| [AGENTS.md](AGENTS.md)                                                           | Project development, verification, resource, and cleanup practices                         |
| [STATE.md](STATE.md)                                                             | Current migration state, evidence limits, and next work                                    |
| [docs/system.md](docs/system.md)                                                 | Intended product, domain, ownership, authority, and journeys                               |
| [docs/architecture.md](docs/architecture.md)                                     | Runtime, dependencies, persistence, delivery, and interface boundaries                     |
| [docs/operational-responsibility-map.md](docs/operational-responsibility-map.md) | Stakeholders, end-to-end processes, and replacement contracts                              |
| [docs/enterprise-models.md](docs/enterprise-models.md)                           | 4EM and ArchiMate views derived from the system documents                                  |
| [docs/system-walkthrough.mdx](docs/system-walkthrough.mdx)                       | Layered reading guide with MDXCN figures                                                   |
| [Placements developer guide](packages/placements/README.md)                      | Public imports, executable examples, API reference generation, and maintainer tasks        |
| [Substitutes developer guide](packages/domain/src/substitutes/README.md)         | Pool service, caller authority, transaction ownership, and the continuous coverage journey |
| [Receipt developer guide](packages/domain/src/receipt/README.md)                 | Claim, approval, settlement evidence, private files, bounded reads, and recovery           |
| [Delivery recovery guide](docs/delivery-recovery.md)                             | Native worker configuration, lifecycle, retry limits, and recovery proof                   |

Create one file in `docs/specs/` only while a non-trivial journey is active.
Remove the completed specification after its durable intent is present in the
system document, code, and observable checks.

Code and generated contracts are authoritative for current implementation.
Do not keep generated code reference, runtime evidence, screenshots, logs, or
dated migration reports in the repository.

See [remaining migration work](STATE.md#remaining-migration-work) for the authoritative roadmap and [production gates](STATE.md#production-gates) for cutover requirements.
The local development instructions below do not establish migration completion.

## Repository map

```text
apps/backend       native Effect HTTP process and workers
apps/homepage      public React application
apps/dashboard     authenticated React Router and Foldkit application
packages/domain    business values, transitions, failures, and authority
packages/database  PostgreSQL migrations, persistence, locks, audit, and outbox
packages/placements portable Placements contracts and private server implementation
packages/http-api  transport schemas, middleware contracts, and OpenAPI
packages/sdk       generated native API client
tools/verification cross-application PostgreSQL proofs and migration rehearsals
tools              other bounded development and migration tools
docs               intended system, architecture, operations, and active specs
```

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

The `legacy` profile adds the Symfony toolchain: PHP at the `apps/server/composer.json` version, Composer, and MariaDB.
Enter it with `devenv --profile legacy shell`. `dev:server`, `rehearsal:account-cohort`, the `rehearsal:legacy-*` scripts,
and the Symfony browser suites (`e2e:real-core-journeys`, `e2e:real-org-operations`, `e2e:real-background-operations`,
`e2e:real-content-ops`) refuse to start without it. The default shell has no legacy tools.
[devenv.lock](devenv.lock) pins nixpkgs. Bun and Playwright come from the historical nixpkgs revision that shipped
their exact versions, selected through the `nixpkgs-multiverse` input.
The Checks and Tests workflows run their steps in the same shell through [.github/actions/devenv](.github/actions/devenv/action.yml).

`devenv shell` installs the Git hooks, except when `CI` is set. Hooks check; they never rewrite or restage files.
The pre-commit hook checks formatting and lint on staged files.
Then it type checks and tests the packages that the staged change modifies.
It uses a temporary Git worktree of the staged tree, so unstaged and untracked files do not change the result.
A change outside all packages, for example to documentation only, runs no type check or test.
A merge without conflicts type checks and tests the merge result, including the dependents of the changed packages.
Every commit, including a merge, also scans each file in the staged tree with
[tools/source-safety](tools/source-safety/src/source-safety.ts), whatever the task cache holds. The scan rejects
paths that name credential, backup, or database material, secrets and personal data in dotenv files and SQL, and
invalid UTF-8. `bun run source-safety` runs it by hand; `bun run check` includes it.
The pre-push hook runs `bun run check` and the tests of packages changed from `main`.
It checks the working tree, not the pushed commits. Push from a clean worktree.
While hooks run, the hook runner (prek) moves unstaged changes aside and restores them afterwards.
Hook type checks and tests wait for a machine-wide slot, as described in [AGENTS.md](AGENTS.md#verification-and-resources).
Run a hook manually with `prek run` or `prek run --hook-stage pre-push`, or skip hooks once with `git commit --no-verify`.

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

Run commands inside `devenv shell`, from this repository root:

```bash
devenv shell
bun install --frozen-lockfile
bun run build --concurrency=1
bun run check-types --concurrency=1
bun run test --concurrency=1
bun run lint
bun run format:check
```

Start heavy jobs only under the admission rule in [AGENTS.md](AGENTS.md#verification-and-resources). Turbo concurrency does not bound each package runner.
For focused tests, use the bounded commands in [AGENTS.md](AGENTS.md#commands).
The domain aggregate includes fixture programs and D1 proofs. The dashboard aggregate includes a bundle gate.
Do not pass Vitest flags through the domain aggregate script.

An affected package graph can run separately:

```bash
bun run turbo -F @vektorprogrammet/backend check-types --concurrency=1
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
bun run --cwd apps/docs dev
bun run --cwd apps/docs build
```

Every Markdown file in `docs/` and `docs/specs/` must appear in a navigation section.
The [documentation workflow](.github/workflows/docs.yml) builds the site on each push to `main` and publishes it to GitHub Pages.
The walkthrough figures use the vendored MIT MDXCN component. Its [manifest](apps/docs/components/mdxcn/provenance.json) records upstream provenance.

### Local native development

Use a dedicated local PostgreSQL database with synthetic data. Do not use a shared database or a production tunnel.
The backend applies schema migrations and can write application data. The launcher does not create or reset PostgreSQL.

`devenv up` starts the devenv PostgreSQL service on `127.0.0.1:$PGPORT` (5480), creates the `vektorprogrammet`
database and owner role on first start, and then runs `bun dev` with `BACKEND_PG_URL` set to that database.
The data stays in `.devenv/state/postgres`. If the port is taken, `devenv up` stops and names the process that holds it.
Export `BETTER_AUTH_SECRET` first: at least 32 characters, stable across restarts.
`devenv up postgres` starts only the database. Without `devenv up`, set `BACKEND_PG_URL` in your shell
to a loopback PostgreSQL database URL without query parameters.

```bash
bun dev --help
devenv up
```

`bun dev` starts the homepage, dashboard, and native Bun backend through the existing Turbo tasks.
Its help output defines the ports, dashboard mount, and private-file paths. All HTTP listeners use `127.0.0.1`.
Database records and private files persist across restarts. Ctrl+C stops the owned application tasks, not existing services.

While `devenv up` runs, provision the native journey accounts of a new synthetic database before sign-in:

```bash
JOURNEY_SEED_PG_URL="postgresql://vektorprogrammet@127.0.0.1:$PGPORT/vektorprogrammet" \
  NATIVE_IDENTITY_DEPLOYMENT=local \
  NATIVE_IDENTITY_TRUSTED_ORIGINS='["http://127.0.0.1:5173"]' \
  bun --no-env-file apps/dashboard/e2e/native-users-journey-seed.mjs
```

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
bun run rehearsal:current-assignment
devenv --profile legacy shell -- bun run rehearsal:legacy-current-assignment --evidence-dir=/tmp/vektor-assignment-review
```

The reviewed-source journey also requires the selected PostgreSQL major. Its evidence directory must not exist.
It creates private, disposable MariaDB and PostgreSQL instances and uses synthetic legacy-shaped data.
It removes those instances after the run and retains an owner-only `report.json`. It does not access production or external providers.

The operator cutover command requires explicit assignment and Organization choices. Its help output defines the connection and review-file arguments:

```bash
bun --no-env-file tools/e2e/run-legacy-service-cutover.ts --help
```

`--current-assignments=none` leaves current assignments unimported. A private review file selects the reviewed-source path.
The [review schema](packages/placements/src/current-assignment-contracts.ts) defines the required evidence.
Current production data, human review, provider acceptance, and cutover authority remain separate gates.

### Reviewed Organization migration

Run the reviewed Organization journey:

```bash
devenv --profile legacy shell -- bun run rehearsal:legacy-organization --evidence-dir=/tmp/vektor-organization-review
```

This journey requires the selected PostgreSQL major and a new evidence directory. It uses synthetic records and private, disposable databases.
The cutover requires `--organization=none` or `--organization=PATH`. The first choice leaves Organization unchanged.

The [review schema](packages/domain/src/organization/review.ts) defines the required source evidence, intervals, and exclusions.
Organization resolves appointments through accepted Person mappings. Historical appointments and board membership do not imply current department or global authority.
Current source data, human review, provider acceptance, and cutover authority remain separate gates.

### Reviewed receipt migration

Run the reviewed receipt journey:

```bash
devenv --profile legacy shell -- bun run rehearsal:legacy-receipt --evidence-dir=/tmp/vektor-receipt-review
```

This journey requires the selected PostgreSQL major, a clean committed tree, and a new evidence directory.
It uses invented records, private file bytes, and disposable databases. It does not access production or external providers.

The receipt command runs separately, after accepted Person and reference reconciliation:

```bash
bun run migration:legacy-receipt --help
```

The [review schema](packages/domain/src/receipt/review.ts) defines the required source, ownership, department, date, account, and file evidence.
The command requires explicit connections, target identity, review, archive, custody roots, and payment key.
It requires an existing database schema and owner-only review, key, and custody paths.
SQL acceptance and file reconciliation remain separate. Exit status `2` means accepted receipts still need reconciliation.
Legacy refunded status never creates settlement evidence. Historical import still requires the missing file archive and reviewed ownership evidence.

### Combined migration candidate

Run the combined synthetic journey:

```bash
devenv --profile legacy shell -- bun run rehearsal:legacy-candidate --evidence-dir=/tmp/vektor-candidate-review
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
