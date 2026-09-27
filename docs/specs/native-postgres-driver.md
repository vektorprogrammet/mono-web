[//]: # "generated from content/specs/native-postgres-driver.mdx by just docs generate; do not edit"

# Native PostgreSQL driver

Two scoped PostgreSQL pools and native Effect SQL driver compatibility.

Status: frozen for implementation on 2026-09-27. Remove this specification when every Effect package resolves to one version, the `@effect/sql-pg` exception is gone from the version check, and `AGENTS.md` and `docs/architecture.md` describe the pools.

## Goal

Move `packages/database` from `@effect/sql-pg` 4.0.0-rc.112, which wraps the `pg` library through `PgClient.fromPool`, to the native wire client, so every Effect package resolves to the same release (operator rule, 2026-09-27). Until this lands, rc.112 is the single named exception in the Effect version check.

## Evidence (research of 2026-09-27; re-verify before building)

- rc.113 (Effect PR #7426) removed `fromPool`, `fromClient`, and `makeWith`, and dropped the `pg` dependency. It also:
  - changes `types` to `PgTypes.Registry`;
  - stops treating object parameters as JSON;
  - rejects multi-statement query strings;
  - changes the result codecs (`int8` becomes `bigint`, `date` a string, timestamps `Date`, `bytea` `Uint8Array`, unknown OIDs text);
  - enables named prepared statements by default (`PgClientConfig.prepare`);
  - turns `listen` into a scoped dequeue.
    rc.114 sets the TLS SNI hostname by default for non-IP hosts. See the tagged CHANGELOG and `PgTypes.ts:1240-1320` at `effect@4.0.0-rc.116`.
- Better Auth and the Effect `Database` share one `pg.Pool` object, but they never share a transaction or a connection. `pgTransaction` is a client-scoped `BEGIN`/`COMMIT`; Better Auth's adapter calls and its hooks run outside any Effect transaction; transactional native commands read Better Auth's tables through Effect SQL (`authority.ts:121-160,270-355`). This comes from a code-path audit, not runtime tracing.
- No Effect v4 `@effect/sql-kysely` exists: 0.48.0 peers on Effect 3. Better Auth's PostgreSQL support is Kysely over a `pg.Pool` or `PostgresDialect`.
- Codec census: no uncast `int8` reads, no `bytea` reads, and no object-valued raw parameters were found. The 5 `Date` session fields match the new timestamp codec. Two seams run multi-statement SQL through `sql.unsafe`: migration execution (`layers.ts:73-74`) and the receipt file proof (`receipt/file-proof.ts:300-301`). Some test fixtures do too.
- The native client supports `prepare: false`. PgBouncer 1.21+ supports named prepared statements in transaction mode only when `max_prepared_statements` is nonzero.

## Decision

**Two pools.**

- The Effect `Database` uses the native client through `PgClient.layer`, owning its pool, with at most 8 connections (today's cap).
- Better Auth keeps its own `pg.Pool` through its supported Kysely/pg adapter, with at most 4 connections.
- That is 12 connections per backend process instead of 8. The deployment's connection budget must allow 12 × replicas, plus workers and CLIs.

A Kysely dialect over the native client and a custom Better Auth adapter are both rejected: one is unverified on v4, and the other reimplements adapter semantics.

## Rules

- Each pool is a scoped Layer that closes only its own pool. No module outside `packages/database` touches a `pg.Pool`, and `pgQuery`/`pgTransaction`/`pgWithClient` exist only for Better Auth's hooks, or are removed.
- Migration execution splits each migration file into statements with a parser that respects dollar quoting, comments, and string literals, and runs them in one transaction; or it uses the native client's documented multi-statement path if one exists. `just migration-hashes` and the upgrade proofs stay green.
- Named prepared statements are disabled (`prepare: false`) unless the deployment's PgBouncer sets `max_prepared_statements`. The choice is one configuration key, tested both ways.
- `auth` schema startup, TLS, and server-side `search_path` behave as today on both pools.
- Codecs are declared, not left to defaults (sql-pg CHANGELOG rc.113 #7426, rc.116 #8240 and #8241):
  - Every PostgreSQL enum or domain type that a query reads is registered through `PgTypes.register`, or cast to text in SQL. Unregistered OIDs now decode as UTF-8 text, and binary UDTs or enum arrays can garble a value or close the connection.
  - `Date` parameters now bind as `timestamptz`. Every write to a `timestamp without time zone` column is listed and either casts explicitly or pins the session `TimeZone`, so a write can't shift with the server's zone.
  - `±infinity` timestamps decode as an invalid `Date`. Find where they can occur and reject them.
- `multiplexConcurrency` (default 32) and `connectionTTL` are set explicitly, with their reasons, beside the pool size.

## Done when

1. `bun.lock` resolves `@effect/sql-pg` to the same version as `effect`, and the version check has no exception.
2. Pool ownership on real PostgreSQL: each pool honours its limit; shutting down with an active query or callback leaks no client; closing one pool doesn't affect the other.
3. Sign-in, password recovery, a cookie-authenticated native command, transactional session revocation, and a rolled-back command behave as today, shown by the existing identity and recovery suites plus the identity-postgres proof.
4. A fresh database and the migration upgrade proofs pass with the new migration runner. A migration with a dollar-quoted function body runs correctly (test).
5. `delivery-pgbouncer.test.ts`, plus a native-client transaction and a repeated query through PgBouncer in transaction mode, pass with `prepare: false`, and with `prepare: true` against `max_prepared_statements > 0`.
6. The golden journeys and `just check` pass, and the hosted workflows are green.

## Order

After the review fixes that touch `packages/database` land. They change `pg-pool.ts` callers: OAuthFix, OrganizationFix, AdmissionsCoreFix, EconomyFix, DeliveryFix, ContentTeamsFix.
