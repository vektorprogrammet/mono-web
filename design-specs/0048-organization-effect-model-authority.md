# Design spec 0048 — Organization Effect Model authority

## Metadata

| Field | Value |
|---|---|
| Status | Frozen revision 0048.1 |
| Base | `086e9a5c519999e7cd0b7f7af8e5c01a06456f56` (`086e9a5`) |
| Authority | Organization: Department, Team, and Membership persistence and membership policy |
| Depends on | Frozen architecture 0045.1; Database capability from 0039/0040 |
| One journey | Import legacy organization relations, quarantine ambiguous rows, read a team and its retained memberships, revise one membership through its temporal/suspension transition, and read the revision back |
| Operator boundary | No production, provider, credential, remote database, or deployment effect |

## Purpose and source contracts

This slice retires the independent organization persistence shape for the bounded Organization
authority without changing the existing HTTP/SDK route contracts. It is grounded in:

- the legacy `Department`, `Team`, `TeamMembership`, `Position`, and `Semester` contracts;
- the PII-minimized relation schemas in `packages/domain/src/schema.ts`;
- law `S-DEP-2-TEAM` in `packages/domain/src/laws.ts`;
- the legacy unique-key observation: `(user_id, team_id, start_semester_id, position_id)` is the
  intended membership identity, six same-user/team/semester collisions differ by valid position,
  and seven true duplicate groups remain blocked from a database unique constraint;
- the legacy `team` foreign key's `ON DELETE SET NULL` behavior and `deletedTeamName` historical
  fallback; and
- the 0045 Model → Service → Layer structural contract.

The existing public representations remain projections owned by later API/SDK work. This slice
owns the canonical persisted organization records and the import policy that decides which legacy
rows can become canonical records.

## Semantic boundary and one journey

The journey accepts an explicit, PII-minimized legacy relation snapshot. A snapshot contains
Department rows, Team rows, and TeamMembership rows. A legacy row is an observation, not a trusted
assertion. The importer decodes the closed legacy shapes, maps integer source identities into
non-empty branded text identities, and emits either a canonical record or a quarantine record with
an explicit reason.

The retained journey is:

1. decode one department and one team;
2. import a membership whose team resolves, whose temporal interval is ordered, and whose
   `(person, team, interval-start, position)` identity is unique;
3. quarantine a duplicate membership instead of overwriting the accepted row;
4. quarantine a nullable-team row when it has no non-empty historical team name, while retaining a
   nullable-team row with a historical name as an explicit historical record;
5. read the team and its memberships through `Organization`; and
6. issue the named `reviseMembership` transition with an expected revision, changing interval or
   suspension independently, then read the incremented revision.

The journey is open until a composition root supplies `Database`. It does not construct a runtime,
provide a Layer, or infer a person-to-department edge.

## Canonical models

`packages/domain/src/organization/schema.ts` is the sole authority for persisted Department, Team,
and Membership field declarations. Each record is an Effect v4 `Model.Class`. No independent SQL
row interface, DTO, or second persisted schema is permitted.

All identity fields are non-empty branded strings owned by this bounded context:
`DepartmentId`, `TeamId`, `MembershipId`, `PersonId`, `PositionId`, and `SemesterId` (the latter
only at the legacy import boundary). SQL stores canonical identities as `text`. Integer source IDs
are never transported through a floating-point representation.

### Department

- `departmentId` (immutable identity);
- `name`, `shortName`, `email`, `address`, `city`, `latitude`, `longitude`, `slackChannel`, and
  `logoPath` (nullable only where the legacy column is nullable); 
- `active`; and
- `revision`.

### Team

- `teamId` (immutable identity);
- `departmentId` (immutable owning department);
- `name`, `email`, `description`, `shortDescription`, `acceptApplication`, `deadline`, and `active`;
- `revision`.

`Team.departmentId` is required in canonical state. An unresolved/null local department is an
import quarantine outcome, not a synthetic global team.

### Membership

- `membershipId`, `personId`, and `teamId` (identity/relationship fields; `teamId` is explicitly
  nullable for historical rows);
- `deletedTeamName` (nullable historical team identity; required and non-empty when `teamId` is
  null, and absent when a live `teamId` is present);
- `startAt` (RFC3339 instant) and nullable `endAt` (RFC3339 instant), with `endAt > startAt` when
  present;
- nullable `positionId` and `isTeamLeader`;
- `isSuspended`, an independent boolean dimension that never changes the stored interval;
- `revision`.

A membership is active at an instant only when the instant is inside `[startAt, endAt)` (or after
`startAt` when `endAt` is null) **and** `isSuspended` is false. This derived predicate is pure and
is not persisted as a second source of truth. The importer records legacy semester IDs in its
source metadata and requires the caller to provide their resolved RFC3339 interval; it never
silently invents semester dates.

### Derived variants

The Model declarations derive strict `select`, `insert`, `update`, `json`, `jsonCreate`, and
`jsonUpdate` schemas. `select` contains all persisted fields. `insert` omits database-generated
revision values where applicable. `update` and `jsonUpdate` omit every immutable identity and
relationship field. `json` omits private persistence-only fields (`deletedTeamName` and any
source/import metadata). Nullable values remain nullable; they are never made optional to hide
legacy absence. Unknown fields are rejected at every boundary with `onExcessProperty: "error"`.

## Transition and policy authority

`transitions.ts` owns pure membership policy. It exposes named operations, not generic CRUD:

