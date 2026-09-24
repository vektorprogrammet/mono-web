# Vektorprogrammet native replacement

Vektorprogrammet connects volunteer university students with partner schools.
This repository contains the TypeScript replacement for the legacy PHP system.

Production still runs the legacy application. Native development and synthetic
local acceptance do not authorize production data access, deployment, or
cutover.

## Documentation

The durable documentation set is:

| File                                                                             | Authority                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [README.md](README.md)                                                           | Repository map and local commands                                      |
| [AGENTS.md](AGENTS.md)                                                           | Project development, verification, resource, and cleanup practices     |
| [STATE.md](STATE.md)                                                             | Current migration state, evidence limits, and next work                |
| [docs/system.md](docs/system.md)                                                 | Intended product, domain, ownership, authority, and journeys           |
| [docs/architecture.md](docs/architecture.md)                                     | Runtime, dependencies, persistence, delivery, and interface boundaries |
| [docs/operational-responsibility-map.md](docs/operational-responsibility-map.md) | Stakeholders, end-to-end processes, and replacement contracts          |
| [docs/enterprise-models.md](docs/enterprise-models.md)                           | 4EM and ArchiMate views derived from the system documents              |

Create one file in `docs/specs/` only while a non-trivial journey is active.
Remove the completed specification after its durable intent is present in the
system document, code, and observable checks.

Code and generated contracts are authoritative for current implementation.
Do not keep generated code reference, runtime evidence, screenshots, logs, or
dated migration reports in the repository.

## Repository map

```text
apps/backend       native Effect HTTP process and workers
apps/homepage      public React application
apps/dashboard     authenticated React Router and Foldkit application
apps/server        retained Symfony source for legacy behavior
packages/domain    business values, transitions, failures, and authority
packages/database  PostgreSQL migrations, persistence, locks, audit, and outbox
packages/http-api  transport schemas, middleware contracts, and OpenAPI
packages/sdk       generated native API client
tools              bounded development and migration tools
docs               intended system, architecture, operations, and active specs
```

The legacy Symfony source is an input to migration decisions. It is not the
target architecture.

## Toolchain

The [root manifest](package.json) and lockfile own tool versions and the dependency catalog.
The application uses Bun, TypeScript, Effect, PostgreSQL, React Router, Foldkit, Oxfmt, and Oxlint.
The PostgreSQL adapter pin preserves the pool shared by Database and Better Auth.
See [development practices](AGENTS.md#building-reference) before changing it.

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

Run one heavy validation job at a time. Turbo concurrency does not bound each package runner.
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

For native development, configure the backend dependencies before starting these commands in separate terminals:

```bash
bun run --cwd apps/backend dev
bun run dev
```

The first command starts the native backend. The second starts only the homepage and dashboard.
The retained Symfony application uses `bun run dev:server`. It is not the native backend.
Package manifests define exact scripts. These commands do not authorize production or provider access.

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
