# Design spec 0045 — Effect Model and Service authority

## Metadata

| Field | Value |
|---|---|
| Goal | Make persisted data, domain authority, implementation requirements, and runtime ownership explicit and singular |
| Status | Frozen |
| Depends on | Database capability and process-level ManagedRuntime established by design specs 0039 and 0040 |
| First tracer | Receipt data through the Economy authority |
| Scope hold | Identity remains the final authority cutover; browser and production-faithful PostgreSQL evidence require explicit remote authorization |

## Problem

The native migration already exposes domain Services and a shared Database capability, but persisted records are still declared as independent `Schema.Struct` values plus handwritten SQL row interfaces. Database, domain, JSON, and SDK representations can therefore drift. Some Layers also close requirements inside method bodies, which hides the dependency graph that Effect can retain structurally.

## Goal

One maintainer can identify, from types alone:

1. the authoritative model for persisted data;
2. its select, insert, update, JSON-read, JSON-create, and JSON-update representations;
3. the Service that owns each business authority;
4. the requirements retained by each Service implementation Layer;
5. the single process composition root that closes those requirements.

## Values

1. One `Model.Class` field declaration is the source of truth for each persisted domain record.
2. Services own coherent business authority, not individual database tables.
3. Layers implement Services and retain infrastructure or authority requirements until the composition root.
4. User journeys are open Effect programs whose requirement type names every authority they use.
5. Pure validation, transitions, calculations, commands, failures, and effect requests remain schemas or total functions unless they own a real capability.
6. Specialized transactional SQL remains specialized when it carries locking, replay, audit, outbox, or concurrency invariants. `SqlModel.makeRepository` is for ordinary CRUD, not a reason to weaken those invariants.

## Structural contract

### Models

Persisted records use `Model.Class` from `effect/unstable/schema`.

- IDs use one branded schema owned by the domain that introduces the identity.
- Immutable fields are absent from `update` and `jsonUpdate` variants by construction.
- Database-generated fields are absent from caller-controlled create/update variants.
- Private fields are absent from JSON variants.
- Nullable and optional remain distinct.
- SQL selects alias columns or construct nested values so the selected row decodes directly through the authoritative Model; a duplicate handwritten row interface is prohibited.
- Boundary-specific transformations are derived from the Model or are explicitly named transformations with the Model as their source.

### Services

The initial authority graph is:

```text
Database
├─ Organization
├─ Admissions ── Organization
├─ Recruitment ── Admissions + Organization
├─ Economy ── Identity + PrivateFileStore + NotificationGateway
├─ Profile ── Organization
└─ Identity (cut over last)
```

A Service contract exposes domain operations and typed failures. It does not expose concrete PostgreSQL clients, framework requests, or vendor SDKs.

### Layers

- A domain implementation is named `<Authority>Live` or `<Authority>Test` according to its leaf implementation.
- PostgreSQL imports and SQL execution remain in persistence adapters or live Layers.
- Domain Layers retain `Database` and other capability requirements in their `Layer.Layer<Provided, Error, Required>` type.
- Domain methods do not repeatedly call `Effect.provideService` to hide a dependency that can remain in the method Effect requirement.
- Only the process composition root selects and provides all live Layers.
- The backend constructs one ManagedRuntime and disposes it once during process shutdown.

### Journeys

A named journey is an Effect program, not a Service merely because it is named. Its `R` type is the executable requirements inventory. Handlers decode boundary input, run the journey through the process runtime, and encode the returned observation.

## Rollout

1. Convert Receipt into the first authoritative Model while preserving its existing transaction, locking, command replay, audit, outbox ordering, and file invariants.
2. Gate the tracer before parallel work.
3. Migrate Admissions, Economy expansion, and Organization in isolated worktrees.
4. Integrate, validate, and review the committed authority wave.
5. Migrate Recruitment, Profile, and API/SDK projections.
6. Cut Identity and the final runtime graph over last.
7. Run production-faithful PostgreSQL and remote browser evidence before zero-gap retirement.

## Definition of done

1. The Receipt tracer has one `Model.Class` authority and no duplicate receipt-row interface.
2. Model tests prove derived variant keys and strict decode behavior.
3. The Receipt command transaction still proves accepted command, replay, stale revision, audit, and ordered outbox behavior.
4. Economy remains an Effect Service whose live implementation requires Database structurally.
5. Each migrated authority removes superseded persisted shape declarations and migrates every caller in its bounded context.
6. The integrated Layer graph is acyclic, constructs once, and disposes once.
7. Fast capability tests use PGlite with the canonical migrations; PostgreSQL-specific concurrency claims use real PostgreSQL evidence.
8. Every core user journey has a named Effect program and accepted remote evidence before retirement.
9. Root type, lint, build, test, migration replay, zero-gap parity, and named journey gates pass on the committed revision.

## Falsifiers

- A persisted record is independently declared as a database interface and a domain schema.
- A caller can supply a generated or immutable field through an update variant.
- A private persisted field appears in a JSON variant.
- A domain Layer silently constructs or provides its own live Database.
- A request handler constructs a Layer or ManagedRuntime.
- A pure rule becomes a Service without a dependency, authority, resource, failure, or lifecycle to expose.
- Generic CRUD replaces locking or atomic command/audit/outbox behavior.
- PGlite evidence is presented as PostgreSQL locking proof.
- A unit or source test is presented as successful browser journey evidence.
