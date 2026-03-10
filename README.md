# monoweb

Turborepo monorepo for [Vektorprogrammet](https://vektorprogrammet.no) — a Norwegian university tutoring program connecting STEM students with primary schools.

## Project Structure

```
monoweb/
├── apps/
│   ├── homepage/    # Public website (React Router, Tailwind, daisyUI)
│   ├── dashboard/   # Admin dashboard (React Router, Tailwind, shadcn)
│   ├── api/         # TypeScript API (Express 5, Drizzle, PostgreSQL)
│   └── server/      # PHP backend (Symfony 6.4, API Platform 3.4, MySQL)
├── packages/
│   └── sdk/         # Type-safe API client (@vektorprogrammet/sdk)
└── docs/
    ├── adr/         # Architecture Decision Records
    ├── migration/   # Migration roadmap and state contracts
    └── plans/       # Implementation plans
```

The PHP server (`apps/server`) is the current production backend. The TypeScript API (`apps/api`) and SDK (`packages/sdk`) are part of an incremental migration — see [docs/migration/](docs/migration/) for details.

## Getting Started

```bash
bun install
```

### Local Development

Start the frontend apps (homepage + dashboard):

```bash
bun run dev
```

Start the PHP server with Docker (MySQL included):

```bash
docker compose up server mysql
```

| App | URL | Start command |
|-----|-----|---------------|
| Homepage | http://localhost:5173 | `bun run dev:homepage` |
| Dashboard | http://localhost:5174 | `bun run dev:dashboard` |
| PHP Server | http://localhost:8000 | `bun run dev:server` (or Docker) |
| TS API | http://localhost:3000 | `bun run dev:api` |

### Database Setup

The project has two databases:

- **MySQL 8.0** for the PHP server — provisioned automatically by `docker compose up`
- **PostgreSQL 16** for the TS API — provisioned by `docker compose up` or set `DATABASE_URL` in `apps/api/.env`

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start homepage + dashboard |
| `bun run dev:homepage` | Start homepage only |
| `bun run dev:dashboard` | Start dashboard only |
| `bun run dev:api` | Start TS API only |
| `bun run dev:server` | Start PHP server only |
| `bun run build` | Build all packages |
| `bun run lint` | Lint all packages (oxlint) |
| `bun run test` | Run all test suites |
| `bun run check` | Run oxlint + oxfmt |
| `bun run check-types` | TypeScript type checking |

PHP server commands run via composer, not turbo:

```bash
cd apps/server
composer test       # PHPUnit (1001 tests)
composer lint       # PHP-CS-Fixer
composer analyse    # PHPStan
```

## SDK

`@vektorprogrammet/sdk` is a type-safe API client auto-generated from the Symfony OpenAPI spec.

```bash
turbo run generate   # Regenerate types from OpenAPI spec
```

```typescript
import { createClient, createQueryApi } from "@vektorprogrammet/sdk";

const api = createClient("http://localhost:8000");
const { data } = await api.GET("/api/public/departments");
```

See [packages/sdk/](packages/sdk/) for full usage.

## Tooling

- **Package manager:** Bun
- **Monorepo:** Turborepo
- **Linting/formatting:** oxlint + oxfmt
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **SDK publishing:** Changesets (npm: `@vektorprogrammet/sdk`)
- **CI:** GitHub Actions — parallel TS (turbo) + PHP (composer) jobs
- **Git hooks:** Pre-commit runs lint, build, and changeset checks (`.githooks/`)
