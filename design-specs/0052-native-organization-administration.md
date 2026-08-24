# Design spec 0052 - Native Organization administration

> **Summary:** An organization administrator creates native departments, teams, and fields of study. Public Foldkit views read the fresh native records.

## Metadata

| Field             | Value                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status            | Frozen before implementation                                                                                                                                                       |
| Base              | `ac942572d63d7de4a05354d2be699d785af90f1a` (`ac94257`)                                                                                                                             |
| Goal              | Replace the Symfony Organization administration seam with one native Organization authority and fresh public views                                                                 |
| Actor             | Existing active organization administrator from the bounded test-principal configuration                                                                                           |
| Rejected actor    | Existing organization member without administrator authority                                                                                                                       |
| Routes            | `/api/admin/departments`, `/api/admin/teams`, `/api/admin/field-of-studies`, `/api/departments`, `/api/teams`, `/api/field_of_studies`, `/dashboard/team`, and `/dashboard/linjer` |
| Journey authority | `intent://journey:parity:org_admin:v1` from design spec 0024                                                                                                                       |
| Architecture      | Design specs 0040, 0045, and 0048                                                                                                                                                  |
| Operator boundary | No production data, credentials, remote database, provider, deployment, or external notification effect                                                                            |
| Scope hold        | Identity credentials, sessions, role storage, and final access-policy authority remain last                                                                                        |

## Problem

The native `Organization` Service owns Department, Team, and Membership records. It does not own creation commands or fields of study.

The native backend has no Organization routes. The SDK still sends public Organization reads to Symfony-shaped routes without a native listener.

The `/dashboard/team` and `/dashboard/linjer` routes use React loaders and legacy-backed SDK domains. Foldkit owns no Organization interface state.

The accepted browser evidence also starts Symfony. It does not prove native authority, PostgreSQL transactions, or fresh native views.

## Source evidence

This contract uses these sources:

- `design-specs/0040-logical-capability-topology.md` assigns Department, Team, and FieldOfStudy to Organization.
- `design-specs/0048-organization-effect-model-authority.md` establishes the current Organization Service and PostgreSQL Layer.
- `apps/dashboard/e2e/real-symfony-org-operations.spec.ts` records the accepted legacy journey.
- `packages/sdk/src/domains/public/teams.ts` contains the current legacy-backed team read.
- `packages/sdk/src/domains/public/misc.ts` contains the current legacy-backed department and field reads.
- `dashboard.team._index.tsx` and `dashboard.linjer._index.tsx` contain the current React-owned views.

The legacy journey creates one Department, one Team, and one FieldOfStudy. It then reads and displays the created Team and FieldOfStudy.

The journey also rejects a Team with an unknown Department. It denies a Department command from an ordinary member.

## User journey

1. The evidence runner starts disposable PostgreSQL, the native backend, and the dashboard.
2. An administrator sends one strict Department command.
3. Organization stores the Department, the command receipt, and one audit fact in one transaction.
4. The administrator sends one strict Team command for the new Department.
5. Organization stores the Team, the command receipt, and one audit fact in one transaction.
6. The administrator sends one strict FieldOfStudy command.
7. Organization stores the FieldOfStudy, the command receipt, and one audit fact in one transaction.
8. Fresh public reads return the created Department, Team, and FieldOfStudy.
9. `/dashboard/team` displays the Team from the native public read.
10. `/dashboard/linjer` displays the FieldOfStudy from the native public read.
11. A Team command with an unknown Department returns a typed `422` response and changes no row.
12. A Department command from an ordinary member returns a typed `403` response and changes no row.
13. An exact command replay returns the original observation without another row or audit fact.
14. A different command with the same command ID returns a typed `409` response and changes no row.
15. The runner records no Symfony Organization request.

## Semantic boundary

```text
strict HTTP command or public query
              |
              v
      Organization Service
       requires Database
              |
       +------+------+
       |             |
       v             v
canonical records  receipt + audit
       |
       v
strict public projection
       |
       v
Foldkit catalog Model -> View
```

The administrator token is an input observation from the composition configuration. It is not a canonical Identity record.

The Service owns all authorization decisions for these commands. The HTTP handler does not authorize a command by route selection alone.

## Canonical models

`packages/domain/src/organization/schema.ts` remains the only persisted Organization model authority.

### Existing Department

The existing `Department` model remains authoritative. A native create command supplies these fields:

- `commandId`
- `name`
- `shortName`
- `email`
- `address`
- `city`
- `latitude`
- `longitude`

The command does not supply `departmentId`, `revision`, `slackChannel`, `logoPath`, or `active`.

The transition derives `departmentId` from the command kind and command ID. It sets `revision` to zero and `active` to true.

The transition sets `slackChannel` and `logoPath` to null. No hidden default adds business data.

### Existing Team

