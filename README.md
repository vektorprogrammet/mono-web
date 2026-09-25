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
| [docs/system-walkthrough.mdx](docs/system-walkthrough.mdx)                       | Layered reading guide with MDXCN figures; source for the standalone HTML                   |
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
apps/server        retained Symfony source for legacy behavior
packages/domain    business values, transitions, failures, and authority
packages/database  PostgreSQL migrations, persistence, locks, audit, and outbox
packages/placements portable Placements contracts and private server implementation
packages/http-api  transport schemas, middleware contracts, and OpenAPI
packages/sdk       generated native API client
tools/verification cross-application PostgreSQL proofs and migration rehearsals
tools              other bounded development and migration tools
docs               intended system, architecture, operations, and active specs
```

The legacy Symfony source is an input to migration decisions. It is not the
target architecture.

## Toolchain

The [root manifest](package.json) and lockfile own tool versions and the dependency catalog.
The application uses Bun, TypeScript, Effect, PostgreSQL, React Router, Foldkit, Oxfmt, and Oxlint.
The PostgreSQL adapter pin preserves the pool shared by Database and Better Auth.
See [development practices](AGENTS.md#building-reference) before changing it.

The pinned project shell provides Lefthook:

```bash
devenv shell -- lefthook --version
```

This adds the executable, not a hook policy. The existing Git hook has no matching
Lefthook configuration. No hooks are installed or replaced by this shell.

The root manifest declares a type-only Effect patch. It preserves union-command
requests and callable Fetch inputs across runtimes. SDK type checks cover both
contracts, including Bun types. Remove the patch when upstream declarations pass
those checks without it.

Backend tests start private PostgreSQL clusters and create an isolated database
for each fixture. Put `initdb`, `pg_ctl`, and `psql` on `PATH`. Install the
PostgreSQL contrib extensions, including `btree_gist`. No shared database is used.

Run commands from this repository root:

```bash
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
bun run --cwd packages/http-api generate:check
```

Homepage builds require a clean committed source artifact. Do not weaken that provenance guard for a dirty operator tree.
Use a separate source-matched committed snapshot for acceptance, as described in [AGENTS.md](AGENTS.md#verification-and-resources).

### Layered system walkthrough

Open [the standalone guide](docs/system-walkthrough.html) in a browser.
Edit [its MDX source](docs/system-walkthrough.mdx), then regenerate it:

```bash
bun install --frozen-lockfile
bun run docs:system
```

The build uses the vendored MIT MDXCN component and embeds all styles.
The resulting HTML needs no server, JavaScript, or external assets.
The renderer records upstream provenance in [its manifest](tools/system-guide/vendor/mdxcn/provenance.json).

### Local native development

Use a dedicated local PostgreSQL database with synthetic data. Do not use a shared database or a production tunnel.
The backend applies schema migrations and can write application data. The launcher does not create or reset PostgreSQL.

Set `BACKEND_PG_URL` and `BETTER_AUTH_SECRET` in your shell or the ignored root `.env`.
The URL must name a loopback PostgreSQL database without query parameters.
Use a secret of at least 32 characters, and keep it stable across restarts.

```bash
bun dev --help
bun dev
```

`bun dev` starts the homepage, dashboard, and native Bun backend through the existing Turbo tasks.
Its help output defines the ports, dashboard mount, and private-file paths. All HTTP listeners use `127.0.0.1`.
Database records and private files persist across restarts. Ctrl+C stops the owned application tasks, not existing services.

For a new synthetic database, provision the native journey accounts separately before sign-in:
If you use `.env`, export `BACKEND_PG_URL` in your shell before this seed command.

```bash
JOURNEY_SEED_PG_URL="$BACKEND_PG_URL" \
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
Release builds still require clean committed source. The retained Symfony application uses `bun run dev:server`.
No development command authorizes production access or cloud provisioning.

### Current-assignment migration rehearsal

Run the original synthetic boundary and the reviewed-source journey separately:

```bash
bun run rehearsal:current-assignment
nix shell nixpkgs#mariadb -c bun run rehearsal:legacy-current-assignment --evidence-dir=/tmp/vektor-assignment-review
```

The reviewed-source journey also requires PostgreSQL tools on `PATH`. Its evidence directory must not exist.
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
nix shell nixpkgs#mariadb -c bun run rehearsal:legacy-organization --evidence-dir=/tmp/vektor-organization-review
```

This journey requires PostgreSQL tools on `PATH` and a new evidence directory. It uses synthetic records and private, disposable databases.
The cutover requires `--organization=none` or `--organization=PATH`. The first choice leaves Organization unchanged.

The [review schema](packages/domain/src/organization/review.ts) defines the required source evidence, intervals, and exclusions.
Organization resolves appointments through accepted Person mappings. Historical appointments and board membership do not imply current department or global authority.
Current source data, human review, provider acceptance, and cutover authority remain separate gates.

### Reviewed receipt migration

Run the reviewed receipt journey:

```bash
nix shell nixpkgs#mariadb -c bun run rehearsal:legacy-receipt --evidence-dir=/tmp/vektor-receipt-review
```

This journey requires PostgreSQL tools on `PATH`, a clean committed tree, and a new evidence directory.
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
nix shell nixpkgs#mariadb nixpkgs#php -c bun run rehearsal:legacy-candidate --evidence-dir=/tmp/vektor-candidate-review
```

The command requires PostgreSQL tools on `PATH`, a clean committed tree, and a new evidence directory.
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
