# Design spec 0040 — Logical capability topology

> **Summary:** A maintainer can compose Vektorprogrammet from logical capabilities. Each capability declares its laws and direct requirements. Effect Services expose capabilities. Layers provide law-preserving interpretations. One ManagedRuntime builds the selected graph once. Physical placement does not define the logical topology.

## Metadata

| Field | Value |
|---|---|
| Goal | Establish the capability and runtime contract for all remaining migration work |
| Status | Frozen and accepted for local implementation. Remote PostgreSQL proof requires remote CI. |
| Depends on | Design spec 0039 at `2be4112`, ADR 0004, and ADR 0005 |
| Actor | Maintainer and capability author |
| Environment | Local PGlite contracts and remote PostgreSQL integration. Local browser execution is prohibited. |

## User journey

1. A maintainer opens one backend composition root.
2. The maintainer can see each logical capability and each direct requirement.
3. The composition root selects one Layer for each required capability.
4. One ManagedRuntime builds the complete Layer graph at process startup.
5. Many requests use the same built Context and database pool.
6. Process shutdown disposes the runtime and all scoped resources.
7. A test selects PGlite without changes to the business program.
8. Remote CI selects PostgreSQL and proves the PostgreSQL-specific laws.

## Canonical terms

| Term | Meaning |
|---|---|
| Theory | The vocabulary, state, messages, laws, observations, failures, and effects for one capability |
| Capability | Logical authority that a program can require |
| Service | An Effect key and typed interface that exposes one capability |
| Program | An open Effect computation whose requirements name its capabilities |
| Layer | A constructor or interpreter that supplies capabilities from other capabilities |
| Context | Evidence that the required capabilities have implementations |
| ManagedRuntime | The scoped and memoized realization of the selected Layer graph |
| Process | An optional physical placement for one or more capabilities |
| Protocol | An optional projection across a physical boundary |

A Service is not a microservice. A process boundary does not create a capability boundary.

A remote Layer is valid only when it preserves the capability laws. A matching TypeScript interface is not sufficient.

## Logical capabilities

| Capability | Owns | Direct requirements |
|---|---|---|
| `Database` | connection scope, transactions, migration readiness, schema revision, shutdown | Effect configuration and SQL adapter Layers |
| `Identity` | credential authentication, actor identity, account state | `Database` |
| `Organization` | departments, semesters, fields of study, teams, membership, positions | `Database` |
| `Admissions` | admission windows, eligible catalog, applicant submission, application review | `Database`, `Organization` |
| `Recruitment` | invitations, interviews, responses, offers, placements | `Database`, `Admissions`, `Organization` |
| `Economy` | Receipt submission, revision, withdrawal, approval, refund, rejection, projections | `Database`, `Identity`, `PrivateFileStore`, `NotificationGateway` |
| `Content` | public pages, sponsors, contact content, newsletters | `Database` |
| `PrivateFileStore` | private object promotion, read, replacement, and deletion | provider configuration |
| `NotificationGateway` | delivery of approved notification requests | provider configuration |

These rows define logical authority. They do not require separate packages, processes, databases, or deployments.

## Capability theory contract

Each authority capability must define these parts:

1. Vocabulary and schemas.
2. Commands and queries.
3. Warranted state.
4. Pure transition laws.
5. Returned observations.
6. Typed failures.
7. Requested external effects.
8. Direct requirements.
9. Durable ownership.
10. Consistency and liveness guarantees.

A pure transition receives explicit actor facts and one observed instant. It does not read ambient configuration, time, or identity.

An authority Service decodes input, opens one transaction, loads warranted state, runs the transition, and persists the result. The same transaction persists command receipts, audit rows, and outbox requests.

A protocol adapter decodes transport data and authenticates the caller. It invokes a capability Service and maps typed results to protocol responses. It does not import SQL clients or implement domain transitions.

An SDK owns protocol names, strict response decoding, typed transport failures, and reusable client methods. It does not own authorization or business laws.

## Database laws

`Database` supplies these guarantees:

| Law | Required behavior |
|---|---|
| Atomic transaction | A successful transaction commits every write. A failed transaction exposes no partial write. |
| Command serialization | Commands with the same identity serialize under concurrent use. |
| Constraint authority | Database constraints preserve cross-row invariants under concurrency. |
| Migration identity | The runtime reaches one exact ordered schema revision before it becomes ready. |
| Shared lifetime | One runtime shares one pool and one migration result across all request programs. |
| Scope | Runtime disposal releases all connections and scoped resources. |
| Dialect honesty | PGlite proves portable service laws. PostgreSQL proves locks, isolation, pool behavior, and claim recovery. |