The existing `Team` model remains authoritative. A native create command supplies these fields:

- `commandId`
- `departmentId`
- `name`
- `email`
- `description`
- `shortDescription`
- `acceptApplication`
- `deadline`
- `active`

Nullable values remain explicit null values. `deadline` is null or an RFC3339 instant.

The command does not supply `teamId` or `revision`. The transition derives `teamId` and sets `revision` to zero.

Organization rejects the command if `departmentId` does not identify a canonical Department.

### New FieldOfStudy

Organization adds one `Model.Class` with these persisted fields:

- `fieldOfStudyId`
- `name`
- `shortName`
- nullable `departmentId`
- `active`
- `revision`

A create command supplies `commandId`, `name`, `shortName`, and nullable `departmentId`.

The accepted journey creates a global FieldOfStudy with `departmentId` set to null. A non-null Department must exist.

The command does not supply `fieldOfStudyId`, `active`, or `revision`. The transition derives the identity and sets the generated fields.

### Identity derivation

A pure function derives each entity ID from the entity kind and `commandId`. The result uses the complete SHA-256 digest.

The three entity kinds use distinct prefixes. A caller cannot select or overwrite an entity identity.

### Derived schemas

Each model derives strict select, insert, update, JSON, create, and update variants where applicable.

Generated and immutable fields do not occur in create or update inputs. Unknown fields fail with strict Effect Schema decoding.

## Commands, observations, and failures

Organization adds these tagged commands:

- `CreateDepartment`
- `CreateTeam`
- `CreateFieldOfStudy`

Each command contains one `OrganizationCommandId`. Each command has a canonical digest over its strict decoded representation.

Organization returns one tagged observation with the canonical created entity. An exact replay returns a `Replayed` observation with the original observation.

The command result states whether the transaction committed a new command. A replay cannot look like a new write.

Typed failures include:

- `OrganizationRoleDenied`
- `OrganizationInvalidReference`
- `OrganizationCommandConflict`
- existing Organization decode and persistence failures

A malformed input maps to `422`. An unknown Department reference maps to `422` without Department details.

A denied actor maps to `403`. A command-ID conflict maps to `409`. A persistence failure maps to `503`.

## Authorization boundary

The backend configuration maps bounded bearer tokens to one of these actor variants:

- `OrganizationAdministrator`
- `OrganizationMember`

Both variants contain a stable person ID. Only `OrganizationAdministrator` can use the three create commands.

The Service checks the actor variant before a database write. A route handler cannot bypass this check.

This actor mapping is a temporary composition seam. It does not claim Identity persistence or role-policy cutover.

Public Organization reads require no bearer token. They expose no membership, person, audit, command, or configuration data.

## Transaction laws

The PostgreSQL adapter uses one transaction for each accepted command.

The transaction follows this order:

1. Acquire the established PostgreSQL command lock for `commandId`.
2. Read an existing command receipt.
3. Return the original observation for an equal digest.
4. Reject a different digest for the same command ID.
5. Check the required actor and foreign references.
6. Insert one canonical entity.
7. Insert one command receipt.
8. Insert one audit fact.
9. Read and return the canonical entity.
10. Commit all rows together.

A failure before commit leaves the entity, receipt, and audit tables unchanged.

The receipt stores the canonical command and observation. It also stores the command digest, entity kind, entity ID, actor, and commit instant.

The audit fact links to the receipt by `commandId`. Database constraints keep receipt, audit, and canonical entity links consistent.

Imported Department and Team rows remain valid. They have no native creation receipt and do not gain invented provenance.

PGlite proves portable transaction and relational behavior. It does not prove PostgreSQL command-lock concurrency.

Disposable PostgreSQL proves one-winner command replay and conflict behavior through independent connections.

## Database migration

The ordered migration registry adds one deterministic revision after revision 12.

The migration creates these structures:

- `organization_field_of_studies`
- `organization_command_receipts`
- `organization_creation_audit`
- nullable native-creation provenance links on Department and Team
- indexes and deferred relational constraints for new native commands

The migration is replay safe. It does not rewrite imported Organization records.

The migration does not copy data from Symfony. Production import remains outside this slice.

## HTTP boundary

The native backend adds these exact public routes:

- `GET /api/departments`
- `GET /api/teams`
- `GET /api/field_of_studies`

The backend adds these exact administrator routes:

- `POST /api/admin/departments`
- `POST /api/admin/teams`
- `POST /api/admin/field-of-studies`

Public queries reject query parameters. Create routes require `application/json`, a bounded body, and the configured bearer token.

Every request and response uses strict Effect Schema decoding. Excess fields fail before the Service command.

A successful new create returns `201`. An exact replay returns `200`. Both responses return a strict typed result.

The handler receives `Organization` from the shared backend runtime. It does not construct a Layer, Database, or ManagedRuntime.

