# Mono-web

Turborepo monorepo for the Vektorprogrammet native replacement.

## Authority

Read [STATE.md](STATE.md) for current work.
Read [docs/system.md](docs/system.md) for intended product behavior.
Read [docs/architecture.md](docs/architecture.md) for technical boundaries.

The migration targets the native application. Symfony source establishes legacy
behavior to assess. It is not the target architecture.

For a non-trivial journey, create one active contract under `docs/specs/`.
Remove it after the accepted intent is represented by the system document, code,
and observable checks. Do not retain completed specifications, screenshots,
logs, generated references, or runtime evidence in the repository.

Current executable contracts, package manifests, and source code define the
implemented surface. Local observations do not authorize production action.

## Commands

| Command                           | Purpose                           |
| --------------------------------- | --------------------------------- |
| `bun install`                     | Install workspace dependencies    |
| `bun run build`                   | Build all product packages        |
| `bun run check-types`             | Check TypeScript packages         |
| `bun run test`                    | Run package test suites           |
| `bun run lint`                    | Run Oxlint                        |
| `bun run format:check`            | Check Oxfmt output                |
| `turbo -F @monoweb/homepage dev`  | Start the public frontend         |
| `turbo -F @monoweb/dashboard dev` | Start the staff frontend          |
| `bun run dev:server`              | Start the retained Symfony server |

Package manifests are authoritative for exact scripts.

## Packages

| Path                | Responsibility                                           |
| ------------------- | -------------------------------------------------------- |
| `apps/backend`      | Native Effect HTTP process and workers                   |
| `apps/homepage`     | Public React application                                 |
| `apps/dashboard`    | Authenticated React Router and Foldkit application       |
| `apps/server`       | Retained Symfony source and current production backend   |
| `packages/domain`   | Business values, transitions, failures, and authority    |
| `packages/database` | PostgreSQL schema, persistence, locks, audit, and outbox |
| `packages/http-api` | HTTP contracts, middleware declarations, and OpenAPI     |
| `packages/sdk`      | Generated native API client                              |
| `tools/e2e`         | Disposable local journey drivers                         |
| `tools/parity`      | Temporary migration analysis and safe runtime helpers    |

Keep the dependency graph in [docs/architecture.md](docs/architecture.md).
Product packages must not import migration tools or application source.

## TypeScript conventions

- Use Bun as package manager and runtime unless a target requires Node.
- Use Effect v4 as the application language for effectful code.
- Push concrete runtimes and vendors into Layer implementations.
- Use direct functions for total local calculations.
- Use Schema at external, persistence, and transport boundaries.
- Infer types from schemas. Do not duplicate interfaces.
- Use Oxfmt and Oxlint. Do not add another formatter or linter.
- Use generated SDK operations for frontend-to-backend communication.
- Model stateful dashboard workflows with one Foldkit Model.
- Treat UI roles and navigation as projections, not authority.

## Change rule

Implement one complete operational journey at a time. A route, schema, unit
test, or generated SDK method is not migration completion.

For a permanent behavior change:

1. Define the observable outcome and authority boundary.
2. Update domain, persistence, HTTP, SDK, and UI callers as one cutover.
3. Exercise the real UI, API, and PostgreSQL path.
4. Observe denial, concurrency, replay, and recovery where applicable.
5. Remove temporary scripts and the completed specification.
6. Update STATE.md and the intended system document when their facts change.

Production data, credentials, providers, deployments, writer transfer, and
legacy shutdown require explicit operator authority.

## Symfony source

Use `apps/server/CLAUDE.md` for Symfony-specific commands and constraints.
Server commands run through Composer:

```bash
cd apps/server
composer test
composer lint
composer analyse
```

After a database constraint or validation change, verify that fixtures load:

```bash
APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction
```
