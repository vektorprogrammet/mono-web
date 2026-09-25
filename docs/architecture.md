# Intended architecture

**Status:** Target architecture for the native replacement. Revised 2026-09-24.

See [system.md](system.md) for business meaning and [STATE.md](../STATE.md) for
current implementation status.

## Product shape

The target remains one modular backend, two browser applications, one PostgreSQL
database, and one generated client contract.

```text
apps/homepage ---+
                +--> packages/sdk --> packages/http-api
apps/dashboard -+                          |
                                           +--> portable domain contracts
apps/backend --> domain services ----------+
                    |
                    +--> PostgreSQL adapters --> packages/database --> PostgreSQL

Placements contracts and adapters share packages/placements, with separate exports.
Other business contracts remain in packages/domain.
```

`apps/server` retains Symfony modernization source, not an exact production
snapshot. Import commit `da8d3e8b` names the monolith modernization branch as its
source. [PR #1592](https://github.com/vektorprogrammet/vektorprogrammet/pull/1592)
describes that separate upgrade. Production contracts use the operator-designated
legacy `master` baseline and observed live workflows. The retained server
OpenAPI snapshot therefore does not define production operational parity.

The Symfony code is outside the target dependency graph. An authorized cutover
must transfer every required writer and reader before the legacy system retires.

## Ownership

| Path                  | Owns                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/domain`     | Business values, state transitions, failures, capability requirements, and service contracts                    |
| `packages/database`   | Shared PostgreSQL schema and runtime; persistence adapters for domains outside the Placements locality trial    |
| `packages/placements` | Portable Placements contracts and transitions; private PostgreSQL implementation behind a separate server entry |
| `packages/http-api`   | Public and internal HTTP groups, middleware declarations, schemas, and generated OpenAPI                        |
| `packages/sdk`        | Generated consumer operations and boundary decoding                                                             |
| `apps/backend`        | Native process composition, HTTP serving, delivery workers, and runtime configuration                           |
| `apps/homepage`       | Anonymous and public journeys                                                                                   |
| `apps/dashboard`      | Authenticated applicant, volunteer, coordinator, leader, and administrator journeys                             |
| `tools/verification`  | Cross-application PostgreSQL proofs, migration rehearsals, and their fixtures                                   |
| `tools/e2e`           | Disposable local migration and journey drivers                                                                  |
| `tools/parity`        | Temporary migration analysis and safe runtime helpers                                                           |

A business fact has one owner. Other modules use its public contract. They do not
write its tables or duplicate its rules.

## Dependency rules

This diagram defines architectural ownership, not the exact installed dependency inventory.
Package manifests define that inventory.

```text
frontends               -> packages/sdk, portable contracts
packages/http-api       -> packages/domain, packages/placements/contracts
apps/backend            -> service contracts and concrete runtime Layers
packages/placements     -> packages/domain; server implementation -> packages/database
packages/database       -> packages/domain
packages/sdk            -> generated HTTP contract
packages/domain         -> Effect and portable domain dependencies
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
  Placements is the bounded locality trial, not a repository-wide package rewrite.
  Its `contracts` export is portable. Its `server` export owns PostgreSQL composition.
  Sibling modules must not import its private source files.
  Oxlint rejects the selected browser-to-database, product-to-proof, and private-module imports, including relative paths.

Placements and Recruitment expose complete business commands through Effect services.
HTTP handlers resolve credentials, decode requests, enforce protocol preconditions, and store response receipts.
They call the service within the command transaction instead of sequencing locks and mutations.
Business facts, audit, history, outbox work, and response receipts commit together.

Cross-application proofs belong in `tools/verification`, not reusable libraries.
Package-local tests stay with their domain. Export maps expose supported entry points, not every internal helper.

## Interface contracts

The same business contract crosses several interfaces. A route, schema, or table
is not the business contract by itself. Each interface owns one kind of trust.

| Caller to receiver                | Required contract                                                                                                                                                                                                                                                     | Hidden implementation                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Human browser to native server    | The generated external HTTP contract defines requests, responses, errors, cache rules, revisions, and idempotency. Protected operations resolve the actor and current scope; public flows use explicit capabilities. Better Auth owns its separate credential routes. | Browser state, page structure, PHP routes, and database rows.   |
| Service to native server          | A machine operation needs an explicit service identity, capability, resource scope, and credential policy. Denial and revocation must hold without a browser session. Internal ingress and network rules add isolation but do not grant business authority.           | Provider tokens, transport plumbing, and the receiving handler. |
| Native server to domain service   | A command names the actor, intended transition, expected revision, and observable failure. Queries read owned facts under the same authority.                                                                                                                         | HTTP envelopes and persistence models.                          |
| Domain service to PostgreSQL      | The repository preserves constraints, isolation, compare-and-set revisions, immutable evidence, audit, and outbox work in one transaction. Rejected or competing commands leave no partial business state.                                                            | SQL layout, table names, and index choices.                     |
| Native server to provider         | An asynchronous outbox envelope identifies one committed effect. Delivery can retry without repeating the business decision. Private-file reads prove custody and scope.                                                                                              | Mail, storage, SMS, and deployment vendors.                     |
| Migration source to native target | A selected read-only source snapshot, explicit mappings, row dispositions, immutable provenance, replay rules, and a fenced final delta establish native facts. Import never fabricates human decisions or sends historical notifications.                            | Legacy schema and transformation machinery.                     |

The external HTTP root and generated SDK describe application operations, most
of them human-facing. A machine operation is not authorized by its location.
The internal HTTP root is separate from public OpenAPI. Its receipt-evidence route
currently accepts a scoped Person cookie; an internal path is not automatically
a service-principal API. OAuth introspection has its own isolated route. A
machine-facing operation must prove the service credential and grant through the
actual HTTP path, not only through a handler test.

## Domain services

The domain package defines facts, policies, and service contracts across these
capability groups:

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
The [Placements service](../packages/placements/src/service.ts) owns complete commands
and queries. Its server implementation holds the department lock across the
precondition, transition, audit, history, and outbox writes in the caller transaction.
The [Substitutes contract](../packages/domain/src/substitutes/service.ts) exposes complete pool queries and commands.
Its [database Layer](../packages/database/src/substitutes/service.ts) holds the application lock across the fresh read, transport precondition, domain decision, and writes.
The caller owns current authorization, the transaction, and response receipts.
The [Substitutes guide](../packages/domain/src/substitutes/README.md) records composition and failure guarantees. Placements retains the separate coverage lifecycle.

Economy uses its [service contract](../packages/domain/src/receipt/service.ts) for
receipt queries and settlement commands. The [owner query](../packages/database/src/receipt/projections.ts)
uses `SqlSchema.findAll` with field schemas from `Receipt`. SQL owns the projection,
filters, and ordering.

The [settlement command](../packages/database/src/receipt/settlement.ts) resolves
current authority and writes the business facts inside the caller transaction.
HTTP owns response receipts and revision preconditions. Its revision-only
preflight does not grant write authority. The complete command checks authority again.

`SqlSchema` checks runtime inputs and results. It does not statically prove SQL or generate database constraints.
Model variants describe representations, not authority, lifecycle transitions, or automatically partial update commands.
Public responses require explicit public-schema encoding. Raw model serialization does not enforce private-field omission.

These boundaries do not require a new queue, event log, state runtime, or generic repository.
Adoption criteria and verification practices live in [AGENTS.md](../AGENTS.md#boundary-practices).

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

The first envelope is immutable. Provider deadlines bound individual requests.
Domain-specific recovery rules define retries and quarantine. A deadline does not imply a finite lifetime retry count.
A restart may resume pending work. Historical import must not send notifications.
Provider-specific code belongs in a Layer and may not define business state.

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
The recruitment notification worker starts only when its HTTP delivery Layer is configured.
The external ingress also owns explicitly enabled password-reset and receipt workers. Internal ingress does not start these workers.
The root supervises failure and interruption; a failed worker stops the process. Shutdown joins workers before disposing of their database runtime.
Claims retain domain-specific recovery rules. Ambiguous or stale reset attempts quarantine; receipt attempts retain immutable envelopes and fenced recovery.
The [delivery guide](delivery-recovery.md) defines configuration, retry limits, and operator recovery.

`bun dev` selects the local Bun backend and both frontend development servers.
The existing Turbo tasks own these processes; PostgreSQL remains a separately managed prerequisite.
The launcher requires a dedicated loopback database and disables external delivery.
See [local development](../README.md#local-native-development) for the executable configuration interface.

`apps/backend/src/cloudflare-worker.ts` retains the superseded Cloudflare backend composition.
Its Hyperdrive, R2, and email integration is not the selected backend target.
The target is a portable Bun backend with PostgreSQL. Provider selection and provisioning remain deferred until cutover preparation.
[STATE.md](../STATE.md#current) records the current authority and acceptance limits.
A resource declaration or cron configuration does not prove a working delivery drain.

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
