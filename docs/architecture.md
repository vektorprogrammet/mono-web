# Intended architecture

**Status:** Target architecture for the native replacement. Revised 2026-09-23.

See [system.md](system.md) for business meaning and [STATE.md](../STATE.md) for
current implementation status.

## Product shape

The target remains one modular backend, two browser applications, one PostgreSQL
database, and one generated client contract.

```text
apps/homepage  -----> packages/sdk ----+
                                        |
apps/dashboard ----> packages/sdk ----> packages/http-api
                                        |
                                   apps/backend
                                        |
                               packages/database
                                        |
                                  PostgreSQL

packages/domain <--- database, HTTP adapters, and applications depend on it
```

`apps/server` is retained Symfony source and the current production backend. It is
not part of the target dependency graph. Remove it only after an authorized cutover
has transferred every required writer and reader.

## Ownership

| Path                | Owns                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/domain`   | Business values, state transitions, failures, capability requirements, and service contracts                 |
| `packages/database` | PostgreSQL schema, migrations, repositories, transactions, locks, audit, idempotency, and outbox persistence |
| `packages/http-api` | Public and internal HTTP groups, middleware declarations, schemas, and generated OpenAPI                     |
| `packages/sdk`      | Generated consumer operations and boundary decoding                                                          |
| `apps/backend`      | Native process composition, HTTP serving, delivery workers, and runtime configuration                        |
| `apps/homepage`     | Anonymous and public journeys                                                                                |
| `apps/dashboard`    | Authenticated applicant, volunteer, coordinator, leader, and administrator journeys                          |
| `tools/e2e`         | Disposable local journey drivers                                                                             |
| `tools/parity`      | Temporary migration analysis and safe runtime helpers                                                        |

A business fact has one owner. Other modules use its public contract. They do not
write its tables or duplicate its rules.

## Dependency rules

```text
apps/*                  -> packages/http-api, packages/sdk, packages/domain
packages/http-api       -> packages/domain
packages/database       -> packages/domain
packages/sdk            -> generated HTTP contract
packages/domain         -> Effect only
```

Required rules:

- `packages/domain` must not import database, HTTP, application, browser, provider,
  or migration-tool code.
- Product packages must not import from `tools`.
- Frontends communicate through the generated SDK. They do not import backend or
  database implementation.
- A service exists for a dependency, authority, replaceable policy, or owned
  lifecycle. A total local calculation stays a direct function.
- Concrete runtimes and vendors belong in Layer implementations and composition
  roots.
- Do not add a microservice until an observed operational need requires an
  independent deployment boundary.

## Domain services

The current domain package exposes service contracts for these capability groups:

- Identity
- Profile
- Admissions
- Recruitment
- Organization
- Schools
- Placements
- Substitutes
- Economy
- Content
- Content management
- Social events
- Surveys
- Private file storage
- Notification delivery

A service contract uses domain commands, facts, failures, and observations. It does
not expose database rows or transport objects.

## Boundary encoding

Use Effect Schema at every external or durable boundary:

- HTTP request and response;
- environment and configuration;
- database read and write;
- provider payload;
- private-file metadata;
- generated SDK response;
- runtime message or receipt.

Decode once at entry. Keep the encoded and decoded forms explicit when they differ.
Do not maintain a second handwritten interface beside a schema-derived type.

Failures are typed and mapped once at the boundary. Do not parse error messages or
turn every failure into an untyped 500 response.

## Identity and authority

Authentication resolves a session to the canonical Person and Account. Profile,
organization appointment, volunteer affiliation, placement, and authority are
separate records.

Authorization is relationship-based and time-aware. The domain owns capability
requirements. The database adapter reads current facts. The HTTP middleware calls
the interpreter before the handler executes.

```text
session -> principal -> scoped facts -> capability interpreter -> allow or deny
```

Rules:

- Default deny.
- Query scope and command scope use the same authority source.
- Resource ownership and local or national scope remain explicit.
- Menu labels and dashboard roles are projections only.
- Every administrative override creates an audit event.
- Revocation applies on the next authorized interaction. Cached UI state does not
  preserve authority.

## Persistence and concurrency

PostgreSQL is the system of record for native business facts.

A state-changing operation runs inside one transaction and may include:

- current state;
- append-only history;
- command or idempotency receipt;
- audit event;
- outbox entry.

Use constraints for invariants that PostgreSQL can express. Use a transaction and
lock when an invariant spans rows or current state. Use a compare-and-set revision
when a caller edits an observed version. A rejected concurrent command must not
leave partial state.

Migration files are append-only after acceptance. A forward migration corrects an
accepted schema. Runtime code does not guess around missing columns.

## Delivery and providers

External work uses an outbox:

```text
business transaction
  -> commit business fact + immutable envelope
  -> worker claims envelope
  -> provider attempt
  -> acknowledgement or retry state
```

The first envelope is immutable. Retry is bounded. A restart may resume pending
work. Historical import must not send notifications. Provider-specific code belongs
in a Layer and may not define business state.

Private files require no-follow traversal, ownership checks, restricted permissions,
and explicit lifecycle handling. A path string is not authority.

## HTTP and generated client

`packages/http-api/src/api.ts` composes the public and internal native APIs. The
OpenAPI document, operation catalogue, generated SDK operations, and backend
metadata are generated from that contract.

A generated artifact must name its source and generator. Generation must be
repeatable. Do not hand-edit a generated client or maintain a separate route list in
documentation.

## Frontend state

The homepage and dashboard render server-owned facts. The dashboard uses Foldkit
Models for stateful journeys. One Model owns each workflow's loading, ready, stale,
offline, mutation, and error states.

Rules:

- Components render model state and send events.
- Loaders and actions call the SDK.
- Server authorization is never replaced by a client role check.
- A preview role override changes presentation only.
- Polling, cancellation, stale-response rejection, and cleanup belong to the Model
  that owns the workflow.
- Accessibility, mobile layout, keyboard use, and failure recovery are part of the
  journey contract.

## Runtime composition

`apps/backend/src/main.ts` is the Bun composition root. It provides concrete
configuration, PostgreSQL, identity, file storage, notification, and HTTP layers.
It then runs the server and worker programs.

`apps/backend/src/cloudflare-worker.ts` is the Cloudflare development composition
root. It uses the same domain and HTTP contracts. Its Layers provide Hyperdrive
PostgreSQL access, R2 private-file storage, provider email, identity, and Worker HTTP.
Concrete Cloudflare imports stay in the application and infrastructure packages.

The homepage and dashboard have separate Worker entry points. Pull-request previews
build the exact proposed revision without credentials. Trusted default-branch code
deploys those bundles, probes documents and assets, and deletes the previews when
the pull request closes.

Required configuration is explicit. A production composition must fail before
serving if a required provider, credential, schema, or storage dependency is
missing. Test and local layers must be named as such and must not silently stand in
for production.

Development deployment does not authorize production. Production still requires
separate provider configuration, data migration, writer transfer, and operator
approval.

## Change protocol

For one permanent journey change:

1. Write one active contract in `docs/specs/`.
2. Define the actor, authority, owned facts, transaction, effects, recovery, and
   observable outcome.
3. Change every required layer as one clean cutover.
4. Generate OpenAPI and SDK artifacts from the HTTP contract.
5. Exercise the real UI, HTTP, and PostgreSQL path.
6. Exercise denial and any relevant replay, retry, stale write, or rollback path.
7. Remove disposable runtime assets and the completed contract.
8. Update [system.md](system.md), [operational-responsibility-map.md](operational-responsibility-map.md),
   and [STATE.md](../STATE.md) only when their facts changed.

A route, table, generated method, unit test, or static report is not proof of a
complete journey.
