# 0112 - Native architecture simplification

Status: frozen for local implementation, 2026-09-21. Production release is not part of this work.

Baseline: `d19a4fb280f081af5f5ced4c76c6a55f0dd57d25` (`migration/assistant-operations-0906`).

## Goal

A maintainer can change one native capability without crossing a reverse package dependency or a Promise runtime bridge.

The product remains one modular backend, one public frontend, one staff frontend, one PostgreSQL database, and one published SDK.

This work changes internal ownership. It does not add product behavior, change the public HTTP contract, or change production authority.

## Required dependency graph

The final product graph uses these edges:

```text
packages/database  -> packages/domain
packages/http-api  -> packages/domain
packages/sdk       -> packages/http-api
apps/backend       -> packages/domain + packages/database + packages/http-api
apps/homepage      -> packages/sdk + packages/http-api
apps/dashboard     -> packages/sdk + packages/http-api
```

The graph applies these rules:

1. `packages/domain` contains values, failures, pure policy, authority algebra, and external-effect ports.
2. `packages/domain` contains no PostgreSQL adapter, migration, HTTP receipt table, Bun runtime, or process service.
3. `packages/database` owns the shared pool, migrations, row codecs, PostgreSQL operations, and Better Auth implementation.
4. `packages/http-api` owns public and internal endpoint contracts, transport schemas, middleware declarations, and OpenAPI generation.
5. `apps/backend` owns HTTP orchestration, transaction boundaries, workers, and concrete file, mail, and HTTP adapters.
6. The frontend applications do not import database code or domain implementation barrels.
7. Product code does not import `tools`, migration documentation, or evidence code.

## Runtime boundary

Native endpoint handlers remain in Effect from request decoding through response encoding.

The implementation removes these transitional mechanisms:

- `BackendRun`.
- `withNativeHttpRuntime`.
- Promise handlers wrapped by `toHttpApiResponse`.
- Passthrough implementations of declared security middleware.

The HTTP runtime supplies authenticated principals through real middleware. Anonymous endpoints use an explicit anonymous context.

One transaction combinator retains these semantics:

- Serializable isolation for native commands.
- The existing advisory lock and idempotency-key scope.
- Current authority evaluation before replay.
- Atomic domain, audit, outbox, and HTTP receipt writes.
- Exact replay, digest conflict, in-flight, and expiry behavior.

The public and internal API roots stay separate. The internal receipt evidence API does not enter public OpenAPI.

## Service boundary

A Service stays only when it owns one of these properties:

- A resource lifecycle.
- External authority.
- A replaceable external effect.
- A policy boundary with more than a function alias.

The implementation keeps these capabilities:

- The PostgreSQL pool and database transaction service.
- Identity, transaction-bound identity snapshots, OAuth authority, and service-principal authority.
- Organization authority.
- Receipt file custody, receipt auxiliary effects, notification delivery, and mail delivery.
- Economy as the financial authority.

The implementation removes forwarding-only Services and Layers for school surveys, social events, and schools.

After the HTTP cutover, the implementation removes forwarding-only bindings for admissions, recruitment, and profile. Direct Effect programs expose their real requirements.

## Persistence ownership

Move the `Database` contract and every PostgreSQL implementation from `packages/domain` to `packages/database`.

Move all SQL migrations to `packages/database/migrations`.

The migration move must preserve:

- Each migration identifier.
- The migration order.
- The exact SQL bytes.
- The schema revision.
- Existing checksum behavior.

Pure placement policy moves out of PostgreSQL modules. Locks, queries, constraints, and audit writes stay in database adapters.

The PostgreSQL HTTP-receipt transaction moves from domain code to a backend HTTP adapter.

## Contract ownership

The public wire contract does not change.

The backend uses the schemas from `packages/http-api`. It does not define duplicate directory or profile response schemas.

Split `v2-schemas.ts` by the capability that owns each schema. Preserve every exported identifier and wire codec.

Keep these generated artifacts:

- `packages/http-api/openapi.json`.
- `packages/http-api/release-manifest.json`.
- `packages/sdk/native-api-operations.json`.

Remove `apps/backend/src/generated/native-api-metadata.json` after its documentation-only checks move to the contract generator.

## Tooling ownership

Move migration-only code to these roots:

```text
tools/parity
tools/e2e
tools/migration-docs
tools/preview-host
```

Move the legacy Symfony OpenAPI snapshot to `evidence/legacy-contract`.

Scenario-specific seeds and assertions stay explicit. Shared disposable-stack code can own process groups, ports, PostgreSQL startup, proxy startup, and evidence writes.

Do not add a universal journey description language.

Migration documentation retains a separate generation check and deployment command. The normal product build does not depend on migration-document freshness.

The legacy Symfony application and preview evidence stacks remain until their accepted retirement gates. This work only makes their temporary status explicit.

## Frontend boundary

Keep the homepage and dashboard as separate deployments.

The homepage remains the public host. The dashboard remains the authenticated staff host.

Both applications call the backend through the SDK or an app-local security adapter.

The dashboard keeps Foldkit inside the application. It does not become a separate package or deployment.

Stateful dashboard workflows use Foldkit as their state model. React Router remains the route and server-rendering shell.

Remove direct frontend imports from database modules and domain implementation barrels.

Use one Tailwind major version. Prefer `@foldkit/ui` for stateful application controls. Keep another library only when it provides a capability that Foldkit does not provide.

## Non-goals

This work does not:

- Split the backend into network services.
- Merge the homepage and dashboard.
- Add one package for each capability.
- Change routes, response bodies, status codes, headers, or SDK method names.
- Change database data, production credentials, providers, deployments, or production authority.
- Remove the legacy application before an authorized cutover.
- Replace the existing idempotency, authority, audit, outbox, or private-file rules.

## Acceptance

The change is complete when all these statements are true:

1. Workspace package imports match the required graph.
2. No product package imports an application source path.
3. No domain source imports SQL, PostgreSQL, Bun, Node process APIs, or HTTP transport code.
4. Historical migration checksums and schema revision are unchanged.
5. Native endpoint handlers do not use `BackendRun`, `withNativeHttpRuntime`, or `toHttpApiResponse`.
6. Declared security middleware resolves the request principal or rejects the request.
7. External and internal OpenAPI boundaries remain distinct.
8. Generated OpenAPI and SDK operation inventories have no semantic drift.
9. Dashboard and homepage production source imports only SDK and HTTP contract surfaces for backend communication.
10. Forwarding-only Services and Layers named in this contract are absent.
11. Product build and type checks do not run migration-document generation.
12. Migration tools run through stable `tools` entrypoints.
13. Focused package checks pass for domain, database, HTTP API, SDK, backend, homepage, and dashboard.
14. A real local browser, native API, and disposable PostgreSQL journey passes for one anonymous and one authenticated capability.
15. Replay, authority rejection, and transaction rollback behavior pass in the selected runtime journeys.
16. No production, provider, credential, remote, or deployment effect occurs.

## Implementation order

1. Move migration tooling without changing product code.
2. Move database ownership and preserve migration bytes.
3. Replace the HTTP Promise bridge.
4. Remove forwarding-only Services and Layers.
5. Seal frontend imports and remove superseded UI dependencies.
6. Run package checks and the selected runtime journeys.
7. Remove temporary compatibility files from this cutover.
8. Update `STATE.md` with the exact accepted revision and evidence boundary.
