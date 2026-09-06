# Mono-web

Turborepo monorepo for Vektorprogrammet — Norwegian university tutoring program.

## Migration authority

Read [STATE.md](STATE.md) for active work and the accepted
[continuation plan](docs/migration/continuation-plan.md) for sequencing and
acceptance boundaries. Bind implementation to its file in `design-specs/`.
The migration targets the native application; Symfony source establishes
legacy behavior to assess, not a requirement to add another Symfony API layer.
Current executable contracts, package manifests and exact-revision runtime
evidence take precedence over historical stack examples below.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install all dependencies |
| `turbo build` | Build all packages |
| `turbo lint` | Lint all packages (oxlint) |
| `turbo test` | Run all test suites |
| `cd packages/sdk && bun run build` | Build SDK |
| `cd packages/sdk && bun run test` | Run SDK tests (60 tests) |
| `turbo -F @monoweb/homepage dev` | Dev server for homepage |
| `turbo -F @monoweb/dashboard dev` | Dev server for dashboard |

## Apps & Packages

| Package | Stack | Source | Description |
|---------|-------|--------|-------------|
| `@monoweb/homepage` | React Router, Tailwind, daisyUI | `apps/homepage/src/` | Public website |
| `@monoweb/dashboard` | React Router, Tailwind, shadcn | `apps/dashboard/app/` | Admin dashboard |
| `@monoweb/server` | Symfony 6.4, API Platform 3.4 | `apps/server/src/` | PHP backend (current production) |
| `@vektorprogrammet/sdk` | Effect-TS, @effect/platform | `packages/sdk/src/` | Domain-first API client |

## Conventions

- **Package manager:** Bun (not pnpm/npm)
- **Linter/formatter:** oxlint + oxfmt (not Biome/ESLint)
- **Path aliases:** `@/*` → source root for new code
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **Tests:** Each app owns its test runner. `turbo test` as unified interface.
- **CI:** Single GitHub Actions workflow — TS job (turbo) + PHP job (composer)

## SDK

`@vektorprogrammet/sdk` — domain-first typed client. Effect-TS internals, plain promise surface.

```typescript
import { createClient } from "@vektorprogrammet/sdk"

// Authenticated (dashboard loaders/actions)
const client = createClient("http://localhost:8000", { auth: token })
const page = await client.admin.receipts.list({ status: "pending" })
// page: { items: AdminReceipt[], totalItems: number, page: number, pageSize: number }

await client.admin.receipts.approve(id)  // domain operation, not PUT /status

// Unauthenticated (public pages)
const client = createClient("http://localhost:8000")
const sponsors = await client.public.sponsors()

// Effect-native (for Effect consumers)
import { createEffectClient } from "@vektorprogrammet/sdk/effect"
const page = yield* client.receipts.list()  // Effect<Page<Receipt>, SdkError>
```

**Key conventions:**
- Domain methods speak the ubiquitous language: `approve()` not `updateStatus("refunded")`
- Application status is `"received" | "invited" | ...` — never PHP integers
- Dates are `Date` objects, not ISO strings
- All methods throw `SdkError` subclasses on failure
- `client.context` exposes JWT-decoded role/department/teams for UI rendering
- Types inferred from Schema.Class — no hand-written interfaces
- See `docs/superpowers/specs/2026-03-21-sdk-redesign-design.md` for full spec
- See `docs/sdk-architecture.html` for architecture vision

## Docs

| Topic | Location |
|-------|----------|
| Architecture decisions | [`docs/adr/`](docs/adr/) |
| Migration roadmap | [`docs/migration/`](docs/migration/) |
| DDD/FCIS restructure spec | [`docs/superpowers/specs/2026-03-20-ddd-fcis-analysis-design.md`](docs/superpowers/specs/2026-03-20-ddd-fcis-analysis-design.md) |
| DDD restructure plan | [`docs/superpowers/plans/2026-03-20-ddd-restructure.md`](docs/superpowers/plans/2026-03-20-ddd-restructure.md) |
| SDK architecture vision | [`docs/sdk-architecture.html`](docs/sdk-architecture.html) |
| SDK redesign spec | [`docs/superpowers/specs/2026-03-21-sdk-redesign-design.md`](docs/superpowers/specs/2026-03-21-sdk-redesign-design.md) |
| Interface design principles | [`docs/interface-design.html`](docs/interface-design.html) |
| Server (PHP) | [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md) |

## Server (PHP)

See `apps/server/CLAUDE.md` for Symfony-specific rules, testing, and architecture.

Server commands run via composer, not turbo:
```bash
cd apps/server
composer test          # PHPUnit (1087+ tests)
composer lint          # PHP-CS-Fixer
composer analyse       # PHPStan
```

**After adding DB constraints/validation:** Always verify fixtures still load:
```bash
APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction
```
Broken fixtures cascade into 600+ silent test failures.
