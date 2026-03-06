# Mono-web

Turborepo monorepo for Vektorprogrammet — Norwegian university tutoring program.

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
| `@monoweb/sdk` | openapi-fetch, openapi-react-query | `packages/sdk/src/` | Type-safe API client |

## Conventions

- **Package manager:** Bun (not pnpm/npm)
- **Linter/formatter:** oxlint + oxfmt (not Biome/ESLint)
- **Path aliases:** `@/*` → source root for new code
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **Tests:** Each app owns its test runner. `turbo test` as unified interface.
- **CI:** Single GitHub Actions workflow — TS job (turbo) + PHP job (composer)

## SDK

`@monoweb/sdk` auto-generates a type-safe API client from the Symfony OpenAPI spec.

Pipeline: `api:spec` (export from Symfony) → `generate` (openapi-typescript) → `build` (tsc)

Consumer usage:
```typescript
import { createClient, createQueryApi } from "@monoweb/sdk";

// Imperative (loaders, server-side)
const api = createClient("http://localhost:8000");
const { data } = await api.GET("/api/public/departments");

// Declarative (React components with TanStack Query)
const $api = createQueryApi("http://localhost:8000");
const { data, isLoading } = $api.useQuery("get", "/api/public/departments");
```

Regenerate types: `turbo run generate` (or `cd packages/sdk && bun run generate`).

## Server (PHP)

See `apps/server/CLAUDE.md` for Symfony-specific rules, testing, and architecture.

Server commands run via composer, not turbo:
```bash
cd apps/server
composer test          # PHPUnit (1001 tests)
composer lint          # PHP-CS-Fixer
composer analyse       # PHPStan
```