The backend router dispatches these routes directly. No request reaches Symfony or a compatibility handler.

## SDK boundary

The SDK adds one public Organization domain with these operations:

- `listDepartments`
- `listTeams`
- `listFieldOfStudies`

The administrator SDK adds one Organization domain with these operations:

- `createDepartment`
- `createTeam`
- `createFieldOfStudy`

These domains use the native strict schemas. They do not use Hydra collection decoding or Symfony numeric-ID schemas.

All production callers migrate to the new Organization domains. The old public team and miscellaneous Organization methods are removed.

No alias, re-export, fallback, dual read, or compatibility path remains.

## Foldkit ownership

The team and field routes mount one shared Organization catalog custom element with an explicit catalog kind.

Foldkit owns:

- the catalog kind
- remote `AsyncData`
- request identity
- retry state
- safe failure feedback
- all rendered catalog state

Foldkit commands call the strict public Organization SDK. A success message replaces the Model only with the fresh response.

The team route displays `Team` and the field route displays `FieldOfStudy`. Each view has an accessible heading and table semantics.

React Router owns route matching and initial custom-element rendering. React owns no Organization fetch, store, effect, or interactive state.

The profile-edit field list also uses the native Organization SDK. Its existing interaction owner remains outside this route cutover.

## Browser and runtime evidence

One deterministic local runner starts these real components:

- disposable PostgreSQL
- the native backend with fixed Organization actors
- the dashboard
- Chromium

The runner sends the three accepted create commands through the native HTTP and SDK boundary.

The runner makes fresh public reads. Then Chromium displays the created Team and FieldOfStudy through the Foldkit views.

The runner also records these counterexamples:

- unknown Department returns `422`
- ordinary member returns `403`
- exact replay creates no second entity or audit
- changed replay returns `409`
- no Symfony Organization request occurs

The runner emits a canonical receipt for `intent://journey:parity:org_admin:v1`.

The receipt covers exactly these accepted steps:

- `org-admin-api-operation`
- `org-admin-command-write`
- `org-admin-legacy-route`
- `org-admin-mono-route`

The receipt can replace the legacy receipt only after the runtime-evidence authority accepts it. Generated parity files derive from that authority.

## Focused checks

The implementation includes these focused checks:

- Model variant keys and strict command decoding
- deterministic entity identity derivation
- administrator and member authorization transitions
- exact replay and command conflict
- unknown and valid Department references
- transaction rollback and relational linkage in PGlite
- independent PostgreSQL command concurrency
- strict HTTP status and body mapping
- strict SDK request and response decoding
- Foldkit stale-result and retry transitions
- accessibility checks for both catalog views
- a real Chromium journey against the native backend and PostgreSQL
- accepted runtime-evidence and parity regeneration

## Definition of done

1. This frozen spec precedes every Organization administration implementation commit.
2. Organization is the sole writer for Department, Team, and FieldOfStudy creation.
3. Canonical models derive every persisted and JSON shape.
4. Every accepted command stores one entity, receipt, and audit fact atomically.
5. An exact replay is idempotent. A changed replay is a typed conflict.
6. Unknown Department references and member actors change no row.
7. Native public reads return strict stable-ID projections.
8. The SDK has one Organization domain and no legacy Organization domain.
9. The team and field routes use the shared Foldkit catalog owner.
10. The browser displays fresh native records and records no Symfony request.
11. The native receipt replaces the legacy org-admin receipt through the evidence authority.
12. Focused and repository checks pass on the committed revision.

## Falsifiers

This slice is incomplete if one condition occurs:

- Symfony handles an Organization read or create command.
- Two Services own Department, Team, or FieldOfStudy creation.
- A handler or PostgreSQL adapter invents a second persisted model shape.
- A browser command supplies an entity ID, revision, audit field, or actor role.
- A denied actor reaches an entity insert.
- An unknown Department creates a Team or a department-scoped FieldOfStudy.
- An exact replay creates another entity or audit fact.
- A changed command reuses an old receipt.
- A response commits without its receipt and audit fact.
- A public response exposes command, actor, audit, membership, or configuration data.
- A dashboard route uses React state, loader data, a fetcher, or a legacy SDK method for the catalog.
- A command response is reported as the fresh public observation.
- A fixture or source assertion is reported as browser evidence.
- PGlite output is reported as PostgreSQL concurrency proof.
- A legacy runtime receipt remains authoritative after the native receipt is accepted.

## Non-goals

This slice does not migrate Identity credentials, sessions, role storage, password flows, or final access policy.

This slice does not add Organization update or delete commands. It does not add team memberships or team-interest commands.

This slice does not add School, Semester, school-capacity, sponsor, mailing-list, statistics, assistant, or substitute authority.

This slice does not import production data. It does not deploy or call an external provider.
