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

Packages are layer-first. Each context has a folder in packages/domain for its
business contracts and in packages/database for its PostgreSQL adapters.
```

### Legacy source

The legacy Symfony source is not in this repository. Production runs the default
branch of [vektorprogrammet](https://github.com/vektorprogrammet/vektorprogrammet).
The Symfony modernization attempt that this repository kept as `apps/server` continues
there as branch `modernize/mono-web-server` (`908368a8`), with its full history.
In mono-web, `ea124143` removed it; its parent `1277be8b` still contains `apps/server`, without
`tools/security-h3`, which the preceding parity retirement deleted. The complete tree `023b85bd`
is at `b6438cb2`, the base of that change, and is identical to that branch.

That modernization source is not an exact production snapshot. Production contracts
use the operator-designated legacy `master` baseline and observed live workflows.
An authorized cutover must transfer every required writer and reader before the legacy
system retires.

## Ownership

| Path                  | Owns                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/domain`     | Business values, state transitions, failures, capability requirements, and service contracts              |
| `packages/database`   | Shared PostgreSQL schema and runtime; persistence adapters and service Layers for each context            |
| `packages/http-api`   | Public and internal HTTP groups, middleware declarations, schemas, and generated OpenAPI                  |
| `packages/sdk`        | Generated consumer operations and boundary decoding                                                       |
| `apps/backend`        | Native process composition, HTTP serving, delivery workers, and runtime configuration                     |
| `apps/homepage`       | Anonymous and public journeys                                                                             |
| `apps/dashboard`      | Authenticated applicant, volunteer, coordinator, leader, and administrator journeys                       |
| `tools/verification`  | Cross-application PostgreSQL proofs, migration rehearsals, and their fixtures                             |
| `tools/e2e`           | Disposable local migration and journey drivers                                                            |
| `tools/source-safety` | Source-safety rules and the staged-tree scan that blocks credentials, personal data, and literal SQL data |

A business fact has one owner. Other modules use its public contract. They do not
write its tables or duplicate its rules.

## Dependency rules

This diagram defines architectural ownership, not the exact installed dependency inventory.
Package manifests define that inventory.

```text
frontends               -> packages/sdk, portable contracts
packages/http-api       -> packages/domain
apps/backend            -> service contracts and concrete runtime Layers
packages/database       -> packages/domain
packages/sdk            -> generated HTTP contract
packages/domain         -> Effect and portable domain dependencies
```

Required rules:

- The root catalog and Bun lock own application versions. `just layout` decodes the
  resolved lock graph and rejects prerelease Effect packages, including peer-only
  and nested entries. Separately owned stable infrastructure releases remain valid.
- `packages/domain` must not import database, HTTP, application, browser, provider,
  or migration-tool code.
- Product packages must not import from `tools`.
- Frontends communicate through the generated SDK. They do not import backend or
  database implementation.
- A service exists for a dependency, authority, replaceable policy, or owned
  lifecycle. A total local calculation stays a direct function.
- Concrete runtimes and vendors belong in Layer implementations and composition
  roots.
- The production database entry provides PostgreSQL only; PGlite and its extensions enter through `packages/database/src/test-support/platform.ts`, not through the backend or database barrel.
- Core Effect code, in `packages/domain`, `packages/database`, `packages/http-api`, and `apps/backend`,
  reaches the clock, randomness, timers, the network, the environment, Node built-ins, and the console through Effect services,
  and uses Effect programs, tagged errors, and Schema instead of Promises, native errors, and `JSON`.
  Oxlint rejects the platform forms there (the `effectNative` rules of the Effect language service); the other apps, packages, and tools are not Effect programs.
- Do not add a microservice until an observed operational need requires an
  independent deployment boundary.
- Oxlint rejects the selected browser-to-database, product-to-proof, and cross-package source imports, including relative paths.

A context's service owns complete commands, locks included.
Its database Layer takes the context lock and holds it across the fresh read, transport precondition, domain decision, and writes in the caller transaction.
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
- Economy
- Content
- Content management
- Social events
- Private file storage
- Notification delivery

ContentManagement allocates an immutable slug at draft creation in its PostgreSQL
transaction. The title transliterates to lowercase ASCII; a long slug is cut
to 255 characters and a numeric collision suffix replaces its tail. Allocation
checks both drafts and published versions; the article, receipt, and audit
commit together, or none do.