- `membershipIsActiveAt(membership, at)` evaluates interval and suspension independently;
- `reviseMembership(current, command)` requires `expectedRevision`, rejects stale revisions and
  invalid intervals, preserves identity, and increments `revision`; and
- `suspendMembership` / `reinstateMembership` are named wrappers over the same revision rule.

A revision may change only `endAt`, `positionId`, `isTeamLeader`, or `isSuspended`. It cannot change
`membershipId`, `personId`, `teamId`, `deletedTeamName`, or `startAt`. A nullable-team historical
record can be revised only in its temporal/suspension dimensions; it cannot be reattached by a
membership revision.

Typed failures identify not-found, stale-revision, invalid-interval, immutable-field, and
persistence/decode cases. The service does not expose SQL clients or framework requests.

## Organization Service and PostgreSQL Layer

`Organization` is one `Context.Service` owning coherent organization authority:

- reads for one department, one team, one membership, and bounded collections;
- `reviseMembership`, `suspendMembership`, and `reinstateMembership` as permitted membership
  revisions; and
- the explicit import/quarantine operation used by the migration boundary.

The public Service methods retain only domain requirements. `OrganizationLive` is a PostgreSQL
Layer whose effect requires `Database` structurally. It captures that Database once and provides it
to private persistence programs; it never creates a request-local runtime or a hidden Database.
PostgreSQL imports and SQL execution remain in `postgres.ts` and the live Layer.

Persistence reads select SQL aliases that decode directly with the authoritative Model `select`
schema. No handwritten row interface duplicates Model fields. Membership revision SQL uses a
transaction, `FOR UPDATE`, expected-revision matching, and a single named update; zero rows map to
not-found/stale-revision evidence rather than an unconditional overwrite. The adapter returns the
canonical model after the update.

## Ordered idempotent migrations and import policy

The database migration runner receives one deterministic migration key after the existing revision
7 migration:

- `8_organization-authority` → `organization/migrations/0001-organization-authority.sql`.

The SQL is idempotent (`CREATE TABLE IF NOT EXISTS`, guarded indexes/constraints, and repeat-safe
quarantine/ledger structures). It creates, in dependency order:

1. `organization_departments`;
2. `organization_teams` referencing departments;
3. `organization_memberships` referencing teams with `ON DELETE SET NULL`, a nullable `team_id`,
   interval checks, suspension, revision, and no uniqueness assumption over dirty legacy data;
4. `organization_membership_quarantine` for duplicate, unresolved, invalid-interval, and
   missing-historical-name rows; and
5. `organization_import_ledger` keyed by source repository/revision/snapshot/source primary key
   and transformation revision, recording Accepted or Quarantined plus reason JSON.

Canonical membership uniqueness is enforced only on the normalized semantic identity after import:
`(person_id, team_id, start_at, position_id)` for non-null team rows. Duplicate legacy groups are
never selected by arbitrary row order and never overwritten. A null-team row with a non-empty
`deletedTeamName` is preserved as a historical canonical membership; a null-team row without that
name is quarantined. A duplicate or unresolved row is retained in quarantine and in the ledger,
not dropped. Replaying the same source snapshot is idempotent by the ledger key.

## Focused contract tests (written, not run in this slice)

- `model.test.ts`: branded identity decoding; exact derived variant keys; immutable/generated and
  private field exclusion; strict excess-property rejection; nullable historical-team invariant;
  RFC3339 interval and integer boundary rejection.
- `transitions.test.ts`: half-open interval behavior; suspension independent from interval;
  stale-revision rejection; immutable-field rejection; named suspend/reinstate transitions;
  historical nullable-team rows remain detached.
- `import.test.ts`: accepted resolved row; valid multi-position memberships remain distinct;
  duplicate groups quarantine deterministically; null-team historical name is retained; null-team
  without name is quarantined; replay ledger identity is stable.
- `persistence.test.ts`: SQL alias shape decodes through `Model.select`; team/member reads retain
  nullable history; revision update requires the expected revision and returns the incremented
  canonical record; Layer requirement remains `Database`.

Tests are committed but intentionally not executed by this capsule. Integration runs the repository
validation and PostgreSQL/PGlite evidence after the authority wave is assembled.

## Scope and integration handoff

This capsule changes only this spec, `packages/domain/src/organization/**`, the organization SQL
migration, the database migration registry/revision, and organization-focused tests. It does not
modify Admissions, Receipt/Economy, shared root exports, the capability graph, backend composition,
SDK, apps, manifests, or lockfiles.

Required later integration edits (not owned here): export `organization/index.ts` and its models,
Service, Layer, and import contracts from the domain package; add `Organization` to the composed
capability graph and provide `OrganizationLive` in the single backend ManagedRuntime; add any API/
SDK projections while preserving the existing department/team/team-membership HTTP contracts.

## Falsifiers

- A Department, Team, or Membership persisted shape is declared outside its `Model.Class`.
- A SQL adapter introduces a duplicate handwritten row interface or returns an unchecked cast.
- A nullable historical membership is made to look like a live team membership by guessing a team.
- A duplicate legacy membership is silently chosen, overwritten, or made unique before quarantine.
- `endAt` and `isSuspended` are collapsed into one field or one derived persisted flag.
- A membership revision changes an immutable identity or bypasses expected revision/locking.
- An Organization Layer constructs/provides Database instead of retaining it structurally.
- A migration key/order is nondeterministic or replaying it duplicates canonical/quarantine rows.
- A request handler constructs a Layer/ManagedRuntime, or a new generic CRUD method weakens a named
  temporal/suspension invariant.
