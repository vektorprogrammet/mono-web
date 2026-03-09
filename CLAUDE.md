# Mono-web

Turborepo monorepo for Vektorprogrammet — Norwegian university tutoring program.

## Migration Timeline

```yaml
A0:
  operation: Migrate Controller methods to API Platform routes
  requirements: []
  effect: Decouples frontend Twig templates and Controller logic
  constraint: API Platform exposes interface equivalent to Controller Methods
A1:
  operation: Add API SDK
  requirements: [A0, A callable API Endpoint]
  effect: Decouples API from backend
  constraint": Constrain invalid states by hiding and invalidating illegal actions
B0:
  operation: "Connect new homepage"
  requirements: A0
B1:
  operation: "Connect new dashboard"
  requirements: A1
C0:
  operation: 
  requirements: A1
```

1. Faithful migration from Controllers to API Platform (apps/server)
2. Add SDK adhering to the state space constraints for API Platform
3. Connect new frontend (homepage & dashboard) to API SDK

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install all dependencies |
| `turbo build` | Build all packages |
| `turbo lint` | Lint all packages (oxlint) |
| `turbo test` | Run all test suites |
| `turbo run generate` | Regenerate SDK types from OpenAPI spec |
| `turbo -F @monoweb/homepage dev` | Dev server for homepage |
| `turbo -F @monoweb/dashboard dev` | Dev server for dashboard |
| `turbo -F @monoweb/api dev` | Dev server for API |

## Apps & Packages

| Package | Stack | Source | Description |
|---------|-------|--------|-------------|
| `@monoweb/homepage` | React Router, Tailwind, daisyUI | `apps/homepage/src/` | Public website |
| `@monoweb/dashboard` | React Router, Tailwind, shadcn | `apps/dashboard/app/` | Admin dashboard |
| `@monoweb/api` | Express 5, Drizzle, Zod | `apps/api/src/` | TS API (future backend) |
| `@monoweb/server` | Symfony 6.4, API Platform 3.4 | `apps/server/src/` | PHP backend (current production) |
| `@vektorprogrammet/sdk` | openapi-fetch, openapi-react-query | `packages/sdk/src/` | Type-safe API client |

## Conventions

- **Package manager:** Bun (not pnpm/npm)
- **Linter/formatter:** oxlint + oxfmt (not Biome/ESLint)
- **Path aliases:** `@/*` → source root for new code
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **Tests:** Each app owns its test runner. `turbo test` as unified interface.
- **CI:** Single GitHub Actions workflow — TS job (turbo) + PHP job (composer)

## SDK

`@vektorprogrammet/sdk` auto-generates a type-safe API client from the Symfony OpenAPI spec.

Pipeline: `api:spec` (export from Symfony) → `generate` (openapi-typescript) → `build` (tsc)

Consumer usage:
```typescript
import { createClient, createQueryApi } from "@vektorprogrammet/sdk";

// Imperative (loaders, server-side)
const api = createClient("http://localhost:8000");
const { data } = await api.GET("/api/public/departments");

// Declarative (React components with TanStack Query)
const $api = createQueryApi("http://localhost:8000");
const { data, isLoading } = $api.useQuery("get", "/api/public/departments");
```

Regenerate types: `turbo run generate` (or `cd packages/sdk && bun run generate`).

## Docs

| Topic | Location |
|-------|----------|
| Architecture decisions | [`docs/adr/`](docs/adr/) |
| Migration roadmap | [`docs/migration/`](docs/migration/) |
| Server (PHP) | [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md) |

## Server (PHP)

See `apps/server/CLAUDE.md` for Symfony-specific rules, testing, and architecture.

Server commands run via composer, not turbo:
```bash
cd apps/server
composer test          # PHPUnit (1001 tests)
composer lint          # PHP-CS-Fixer
composer analyse       # PHPStan
```