A service contract uses domain commands, facts, failures, and observations. It does
not expose database rows or transport objects.
The [Placements service](../packages/domain/src/placements/service.ts) owns complete commands
and queries. Its [database Layer](../packages/database/src/placements/service.ts) holds the department lock across the
precondition, transition, audit, history, and outbox writes in the caller transaction.
The [admission outcome contract](../packages/domain/src/admissions/outcome.ts) records an
explicit decision for a Kanskje or returning application and announces one terminal outcome,
Admitted or Rejected, independent of placement. Its
[database Layer](../packages/database/src/admissions/outcome.ts) locks the application across the fresh read,
transport precondition, and append-only revision write. Announcing Rejected takes the placement scope lock,
so it and a placement creation for that department and semester exclude each other. The announcement stores one
immutable outcome and one immutable rendered message envelope.
The caller owns current authorization, the transaction, and response receipts.
Placements records absences and which assistant covered each lesson date, with no coverer kind. It derives actual
attendance from the confirmed roster, the absences, and the current coverage records.

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

## Database and authentication lifetimes

The backend owns two separate scoped pools. Native Effect SQL provides `Database`;
Better Auth uses its supported pg/Kysely adapter on `AuthPoolLive`. Neither pool
borrows the other pool's connection or transaction. The Bun host supplies caps of
eight native connections and four authentication connections.

`nativePgLayer` keeps every checkout exclusive and disables multiplexing. Prepared
statements are disabled unless the host explicitly selects a compatible pooler.
The native driver owns reservation, transaction nesting, rollback, and release.
Migration files pass through `executePostgresMigration`, which parses their original
statement boundaries and runs them sequentially inside the caller's transaction.

The dependency patches in the root manifest preserve the HTTP request union and
queue verification and acknowledgement contracts. The native SQL lifetime repair
adds explicit top-level admission interruptibility and opted physical shutdown
observation; it does not infer a transaction outcome from cancellation or disposal.
The [exception registry](effect-exceptions.json) records their scope, upstream
capability gaps, verification requirements, and retirement triggers. Runtime
acceptance and provider capacity remain separate gates in [STATE.md](../STATE.md).

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
Canonical JSON for digests and stored evidence accepts only plain encoded data; encode a
value through its schema before hashing it.

The local D1 proof reads installed package versions and hashes the resolved runtime
module bytes before its journeys run. Historical integration references stay
explicitly historical; fixed RC versions or source hashes do not describe a
stable runtime observation. Local Miniflare evidence does not prove a remote D1
binding or provider behavior.

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

Organizational reach resolves in one place. `packages/domain/src/authz/reach.ts` holds the
capability registry and interprets the facts that
`packages/database/src/organization/authority-postgres.ts` reads: memberships with the team's
kind and scope, national-board seats, the department's independence, and current delegations.
An ordinary team leader acts only in its own team; a board leader reaches where the board sits;
a delegation reaches only its team's members, its area, and its interval. The lint rule
`anti-slop/no-leadership-reach` keeps leadership facts out of every other module.

[`docs/model/authority.als`](model/authority.als) verifies the rules (`just model check`).
Each code rule follows these predicates:

| Code rule                                                            | Predicates                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| role type from unit kind and leadership; the capability registry     | `capabilityTable`, `typeFollowsPosition`                                                        |
| seat per unit; Styret only while independent; Hovedstyret everywhere | `boardsSitWhereTheyServe`, K1, K2, X1, X2                                                       |
| a team leader reaches only its team                                  | `teamRolesStayInTheirTeam` (L), mutant `leadersAdministerTheirDepartment`                       |
| a board member or derived seat has no administration                 | `derivedSeatConfersNoAdministration` (Q2), mutant `styretMembersAdministerTheDepartment`        |
| a delegation carries only delegable capabilities                     | `delegationsCarryDelegableActions`, K3 mutant `delegationsMayCarrySystemAdministration`         |
| the delegation area lies inside the team's area; national by scope   | `delegationsStayInTheirTeamArea`, `teamAreaIsItsScope` (mutant `nationalByHome`)                |
| the manager needs `delegations.manage` over the team's area          | `delegationsIssuedOverTheTeamArea` (mutant `delegationsIssuedAtTheHome`)                        |
| a delegation reaches only its team, its area, and its interval       | `delegatedReach`, `delegationActive`, M1, M2, M3                                                |
| leaders-only delegations; settlement only to leaders                 | `LeaderDelegation`, `settlementReachesLeaders`, `scenarioEconomyMemberApprovesButDoesNotSettle` |
| authority is resolved per request, never cached                      | `effectiveByOwnState`                                                                           |
| the global-administrator grant is an explicit list, apart from roles | `grantCapabilitiesExplicit`, K3                                                                 |

