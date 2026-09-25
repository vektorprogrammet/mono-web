# Infrastructure ports

Status: frozen for implementation on 2026-09-25. Remove this specification when the architecture document, the code, and the checks below represent it.

## Goal

The application does not know whether it runs on a platform service or a self-hosted container.
Every required service is an Effect service with interchangeable Layers. Only the composition root selects a Layer, and it does so from configuration.
The same commit can run locally, in CI, in a preview, and on a host such as a container platform with managed PostgreSQL and object storage, without code changes.

## Ports

| Port | What the application requires | Layers |
| --- | --- | --- |
| `Database` | PostgreSQL 17 or 18 with `btree_gist`; only transaction-scoped advisory locks, so a transaction pooler works; TLS configurable | local devenv service, disposable test cluster, managed PostgreSQL by URL |
| `ReceiptFileStore` | private object storage with conditional create, no-follow reads, and deletion | local filesystem; S3-compatible API (Supabase Storage, DigitalOcean Spaces, Cloudflare R2, MinIO) |
| `Mail` | idempotent delivery of one rendered message per effect | HTTP relay, recording double, provider Layers added as needed |
| `OutboxDrain` | bounded delivery of committed effects per aggregate | see Triggers |
| Configuration | typed configuration read once at the composition root | Effect `ConfigProvider` from environment; optional `*_FILE` secrets |
| Frontend serving | one public origin that routes `/api` to the backend, dashboard routes to the dashboard, and the rest to the homepage | Bun servers behind the provider-neutral router module; Cloudflare Workers for frontend previews |

## Triggers for outbox delivery

- `drainOnce` is the unit of delivery for an aggregate. It recovers stale claims, claims one effect, delivers it, and records the outcome through `outbox-lifecycle.ts`.
- A polling Layer runs `drainOnce` in a forked loop for long-running hosts.
- A bounded drain handler runs `drainOnce` up to a limit per call, for hosts that scale to zero. An external scheduler calls it; the caller needs a service-principal grant for the drain operation.
- Password reset and onboarding delivery move onto `outbox-lifecycle.ts` before they get a drain.
- `apps/backend/src/main.ts` selects exactly one trigger Layer per aggregate from configuration.

## Rules

- No module outside a Layer imports a provider SDK, a platform binding, or a runtime-specific module.
- Test adapters, such as the PGlite database Layer, are not reachable from production entry points.
- `withSessionAdvisoryLock` in the OAuth adapter becomes a transaction-scoped lock.
- The browser builds read their API origin and CSRF origins at runtime instead of baking them in at build time.
- One Nix-built image contains the backend and both frontend servers; the command selects the process.

## Boundaries

- No provider account, deployment, or credential is created as part of this work.
- Behaviour, wire contracts, and schema stay the same, except for the lock change and new configuration keys.
- Durable workflows, reminders, and scheduled jobs are out of scope. They use Effect cluster (`ClusterCron`, `DeliverAt`, workflows) in a later specification.

## Done when

1. The backend starts and passes its tests with the filesystem Layer and with the S3-compatible Layer against a local MinIO.
2. A production-only install starts the backend. No test adapter is present in its dependency graph.
3. With the polling trigger, the golden team-application journey and both fault modes pass. With only the bounded drain handler and an external call, the same journey delivers every notification.
4. The backend runs its tests against a PostgreSQL connection through a transaction pooler (PgBouncer in transaction mode) with no failures.
5. One image built from the commit serves the homepage, dashboard, and backend behind the router in a compose stack with a local PostgreSQL, and the golden journey passes against it.
6. A lint rule rejects provider and runtime imports outside Layer modules, with a negative control.
7. `bun run check` and the hosted Checks and Tests workflows pass.
