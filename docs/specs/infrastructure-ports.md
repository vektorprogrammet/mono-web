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

## Team-application delivery pilot (operator decision, 2026-09-26)

Team-application notifications run on Effect `PersistedQueue` (`effect/unstable/persistence`, pinned at `effect@4.0.0-rc.116`) as a pilot. They start from `spike/persisted-queue-outbox-0925`. The other nine outboxes stay on their PostgreSQL tables and `outbox-lifecycle.ts`. Their move is decided from the pilot's evidence, one context at a time, never all at once. `EventLog` and `SqlEventJournal` are not delivery candidates: they journal handled events and do not schedule work.

The domain envelope keeps its identity and policy. The queue owns only the lease and the retry. The pilot lands when each of these has a test that fails when it breaks:

- The application, command receipt, envelope, and queue item commit or roll back together in one transaction, on PGlite and on PostgreSQL through PgBouncer in transaction mode.
- An expired lease is reclaimed, and a late former owner cannot record an outcome.
- Retries keep the envelope unchanged and the `effect_id` as the provider idempotency key.
- A permanent or ambiguous failure, and retry exhaustion, become the envelope's quarantine state, visible in the delivery status. Queue cleanup never deletes the only idempotency evidence while a command replay is possible.
- Cancellation and terminal scrubbing of private fields behave as in migration `0069`.
- The golden team-application journey and both fault modes pass on the polling trigger and on the bounded drain handler.
- A migration moves in-flight rows with their original ids and states, and the old claim columns are dropped only after no worker can write them.

A version bump of `effect` re-audits `PersistedQueue` against these tests before it lands.

### Pilot progress

Status on 2026-09-26, branch `feat/team-application-queue-pilot-0926`. Commit `d37481ae` ports the spike onto main.
Migration 0078 creates the store schema. It moves every outbox row onto a queue item with its id, status, and attempt count, fences the claim columns, and adds `team_application_delivery_state`. Migration 0079 drops the claim columns.
Each condition, with its tests in `packages/database/src/team-application/` unless named otherwise:

1. `delivery.test.ts` "commits the application, its receipt, both envelopes, and their queue items together, or none" (PGlite), and `delivery-pgbouncer.test.ts` with the same claim through PgBouncer in transaction mode. `startDisposablePgBouncer` in `tools/postgres` is the harness. PgBouncer restores a client's startup `search_path` only where the server reports it, so on PostgreSQL 17 the database must name it.
2. `delivery.test.ts` "reclaims an expired lease for another worker and rejects the late former owner's outcome" and "rejects a stalled attempt's outcome after its own worker took the lease again". An attempt writes its outcome only while the queue item still has its attempt number.
3. `delivery.test.ts` "retries with the stored envelope and the effect id as the provider idempotency key".
4. `delivery.test.ts` "quarantines permanent and ambiguous failures and the last attempt's failure, visible in the delivery status", "quarantines without a provider call when the last attempt's lease expired", and "keeps the outbox evidence through queue cleanup, so a replay after it delivers nothing again".
5. `delivery.test.ts` "cancels and clears undelivered notifications on deletion, also during an attempt" and "keeps the migration 0069 guards of terminal and private outbox rows".
6. Open. `apps/backend/src/team-application/worker.test.ts` runs both trigger functions against PostgreSQL. No golden run is recorded on either trigger yet.
7. `queue-migration.test.ts` "moves in-flight rows with their original ids and states, and drops the claim columns only after no worker can write them", on PostgreSQL and on PGlite, with the statements of the claim outbox.

Negative controls, run on 2026-09-26: each test of conditions 1 to 5 and 7 passed on the unchanged source and failed with an assertion when one guarantee was removed from it. The removed guarantees were the queue offer, the attempt number in the lease fence, the stored idempotency key, the failure-kind check of the quarantine policy, the skip of a settled effect, the cancellation of `Failed` rows, and the claim fence of migration 0078. The PgBouncer test passed on PostgreSQL 18.

Remaining steps, in order:

1. The operation grant, as the lead decided on 2026-09-26. It is a service-principal grant "may run operation X", where X is an operation entry of the capability registry (`packages/domain/src/authz/schema.ts`), so that the other outboxes reuse it. It uses its own table in the next free migration. The receipt-approval grants keep their semantics. `docs/model/authority.als` adds the grant to the MachineGrant fact and checks that a drain grant confers no business capability; `just model` passes.
2. The bounded drain handler: a POST operation of the native API that accepts an OAuth service bearer with the drain grant and runs `drainTeamApplicationOutbox` (`apps/backend/src/team-application/worker.ts`) up to its limit. `TEAM_APPLICATION_DELIVERY_TRIGGER=poll|drain` selects one trigger, and `apps/backend/src/main.ts` forks the worker only for `poll`.
3. The golden journey on both triggers: `TEAM_APPLICATION_DELIVERY_TRIGGER=drain` provisions a service client and its grant as fixtures, and the harness calls the drain handler as the external scheduler. Run `just golden team-application` and both fault modes on each trigger through `just measure`.
4. Add the drain trigger to `docs/delivery-recovery.md`. The second branch to land migration 0078 renumbers its migrations.

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
7. `just check` and the hosted Checks and Tests workflows pass.
