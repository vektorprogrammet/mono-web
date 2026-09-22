# Vektorprogrammet native replacement

Vektorprogrammet connects volunteer university students with partner schools.
This repository contains the TypeScript replacement for the legacy PHP system.

Production still runs the legacy application. Native development and synthetic
local acceptance do not authorize production data access, deployment, or
cutover.

## Documentation

The durable documentation set is:

| File                                                                             | Authority                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [README.md](README.md)                                                           | Repository map and local commands                                           |
| [STATE.md](STATE.md)                                                             | Current migration state, gaps, and next work                                |
| [docs/system.md](docs/system.md)                                                 | Intended product, domain, ownership, authority, and journeys                |
| [docs/architecture.md](docs/architecture.md)                                     | Intended runtime, dependency, persistence, delivery, and cutover boundaries |
| [docs/operational-responsibility-map.md](docs/operational-responsibility-map.md) | Stakeholders, end-to-end processes, ownership, and migration gaps           |
| [docs/enterprise-models.md](docs/enterprise-models.md)                           | 4EM and ArchiMate views derived from the durable system documents           |

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

- Bun 1.3
- TypeScript 7
- Effect v4
- PostgreSQL
- React Router
- Foldkit
- Oxfmt and Oxlint

Run commands from this repository root:

```bash
bun install
bun run build
bun run check-types
bun run test
bun run lint
bun run format:check
```

Use focused package commands during development:

```bash
turbo -F @monoweb/domain test
turbo -F @monoweb/database test
turbo -F @monoweb/http-api test
turbo -F @monoweb/sdk test
turbo -F @monoweb/backend test
turbo -F @monoweb/dashboard test
```

Start the local applications:

```bash
bun run dev
bun run dev:server
```

Package manifests are the source of truth for exact scripts.

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