`Database` does not own Receipt transitions, applicant eligibility, actor scope, HTTP status mapping, or frontend projections.

## Required Database interpretations

### `DatabaseLive`

`DatabaseLive` uses the Effect PostgreSQL adapter. It reads redacted configuration, creates a bounded pool, runs the ordered migration manifest, and reports readiness.

Preview and production use `DatabaseLive`. Database identity and configuration differ between these environments. The implementation does not differ.

### `DatabaseTest`

`DatabaseTest` uses the Effect PGlite adapter. It uses the same migration manifest and an isolated scoped database.

PGlite does not prove PostgreSQL concurrency behavior. Tests for advisory locks, pool behavior, transaction isolation, and stale claims run against PostgreSQL.

### `DatabaseIntegration`

`DatabaseIntegration` uses disposable PostgreSQL in isolated remote CI. It proves migrations, locks, races, command replay, and outbox claims.

## Migration authority

Each capability owns its migration source files. One application manifest imports these migrations and defines their total order.

```text
application migration manifest
├── Economy migrations
├── Admissions migrations
├── Recruitment migrations
├── Organization migrations
└── Identity migrations
```

The manifest is the single source for live, preview, integration, and PGlite schema construction. Tests must not copy SQL into a second manifest.

## Runtime topology

```text
process startup
→ ManagedRuntime.make(ApplicationLive)
  → build Database once
  → build authority Services once
  → build provider Services once
many requests
→ managedRuntime.runPromise(requestProgram)
process shutdown
→ managedRuntime.dispose()
```

Layer identity is stable. The composition root defines each root Layer once and reuses that value.

Request handlers do not receive `postgresLayer`, `PgClient`, connection strings, or migration SQL through option objects.

## Initial physical topology

The native backend starts as one process:

```text
one native backend process
├── one ManagedRuntime
├── one HTTP router
├── one Database capability
├── authority Services
└── supervised outbox programs
```

A physical split requires an operational reason. Valid reasons include independent scaling, trust, availability, or deployment ownership.

If a capability moves to another process, its remote Layer must preserve command identity, authorization, atomicity, ordering, failures, and liveness.

## Clean cutover

The migration removes competing authorities:

- `AdmissionPeriodAuthority` and `PublicApplicationAuthority` become one `Admissions` capability.
- Receipt theory becomes the authority behind `Economy`.
- Protocol adapters stop calling PostgreSQL functions directly.
- Request-local PostgreSQL Layer provision ends.
- `apps/admission-api` and `apps/receipt-api` move to one native backend process.
- Old application packages are removed after every caller moves.
- No compatibility alias or forwarding shim remains.

Legacy Symfony remains the authority only for routes that have no native cutover. Each route has exactly one writer.

## Definition of done

The implementation supplies this evidence:

1. The compiler shows direct capability requirements on open programs.
2. `DatabaseTest` and `DatabaseLive` run the same ordered migration manifest.
3. The same authority contract runs against PGlite and PostgreSQL.
4. An instrumented Layer observes one database acquisition and one migration for many requests.
5. Runtime disposal observes one resource release.
6. HTTP adapters contain no SQL imports and no business transition logic.
7. The backend starts only after migration readiness succeeds.
8. Remote PostgreSQL tests prove concurrency and outbox claim behavior.
9. Existing Receipt and public-applicant journeys keep their observations and failure taxonomy.
10. The removed API applications have no references, routes, scripts, or deployment resources.

## Falsifiers

The topology is invalid if one of these conditions is true:

- A protocol adapter imports a concrete SQL client.
- A business Service method exposes driver requirements.
- One request constructs a database Layer.
- Two capabilities can write the same authoritative row.
- Live and test databases use different migration sources.
- PGlite results claim PostgreSQL concurrency proof.
- Two Services own applicant submission.
- A remote Layer weakens a logical law.
- A legacy and native route both accept the same write.
- Runtime shutdown leaves a pool, worker, or claim owner active.

## Non-goals

This contract does not authorize production deployment, production data import, provider delivery, or identity cutover. It does not require one package or process per capability.
