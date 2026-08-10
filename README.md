# monoweb

Turborepo monorepo for [Vektorprogrammet](https://vektorprogrammet.no) — a Norwegian university tutoring program connecting STEM students with primary schools.

## Project Structure

```
monoweb/
├── apps/
│   ├── homepage/    # Public website (React Router, Tailwind, daisyUI)
│   ├── dashboard/   # Admin dashboard (React Router, Tailwind, shadcn)
│   └── server/      # PHP backend (Symfony 6.4, API Platform 3.4, MySQL)
├── packages/
│   └── sdk/         # Type-safe API client (@vektorprogrammet/sdk)
└── docs/
    ├── adr/         # Architecture Decision Records
    ├── migration/   # Migration roadmap and state contracts
    └── plans/       # Implementation plans
```

The PHP server (`apps/server`) is the backend. The frontends talk to it through the SDK (`packages/sdk`) — see [docs/migration/](docs/migration/) for the migration roadmap.

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

### Database Setup

**MySQL 8.0** backs the PHP server — provisioned automatically by `docker compose up`.

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start homepage + dashboard |
| `bun run dev:homepage` | Start homepage only |
| `bun run dev:dashboard` | Start dashboard only |
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

`@vektorprogrammet/sdk` is a hand-written, domain-first client for the Symfony API. Effect-TS internals (Schema types, tagged errors); plain promises on the surface.

```typescript
import { createClient } from "@vektorprogrammet/sdk";

const client = createClient("http://localhost:8000", { auth: token });

const page = await client.admin.receipts.list({ status: "pending" });
// { items: AdminReceipt[], totalItems, page, pageSize }
await client.admin.receipts.approve(id); // domain operation, not PUT /status

const sponsors = await client.public.sponsors(); // auth optional for public reads
```

Effect consumers import the Effect surface instead:

```typescript
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
// same domains, but methods return Effect<A, InternalSdkError> instead of Promise<A>
```

- Domains: `auth`, `me`, `receipts`, `admin.*`, `public.*`
- Failures throw `SdkError` subclasses (`UnauthorizedError`, `NotFoundError`, `ValidationError`, `ConflictError`, `NetworkError`, `RateLimitedError`)
- Dates are `Date`, statuses are strings (`"received" | "invited" | ...`) — the Symfony adapter maps them
- `client.context` exposes JWT-decoded role/department/teams for UI rendering

See [packages/sdk/src/](packages/sdk/src/) for the domain methods and [CLAUDE.md](CLAUDE.md#sdk) for conventions.

## Tooling

- **Package manager:** Bun
- **Monorepo:** Turborepo
- **Linting/formatting:** oxlint + oxfmt
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **SDK publishing:** Changesets (npm: `@vektorprogrammet/sdk`)
- **CI:** GitHub Actions — parallel TS (turbo) + PHP (composer) jobs
- **Git hooks:** Pre-commit runs lint, build, and changeset checks (`.githooks/`)