The code is stricter than the model in two places: receipt delegations act only in the whole
organization, and only an ordinary team holds a delegation.

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

Take a PostgreSQL advisory lock with `lockAdvisory` from
[advisory-lock.ts](../packages/database/src/advisory-lock.ts). Its `AdvisoryLockKey`
constructors own every key text, including the text that migration triggers hash.
`anti-slop/no-raw-advisory-lock-sql` rejects hand-written advisory-lock SQL.

Instants are `timestamptz` values at millisecond precision, the precision of the domain's
`DateTime.Utc`. A CHECK on every instant column rejects a sub-millisecond value, and clock
defaults and clock writes use `date_trunc('milliseconds', ..., 'UTC')`. Bind an instant as its
encoded RFC 3339 text; the `Database` template rejects a `DateTime` argument at compile time.

Bind a JSON parameter as its value, `sql.json(canonicalJsonValue(value))`: the `Database` service
encodes the argument, so JSON text such as `canonicalJson(value)` would be stored as a JSON
string. `anti-slop/no-json-text-parameter` rejects JSON text there.

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

Team application notifications run on Effect's `PersistedQueue` SQL store as a pilot
([infrastructure ports](specs/infrastructure-ports.md#team-application-delivery-pilot-operator-decision-2026-09-26)).
The submit transaction writes the outbox row with its envelope and a queue item that names only the effect.
The queue owns the lease, the attempt count, and the retry backoff. The outbox row owns the envelope, the policy, and the outcome,
and an attempt writes its outcome only while it holds the lease. Migration 0078 owns the store schema, and
`team_application_delivery_state` reads both rows. The other outboxes keep their claim columns.

Private files require no-follow traversal, ownership checks, restricted permissions,
and explicit lifecycle handling. A path string is not authority.

## HTTP and generated client

`packages/http-api/src/api.ts` composes the public and internal native APIs. The
OpenAPI document and the SDK operation index are generated from that
contract by the package `generate` tasks, which Turbo runs before type checks and builds.

A generated artifact must name its source and generator. Generation must be
repeatable. Git ignores generated artifacts; regenerate them instead of committing them.
Do not hand-edit a generated client or maintain a separate route list in documentation.

Recruitment's canonical declarations live in [recruitment.effx.ts](../packages/http-api/src/recruitment.effx.ts).
[onboarding.effx.ts](../packages/http-api/src/onboarding.effx.ts) declares the two Recruitment-owned onboarding operations.
These eighteen operations join the prior 56 operations in one 74-operation project IR across eleven generated groups.
The complete external native contract retains 111 operations, including operations outside these generated groups.
The contract and backend generation configurations consume the same declarations. Contracts generate before raw handlers.
AOT access declarations describe policy. Request-local typed guards call the existing authorization interpreter at the original snapshot or transaction decision point.
Generated contracts and raw bindings do not acquire business authority or replace domain-specific locks.

Onboarding uses one native group under the external root, not a second generated root.
Its generated factory registers `readBoard` and `command`, then requires typed completion of the handwritten Identity `claim` handler.
A missing claim prevents construction of the group layer.
Identity retains credential selection, account provisioning, capability consumption, and claim transaction ownership.
After Identity migrates claim, the complete generated group replaces this completion seam.

Fresh transaction authorization precedes HTTP receipt lookup. Exact replay returns the stored response capsule before mutation-only preconditions.
New commands retain domain locks and atomic mutation, audit, outbox, and receipt writes.
Frozen decision citations, final announcements, immutable message envelopes, and exact receipt bytes remain application-owned.
The generated SDK consumes the canonical contract. It does not change those persistence semantics.

Local journey fixtures must construct every dependency of their declared participants before the journey uses them.
The Returning fixture owns its synthetic primary interviewer's contact projection before its primary appointment.
Identity provisioning alone does not create that contact projection.
Fixture completeness is test construction, not business authority. Production reads still refuse a missing required contact.

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

Recruitment and invitation-response bridges forward the executing Effect’s AbortSignal into
fetch. Their RequestInit requires a non-null signal, with compile-only positive and negative
controls. Response-body consumption shares the same cancellation lifetime. Foldkit Command
fibers retain their embedded runtime as the lifetime owner. EmbedHandle disposal interrupts
the owned browser requests. Abort does not prove rollback of a server command that already
committed.

The four Recruitment programs keep handwritten Foldkit Command bodies: assignment, scheduling/conduct, invitation response, and maintenance.
They call the generated SDK directly or through the existing browser bridges. Generated Commands are not part of this cutover.

The native correction-window Dialog owns background isolation, focus containment, dismissal, and ordinary opener restoration.
Eligible Reopen and Close openers remain enabled while the dialog is open. Server `canReopen`, `canClose`, and mutation locks control eligibility.
The update function refuses reentrant opens and pending dismissal. An open dialog grants no server authority.

Successful Close changes the next valid action. The workflow does not preserve a physical Close node and relabel it as Reopen.
The [maintenance Model](../apps/dashboard/app/foldkit/recruitment-maintenance/model.ts) owns the close ticket and the pending next-action focus identity.
The [maintenance update](../apps/dashboard/app/foldkit/recruitment-maintenance/update.ts) correlates the successful mutation and staffing refresh with that identity.
It requires Ready staffing, Closed correction state, and server-owned `canReopen`; it does not infer eligibility from roles, time, or local dialog state.
Native Dialog close completion releases the ticket before the workflow dispatches focus on the current Reopen control. Ordinary Cancel/Escape/Tilbake retain native opener restoration.

The [maintenance Commands](../apps/dashboard/app/foldkit/recruitment-maintenance/command.ts) own focus as a lazy, interruptible one-shot Command through native `Dom.focus`.
The view and focus Command share the pure [Reopen target](../apps/dashboard/app/foldkit/recruitment-maintenance/correction-window.ts) for its id and eligible selector.
This target describes a control identity, not correction-window authority.
The runtime owns its fiber. Runtime disposal interrupts pending work; selection, release, and replacement invalidate the workflow's focus intent.
The [staffing route](../apps/dashboard/app/routes/dashboard.intervjubemanning._index.tsx) binds the custom element to the actual location identity.
Navigation to a replacement location tears down that element and its runtime, including while the destination loader is pending.
Unrelated fetchers and background revalidation do not end that lifetime.
Failures and cancellations clear pending focus intent. Results carry their workflow identity, and update rejects an identity that no longer matches.
A Command key is an address, not a lock. Same-key dispatch alone cancels nothing, and one batch supplies no execution order.
Replacement open/focus waits for the old native Close completion and any pending focus-cancellation completion. An unordered batch cannot supply that barrier.
Cancellation clears focus intent immediately. A late close completion for an old dialog generation cannot change a replacement dialog or arm focus.
No focus runner, timer, retry, weakened assertion, browser-node reuse, or framework change supplies this policy. The server remains the correction-window authority.

## Runtime composition

`apps/backend/src/main.ts` is the Bun composition root. It provides concrete
configuration, PostgreSQL, identity, file storage, notification, and HTTP layers.
It then runs the server and worker programs.
The recruitment notification worker starts only when its HTTP delivery Layer is configured.
The external ingress also owns explicitly enabled password-reset and receipt workers. Internal ingress does not start these workers.
The root supervises failure and interruption; a failed worker stops the process. Shutdown joins workers before disposing of their database runtime.
Claims retain domain-specific recovery rules. Ambiguous or stale reset attempts quarantine; receipt attempts retain immutable envelopes and fenced recovery.
The [delivery guide](delivery-recovery.md) defines configuration, retry limits, and operator recovery.

`just dev` selects the local Bun backend and both frontend development servers.
The existing Turbo tasks own these processes; PostgreSQL remains a separately managed prerequisite.
The launcher requires a dedicated loopback database and disables external delivery.
See [local development](../README.md#local-native-development) for the executable configuration interface.

The target is a portable Bun backend with PostgreSQL. There is no Cloudflare Worker backend composition.
The [R2 receipt-file adapter](../apps/backend/src/receipt/r2.ts) and [Cloudflare mail adapter](../apps/backend/src/mail/cloudflare.ts) are unselected provider adapters.
Provider selection and provisioning remain deferred until cutover preparation.
[STATE.md](../STATE.md#current) records the current authority and acceptance limits.

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
