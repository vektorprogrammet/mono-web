# Monorepo Architecture Design

Date: 2026-03-06
Status: Approved

## Context

Vektorprogrammet has four active repos that share tooling and will increasingly share code:

| Repo | Stack | Role |
|------|-------|------|
| `vektorprogrammet` | Symfony 6.4 / PHP 8.4 | Production monolith (server + legacy frontend) |
| `homepage` | React Router + shadcn + Tailwind | Public site (WIP) |
| `dashboard` | React Router + shadcn + Tailwind | Admin app (WIP) |
| `api` | Express 5 + Drizzle + Postgres + Zod | TS replacement backend (WIP) |

The Symfony API Platform endpoints serve as a bridge API for homepage/dashboard while the TS api catches up. Long-term, the TS api replaces Symfony entirely.

## Decision

Unify into a single `monoweb` monorepo. Fresh git history — old repos archived as read-only references.

## Scaffold

Bootstrapped via `create-better-t-stack` with: Bun, Turborepo, React Router, Express 5, Drizzle, Postgres, oxlint + oxfmt.

## Target Structure

```
monoweb/
├── apps/
│   ├── homepage/          # React Router 7 + shadcn + Tailwind v4 (was apps/web)
│   ├── dashboard/         # React Router 7 + shadcn + Tailwind v4 (new, from vektorprogrammet/dashboard)
│   ├── api/               # Express 5 + Drizzle + Zod (was apps/server, from vektorprogrammet/api)
│   └── server/            # Symfony 6.4 monolith (from vektorprogrammet/vektorprogrammet)
│       ├── package.json   # Turbo shim — wraps composer commands
│       ├── composer.json
│       ├── Dockerfile
│       └── ...
├── packages/
│   ├── db/                # Drizzle schema + migrations + docker-compose (from scaffold)
│   ├── env/               # Zod env validation (from scaffold)
│   ├── config/            # Shared tsconfig (from scaffold)
│   ├── ui/                # Shared React components (empty, future)
│   └── types/             # Shared API types/contracts (empty, future)
├── turbo.json
├── package.json           # Bun workspaces
├── docker-compose.yml     # All services: server + api + homepage + dashboard + mysql + postgres
├── .oxlintrc.json
├── .oxfmtrc.json
└── .github/workflows/
```

## Rearrangement Plan

From the Better T Stack scaffold:

| Scaffold | Target | Action |
|----------|--------|--------|
| `apps/web/` | `apps/homepage/` | Rename, replace contents with vektorprogrammet/homepage code |
| `apps/server/` | `apps/api/` | Rename, replace contents with vektorprogrammet/api code |
| — | `apps/dashboard/` | Create, copy from vektorprogrammet/dashboard |
| — | `apps/server/` | Create, copy Symfony monolith + add Turbo shim package.json |
| `packages/db/` | `packages/db/` | Keep (matches TS api's Drizzle stack) |
| `packages/env/` | `packages/env/` | Keep |
| `packages/config/` | `packages/config/` | Keep |
| — | `packages/ui/` | Create empty shell (future shared components) |
| — | `packages/types/` | Create empty shell (future shared API contracts) |

## Symfony Turbo Shim

The Symfony app participates in Turborepo via a thin `package.json` that wraps composer commands:

```json
{
  "name": "@monoweb/server",
  "private": true,
  "scripts": {
    "dev": "php -S 0.0.0.0:8000 -t public",
    "build": "composer dump-autoload --optimize",
    "test": "php -d memory_limit=512M bin/phpunit",
    "lint": "composer analyse",
    "check-types": "echo 'PHP: no TS types'"
  }
}
```

Turborepo doesn't care what scripts execute — it just needs `package.json` with named scripts matching `turbo.json` tasks. Caching works via `inputs` (`.php`, `composer.json`, `composer.lock` files) and `outputs`.

Reference: [Turborepo multi-language guide](https://turborepo.dev/docs/guides/multi-language)

## turbo.json Changes

Add `test` task to the scaffold's existing config:

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "inputs": ["$TURBO_DEFAULT$", ".env*"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "test": {},
    "lint": { "dependsOn": ["^lint"] },
    "check-types": { "dependsOn": ["^check-types"] }
  }
}
```

DB tasks (`db:push`, `db:studio`, etc.) remain from scaffold.

## Docker Compose (Root)

Single `docker-compose.yml` orchestrating all services:

```yaml
services:
  server:
    build: apps/server
    ports: ["8000:8000"]
    depends_on: [mysql]

  api:
    build: apps/api
    ports: ["3001:3001"]
    depends_on: [postgres]

  homepage:
    build: apps/homepage
    ports: ["3000:3000"]

  dashboard:
    build: apps/dashboard
    ports: ["3002:3002"]

  mysql:
    image: mysql:8.0

  postgres:
    image: postgres:16
```

Each app owns its own Dockerfile. Root compose file is for local development and staging.

## Environments

| Env | DB | Purpose |
|-----|-----|---------|
| **prod** | MySQL (server) / Postgres (api) | Deployed live, stable |
| **staging** | MySQL + Postgres (Docker) | Prod-like, test suite against real DB |
| **test** | SQLite in-memory (server) | Fast CI, local TDD |
| **dev** | SQLite in-memory (server) / Postgres (api) | Local development, live preview |

Future: PlanetScale (MySQL-compatible serverless) for prod server DB.

## Tooling

| Tool | Purpose |
|------|---------|
| **Bun** | Package manager + JS/TS runtime |
| **Turborepo** | Task orchestration, caching, workspace management |
| **oxlint** | Linting (replaces ESLint) |
| **oxfmt** | Formatting (replaces Prettier/Biome) |
| **Composer** | PHP dependency management (server only) |
| **PHPStan** | PHP static analysis (server only) |
| **PHP-CS-Fixer** | PHP code style (server only) |

## Migration Path

1. Rearrange scaffold (rename apps, add empty packages)
2. Copy Symfony monolith into `apps/server/`, add Turbo shim
3. Copy homepage, dashboard, api from their repos
4. Write root `docker-compose.yml`
5. Verify `turbo build`, `turbo test`, `turbo dev` work
6. Set up CI (GitHub Actions)
7. Archive old repos as read-only

## Non-Goals

- No shared UI components yet (future work when homepage/dashboard converge)
- No shared API types yet (future work as TS api matures)
- No git history preservation — old repos remain accessible
