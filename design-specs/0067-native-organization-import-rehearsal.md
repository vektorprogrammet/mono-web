# Design spec 0067 - native Organization import rehearsal

> **Summary:** An operator imports one immutable synthetic Organization snapshot into disposable PostgreSQL. The operator observes provenance, fresh native reads, replay, rollback, and complete disposal.

## Metadata

| Field | Value |
|---|---|
| Spec revision | `0067.0` |
| Status | Contract frozen before implementation. This revision contains no implementation or runtime evidence. |
| Date | `2026-08-30` |
| Base HEAD | `5f9f4c7a6a7c3cb54104d21756311d53d6cc1d48` |
| Goal | Rehearse one production-shaped Organization import without production authority. |
| Actor | One synthetic Organization administrator and one imported synthetic member. |
| Database | One disposable local PostgreSQL database at `23_declarative-authorization-rules`. PGlite is prohibited. |
| Journey | Immutable snapshot to native import authority to fresh Department, Team, and person projections. Then replay, rollback, and disposal. |
| Evidence class | Local runtime observation over synthetic data. It is not proof or production evidence. |
| Operator boundary | No production data, production import, deployment, remote service, provider, notification, or credential effect. |
| Scope holds | Receipt import and production Identity or password import remain separate subsequent contracts. |

## Problem

The native Organization import code can classify legacy-like rows and persist one import transaction. The repository does not have one production-shaped local rehearsal.

Unit observations do not establish the complete authority path. PGlite cannot establish PostgreSQL transaction behavior, schema placement, or real constraint behavior.

A direct SQL seed can bypass the native decoder, classifier, and transaction. A fixture-backed page can also hide a failed or partial import.

The missing contract must expose four result classes. It must expose accepted rows, ordinary quarantine, source collision, and unresolved references.

The contract must also expose occurrence-aware provenance. It must make exact replay and transaction rollback falsifiable from stable bytes and counts.

The rehearsal must not gain production authority. It must not import credentials, passwords, receipts, or other product data.

## Goal

One operator can run one bounded local journey from an immutable synthetic snapshot to fresh native projections.

The journey must use the existing Organization decoder, classifier, Service, PostgreSQL transaction, and read boundaries.

The journey must produce enough evidence to accept or falsify every required state transition. No production resource is an input.

## Constraints

1. The implementation base must equal `5f9f4c7a6a7c3cb54104d21756311d53d6cc1d48`.
2. The contract stays frozen before implementation starts.
3. The source snapshot must equal the frozen fixture in this contract.
4. The database must be disposable, local, and real PostgreSQL.
5. The migration manifest must finish at `23_declarative-authorization-rules`.
6. Every native Organization and authorization table must remain in `public`.
7. Better Auth tables must remain in `auth`.
8. The import must enter through the existing `Organization` Service.
9. Direct SQL can create only the named synthetic prerequisites and local failure objects.
10. Direct SQL must not create an imported Department, Team, Membership, quarantine row, or ledger row.
11. One fixed authorization instant must drive all protected projections.
12. The successful import and replay must use the same `LegacyOrganizationSnapshot` value.
13. The evidence must use stable logical bytes. PostgreSQL data-file bytes are not evidence.
14. When the existing admin pages need no credential or product change, the runner must use a browser.
15. When those pages are not practical under this boundary, the browser gate must record a reason.
16. The journey must not use PGlite, SQLite, an in-memory store, or a mocked PostgreSQL transaction.
17. The journey must not read a legacy database, legacy API, production export, or remote snapshot.
18. After revision 23 is ready, the journey must not change `auth`, create a credential, or create a Better Auth session row.
19. The journey must not request a provider call, outbox delivery, legacy request, deployment, or remote effect.
20. The operator must dispose of every process, port, database, trigger, function, secret, and temporary artifact.

The sanitized evidence artifact is the one retained output. It is not a temporary artifact.

## Values

1. **Production shape without production authority.** Real PostgreSQL and native boundaries matter. Production resources remain unreachable.
2. **One source has one meaning.** The source revision, snapshot hash, transformation revision, and authorization instant never change.
3. **Canonical state stays authoritative.** HTTP, SDK, browser, and evidence artifacts are projections.
4. **Provenance keeps every occurrence.** A repeated source key does not collapse two source rows.
5. **Failure is visible.** A failed transaction leaves stable canonical and provenance bytes unchanged.
6. **Replay is exact.** A second import changes no row, count, timestamp, or logical byte.
7. **Identity stays separate.** Identity supplies a `PersonId`. Organization supplies membership and administrator authority.
8. **Disposal is part of the journey.** A successful observation does not excuse a leaked local resource.

## Exact dependencies

| Dependency | Exact contract for 0067 |
|---|---|
| Design spec 0040 | Use one `Database` capability, one migration manifest, and a live PostgreSQL interpretation. |
| Design spec 0045 | Keep the journey as an Effect program. Keep SQL inside the PostgreSQL interpreter. Keep Service requirements visible. |
| Design spec 0052 | Reuse native Department and Team models, `OrganizationLive`, strict native reads, and the existing dashboard catalog. |
| Design spec 0054 | Identity resolves a bounded cookie to one synthetic `PersonId`. Identity supplies no role or Organization fact. |
| Design spec 0055 | Use person-keyed Organization authority and one `authorizationInstant`. The administrator grant remains a human assertion. |
| Implemented design spec 0056 | Use the rule implementation at `6c2878791ee5356c40a080c419c6d0155de6707e`, an ancestor of the base. Do not invent an Organization administrator rule. |
| Design spec 0066.1 | Keep native tables in `public`. Keep Better Auth tables in `auth`. Check the complete schema boundary. |
| Migration revision 23 | Require `databaseSchemaRevision === "23_declarative-authorization-rules"` from `packages/database/src/migrations.ts`. Apply all 23 registered migrations. |
| Existing import decoders | Reuse `LegacyDepartmentRowSchema`, `LegacyTeamRowSchema`, and `LegacyMembershipRowSchema` from `packages/domain/src/organization/import.ts`. |
| Existing classifier | Reuse `importLegacyOrganizationEffect`. Do not copy or replace its classification rules. |
| Existing transaction | Reuse `importOrganizationSnapshot` from `packages/domain/src/organization/postgres.ts`. It owns `Database.withTransaction`. |
| Existing Service path | Call `OrganizationShape.importLegacyOrganization` through `OrganizationLive`. This path delegates to `importOrganizationSnapshot`. |
| Existing read path | Reuse `listOrganizationDepartments`, `listOrganizationTeams`, and `resolveOrganizationPersonAuthorityForRead`. |
| Existing backend paths | Observe `GET /api/me/session`, `GET /api/departments`, `GET /api/teams`, and `GET /api/admin/users`. |
| Existing browser paths | When practical, observe `/dashboard/team` and `/dashboard/brukere`. These pages are projections, not import authorities. |
| Backend clock composition | Extend `makeBackendHttp(config, run, authHandler, options = {})` with `options.now?: () => string`. Forward this value to every protected authority resolver. |

The existing `/api/admin/users` path is an observation surface from spec 0057. This contract does not change its policy or response shape.

The implemented 0056 rule registry has no Organization administrator capability. The rehearsal must use `organization_global_administrator_grants` from spec 0055.

The evidence composition must pass `{ now: () => authorizationInstant }` to `makeBackendHttp`. Production composition must omit this evidence option.

Every `AuthorityResolutionOptions` value created in `apps/backend/src/router.ts` must receive `{ run, now: options.now }`.

`defaultNow` remains the default only when `options.now` is absent. A global clock patch is prohibited.

## Frozen source and prerequisites

### Fixed references

| Reference | Frozen value |
|---|---|
| `sourceRepository` | `synthetic://spec-0067/legacy-organization` |
| `sourceRevision` | `organization-source-0067-v1` |
| `transformationRevision` | `organization-import-0067-v1` |
| Snapshot hash | `1d79748e449c2e87f5e4a467a3442c2913d6403bac11252630cbf1e347d449a3` |
| `snapshotId` | `sha256:1d79748e449c2e87f5e4a467a3442c2913d6403bac11252630cbf1e347d449a3` |
| `authorizationInstant` | `2037-01-15T12:00:00.000Z` |
| Administrator `PersonId` | `person-organization-import-admin-0067` |
| Imported member `PersonId` | `6731` |

The snapshot hash is `sha256Hex(canonicalJsonBytes(core))`. The `core` value is the JSON value below and excludes `snapshotId`.

The final `LegacyOrganizationSnapshot` adds the frozen `snapshotId` to this value. No field, array order, string, number, null, or boolean can change.

```json
{
  "sourceRepository": "synthetic://spec-0067/legacy-organization",
  "sourceRevision": "organization-source-0067-v1",
  "transformationRevision": "organization-import-0067-v1",
  "departments": [
    {
      "id": 6702,
      "name": "",
      "shortName": "Q67",
      "email": "quarantine.0067@example.invalid",
      "city": "Trondheim",
      "active": true
    },
    {
      "id": 6701,
      "name": "Spec 0067 Department",
      "shortName": "S67",
      "email": "department.0067@example.invalid",
      "city": "Trondheim",
      "active": true
    }
  ],
  "teams": [
    {
      "id": 6712,
      "departmentId": 6799,
      "name": "Unresolved Team",
      "email": "unresolved-team.0067@example.invalid",
      "active": true
    },
    {
      "id": 6711,
      "departmentId": 6701,
      "name": "Spec 0067 Team",
      "email": "team.0067@example.invalid",
      "description": "Imported by the synthetic rehearsal.",
      "shortDescription": "Spec 0067",
      "acceptApplication": false,
      "deadline": null,
      "active": true
    }
  ],
  "memberships": [
    {
      "id": 6723,
      "userId": 6733,
      "teamId": 6798,
      "deletedTeamName": null,
      "startAt": "2037-01-01T00:00:00.000Z",
      "endAt": null,
      "positionId": null,
      "isTeamLeader": false,
      "isSuspended": false
    },
    {
      "id": 6722,
      "userId": 6732,
      "teamId": 6711,
      "deletedTeamName": null,
      "startAt": "2037-01-01T00:00:00.000Z",
      "endAt": null,
      "positionId": 6743,
      "isTeamLeader": false,
      "isSuspended": false
    },
    {
      "id": 6721,
      "userId": 6731,
      "teamId": 6711,
      "deletedTeamName": null,
      "startAt": "2037-01-01T00:00:00.000Z",
      "endAt": null,
      "startSemesterId": 501,
      "endSemesterId": null,
      "positionId": 6741,
      "isTeamLeader": true,
      "isSuspended": false,
      "isActive": true
    },
    {
      "id": 6722,
      "userId": 6732,
      "teamId": 6711,
      "deletedTeamName": null,
      "startAt": "2037-01-01T00:00:00.000Z",
      "endAt": null,
      "positionId": 6742,
      "isTeamLeader": false,
      "isSuspended": false
    }
  ]
}
```

### Allowed prerequisite rows

The operator must insert only these domain prerequisites before the import:

| Table | Frozen synthetic row |
|---|---|
| `public.person_profiles` | `person-organization-import-admin-0067`, `Spec`, `Administrator`, revision `0` |
| `public.person_contact_profiles` | Administrator ID, `organization-import-admin.0067@example.invalid`, `+4700000067`, revision `0` |
| `public.person_profiles` | `6731`, `Imported`, `Member`, revision `0` |
| `public.person_contact_profiles` | `6731`, `imported-member.0067@example.invalid`, `+4700006731`, revision `0` |
| `public.organization_global_administrator_grants` | `grant-organization-import-admin-0067`, administrator ID, start `2037-01-01T00:00:00.000Z`, end `2037-02-01T00:00:00.000Z`, revision `0` |

The grant is disposable authority evidence. It is a human assertion under spec 0055, not an Identity role or an authorization rule.

The evidence composition must provide one bounded `Identity` test Layer. It maps one opaque local cookie to the administrator `PersonId`.

The Layer must return an expiry after the fixed authorization instant. It must create no user, account, session, verification, password, or credential row.

The evidence artifact stores only the cookie SHA-256 digest. It must not store the raw cookie or process secret.

The Profile rows and administrator grant are prerequisites. Their bytes must remain unchanged during import, replay, and failed import.

The three 0056 tables must start empty and remain empty. They are `public.authz_tags`, `public.authz_tag_assignments`, and `public.authz_rules`.

All imported Organization tables and provenance tables must start empty. This condition makes the post-import projection fresh.

## Expected classification and provenance

The classifier ledger must contain entries in this exact order:

| Order | Kind | Source key | Occurrence | Result | Reason | Destination |
|---:|---|---:|---:|---|---|---|
| 1 | department | `6701` | `0` | `Accepted` | `null` | `6701` |
| 2 | department | `6702` | `0` | `Quarantined` | `MISSING_DEPARTMENT_FIELD` | `null` |
| 3 | team | `6711` | `0` | `Accepted` | `null` | `6711` |
| 4 | team | `6712` | `0` | `Quarantined` | `DEPARTMENT_UNRESOLVED` | `null` |
| 5 | membership | `6721` | `0` | `Accepted` | `null` | `6721` |
| 6 | membership | `6722` | `0` | `Quarantined` | `DUPLICATE_MEMBERSHIP` | `null` |
| 7 | membership | `6722` | `1` | `Quarantined` | `DUPLICATE_MEMBERSHIP` | `null` |
| 8 | membership | `6723` | `0` | `Quarantined` | `TEAM_UNRESOLVED` | `null` |

The `6722` rows are one source-key collision. Position `6742` has occurrence `0`. Position `6743` has occurrence `1`.

Each entry must keep this exact target semantic identity:

| Kind | Source key | Occurrence | Target semantic identity |
|---|---:|---:|---|
| department | `6701` | `0` | `department:6701` |
| department | `6702` | `0` | `department:6702` |
| team | `6711` | `0` | `team:6711` |
| team | `6712` | `0` | `team:6712` |
| membership | `6721` | `0` | `6731\|6711\|2037-01-01T00:00:00.000Z\|6741` |
| membership | `6722` | `0` | `6732\|6711\|2037-01-01T00:00:00.000Z\|6742` |
| membership | `6722` | `1` | `6732\|6711\|2037-01-01T00:00:00.000Z\|6743` |
| membership | `6723` | `0` | `6733\|6798\|2037-01-01T00:00:00.000Z\|null` |

The accepted membership ledger row must keep this source metadata:

```json
{"startSemesterId":501,"endSemesterId":null}
```

Every ledger row must keep the exact source repository, source revision, snapshot ID, transformation revision, source kind, raw row, and semantic identity.

The quarantine table must contain five rows. The import ledger must contain eight rows, with three accepted rows and five quarantined rows.

The canonical import must contain one Department, one Team, and one Membership. Their identifiers are `6701`, `6711`, and `6721`.

The accepted Membership must refer to person `6731`, team `6711`, and position `6741`. Its leader flag must be true.

## Semantic inventory

| Item | Semantic class | Authority and meaning |
|---|---|---|
| Frozen source core | Evidence input | Immutable synthetic legacy-like observations. It is not canonical native state. |
| `sourceRevision` | Evidence reference | Identifies the source meaning. It never changes during the journey. |
| `snapshotId` | Evidence reference | Identifies the exact canonical JSON bytes of the frozen core. |
| `transformationRevision` | Evidence reference | Identifies the existing transformation meaning used by this rehearsal. |
| `authorizationInstant` | Query input | Fixes all interval decisions for protected projections. |
| Profile prerequisites | Canonical synthetic state | Profile owns the two names and contact profiles. |
| Administrator grant | Human assertion | Organization owns this disposable administrator evidence. |
| `LegacyOrganizationSnapshot` | Decoded command input | The Organization import boundary accepts this exact value. |
| `OrganizationImportResult` | Returned observation | Reports accepted rows, quarantine rows, and occurrence-aware ledger entries. |
| Organization tables | Canonical state | Department, Team, and Membership truth after commit. |
| Import ledger | Canonical provenance | Links each source occurrence to its result and destination. |
| Quarantine table | Canonical provenance | Keeps rejected raw evidence and an exact reason. |
| HTTP and SDK bodies | Projection | Strict native reads derived from committed canonical state. |
| Browser pages | Projection | Human-visible views derived through the dashboard and SDK. |
| Evidence artifact | Observation projection | Records this local run. It grants no authority. |
| Failure trigger | Harness command | Forces one SQL error inside the import transaction. It has no product meaning. |
| Database disposal | Operator effect | Removes all local rehearsal state. It is not a production rollback design. |

## Authority and effect table

| Component | Accepted input | Read authority | Permitted effect | Forbidden authority or effect |
|---|---|---|---|---|
| Operator | Frozen contract and local command | Local worktree and disposable resources | Start, observe, stop, and dispose of the rehearsal | Production access, publication, deployment, or remote mutation |
| Evidence runner | Frozen manifest and synthetic prerequisites | Local process state and observations | Compose Layers, record evidence, and request cleanup | Domain decisions, result rewriting, or hidden retries |
| Identity test Layer | Opaque local cookie | One in-memory cookie mapping | Return the administrator `PersonId` and fixed expiry | Role facts, `auth` writes, credentials, or password checks |
| Profile | Synthetic `PersonId` queries | `person_profiles` and `person_contact_profiles` | Return strict profile projections | Organization role or import decisions |
| Organization decoder | Unknown source rows | Frozen snapshot bytes | Decode with the three existing row schemas | SQL, defaults outside existing code, or source repair |
| Organization classifier | Decoded source rows | Snapshot references and accepted parent identities | Return `OrganizationImportResult` through `importLegacyOrganizationEffect` | Persistence, guessed references, or collapsed occurrences |
| Organization Service | One `LegacyOrganizationSnapshot` | Existing import and authority capabilities | Call `importOrganizationSnapshot` through `OrganizationLive` | Direct table seed or alternate classifier |
| PostgreSQL interpreter | Classified result | Canonical Organization and provenance rows | Commit one `Database.withTransaction` transaction | Partial commit, legacy write, or `auth` mutation |
| Failure trigger | One ledger insert in the failed run | Current import transaction | Raise SQLSTATE `P0001` before the first ledger row | Commit, data rewrite, or execution outside the failed run |
| Authority resolver | Session `PersonId` and fixed instant | Organization grant and Membership state | Return one person-keyed authority projection | Read a role from Identity or `auth` |
| Backend HTTP | Strict session and read requests | Organization, Profile, and Identity Services | Return strict native JSON responses | Import authority, fixture response, or legacy fallback |
| SDK and Foldkit | Strict native JSON | Backend responses | Decode and display projections | Canonical writes or hidden fallback |
| Evidence recorder | Returned observations and stable table projections | Read-only evidence queries | Write one sanitized local artifact | Product authority, secret capture, or claim expansion |
| Provider, outbox, and legacy adapters | No input | No authority | No effect | Any request, claim, delivery, or fallback |

## Stable evidence bytes

The runner must create canonical logical bytes with `canonicalJsonBytes`. It must hash those bytes with `sha256Hex`.

Each table projection must use an explicit column list. Each projection must qualify its schema and sort by the complete primary key.

Each timestamp must use UTC RFC3339 text. Each JSON value must remain a JSON value, not database display text.

The `canonical` byte set contains these tables:

1. `public.organization_departments`
2. `public.organization_teams`
3. `public.organization_memberships`

The `provenance` byte set contains these tables:

1. `public.organization_membership_quarantine`
2. `public.organization_import_ledger`

The provenance bytes include `quarantined_at` and `recorded_at`. This requirement detects a replay that replaces rows or timestamps.

The `prerequisite` byte set contains the three allowed prerequisite table groups. It includes both Profile tables and the administrator grant table.

The `rule` byte set contains all rows from the three 0056 tables. The `auth` byte set contains the qualified `auth` catalog and every auth-table row count.

The `outbox` byte set contains each `public` table whose name ends with `_outbox`. It contains the table name, ordered row count, and logical digest.

The `receipt` byte set contains these tables:

1. `public.economy_receipts`
2. `public.economy_receipt_command_receipts`
3. `public.economy_receipt_outbox`
4. `public.economy_receipt_audit`
5. `public.economy_receipt_import_ledger`
6. `public.economy_payment_authorities`
7. `public.economy_receipt_approval_grants`

The rule tables, auth data, receipt tables, and outbox tables must start with zero rows. They must remain empty through `S7`.

The checked-in migrations establish the `auth` catalog before `S1`. Its logical catalog bytes must remain equal through `S7`.

A byte comparison means equal UTF-8 length, equal SHA-256 digest, and direct byte equality. Equal counts alone are insufficient.

## Transition flow

```text
frozen core + fixed references
             |
             v
LegacyOrganizationSnapshot
             |
             v
OrganizationShape.importLegacyOrganization
             |
             v
importOrganizationSnapshot
             |
             +-----------------------------+
             |                             |
             v                             v
importLegacyOrganizationEffect     Database.withTransaction
             |                             |
             v                             v
3 accepted + 5 quarantined     canonical rows + provenance
                                           |
                         +-----------------+-----------------+
                         |                                   |
                         v                                   v
                 forced SQL failure                    successful commit
                         |                                   |
                         v                                   v
                 full transaction rollback      HTTP, SDK, person projection
                                                             |
                                                             v
                                                    same-snapshot replay
                                                             |
                                                             v
                                                    complete local disposal
```

### Transition table

| State | Command or observation | Required next state | Rejection behavior |
|---|---|---|---|
| `S0 Empty` | Apply all 23 migrations. Insert only allowed prerequisites. | `S1 Ready` | Stop on revision, schema, prerequisite, or catalog mismatch. |
| `S1 Ready` | Recompute the frozen snapshot hash. Run the existing classifier. | `S2 Classified` | Stop on hash, order, count, result, reason, or provenance mismatch. |
| `S2 Classified` | Install the named local failure trigger. Call the Service import once. | `S3 RolledBack` | The expected SQLSTATE is `P0001`. Any success is a falsifier. |
| `S3 RolledBack` | Read canonical and provenance bytes. Remove the trigger and function. | `S4 RetryReady` | If any byte or count differs from the `S1` baseline, stop. |
| `S4 RetryReady` | Call the same Service import with the same snapshot object. | `S5 Committed` | Stop on any typed or SQL failure. |
| `S5 Committed` | Read PostgreSQL, native HTTP, protected admin, and person projections. | `S6 Observed` | Stop on stale, fixture, legacy, unordered, or mismatched output. |
| `S6 Observed` | Call the Service import again with the same snapshot object. | `S7 Replayed` | Stop on any changed result, row, count, timestamp, or logical byte. |
| `S7 Replayed` | Run the practical browser gate. Then dispose of all resources. | `S8 Disposed` | Stop on a leaked process, port, database, trigger, function, secret, or file. |

### Failure injection

The failed run must use the unmodified production import path. The harness must add one local PostgreSQL trigger to the disposable database.

The trigger must be named `spec_0067_fail_organization_ledger`. Its function must be named `public.spec_0067_fail_organization_ledger()`.

The trigger must run `BEFORE INSERT` on `public.organization_import_ledger`. It must raise SQLSTATE `P0001` before the first ledger insert.

The harness must install this exact failure mechanism:

```sql
CREATE FUNCTION public.spec_0067_fail_organization_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION
    USING ERRCODE = 'P0001',
          MESSAGE = 'spec 0067 injected organization ledger failure';
END;
$function$;

CREATE TRIGGER spec_0067_fail_organization_ledger
BEFORE INSERT ON public.organization_import_ledger
FOR EACH STATEMENT
EXECUTE FUNCTION public.spec_0067_fail_organization_ledger();
```

After the failed import, the harness must use these exact cleanup statements:

```sql
DROP TRIGGER spec_0067_fail_organization_ledger
  ON public.organization_import_ledger;
DROP FUNCTION public.spec_0067_fail_organization_ledger();
```

PostgreSQL must raise SQLSTATE `P0001`. The Service call must return the existing typed `OrganizationPersistenceError`.

An evidence-only SQL observer must wrap `DatabaseLive` and delegate every query and transaction unchanged. It must not replace a result or error.

The observer must record this ordered write-attempt trace before PostgreSQL returns the injected error:

| Phase | Attempt count |
|---|---:|
| `DepartmentInsert` | `1` |
| `TeamInsert` | `1` |
| `MembershipInsert` | `1` |
| `QuarantineInsert` | `5` |
| `LedgerInsert` | `1` |
| `LedgerSqlError` | `1` |

The final trace item must record SQLSTATE `P0001` and message `spec 0067 injected organization ledger failure`.

The failed Service observation must have `_tag: \"OrganizationPersistenceError\"` and `operation: \"persist organization import\"`.

The trace proves that the error follows attempted canonical and quarantine writes. A trace recorded only from static source inspection is insufficient.

At that point, the transaction has attempted canonical and quarantine writes. PostgreSQL must roll back every attempted write in that transaction.

The runner must compare `S1` and `S3` canonical and provenance bytes. The bytes and all five table counts must be equal.

The runner must remove the trigger and function before the successful import. The final catalog must not contain either object.

### Successful commit and fresh projections

After the commit, PostgreSQL must contain these exact counts:

| Table | Count |
|---|---:|
| `public.organization_departments` | `1` |
| `public.organization_teams` | `1` |
| `public.organization_memberships` | `1` |
| `public.organization_membership_quarantine` | `5` |
| `public.organization_import_ledger` | `8` |

`GET /api/me/session` must return status `200` and the administrator `PersonId`. A missing cookie must return the existing typed `401` response.

`GET /api/departments` must return one strict native Department. Its ID and name must be `6701` and `Spec 0067 Department`.

`GET /api/teams` must return one strict native Team. Its ID, Department ID, and name must be `6711`, `6701`, and `Spec 0067 Team`.

`GET /api/admin/users` must use the same session cookie and fixed authorization instant. It must return status `200`.

The active user array must contain person `6731` exactly once. That row must contain department name `Spec 0067 Department` and `isActive: true`.

The inactive user array must contain the administrator exactly once. That row must have no department and `isActive: false`.

The evidence must call `OrganizationShape.resolvePersonAuthorityForRead` through `OrganizationLive` for person `6731`. Its ordered Membership array must contain only `6721`.

The Service method must delegate to `resolveOrganizationPersonAuthorityForRead`.

That authority projection must contain team `6711`, department `6701`, `active: true`, and `teamLeader: true`.

All four native reads must come from the backend process attached to the rehearsal database. A recorder stub or embedded fixture is prohibited.

### Browser practicality gate

The runner must first check whether the existing pages can use the bounded cookie without a credential or product change.

If this check passes, real Chromium must open `/dashboard/team` and `/dashboard/brukere`. It must display the imported Team, member, and Department.

The browser observation must record the session read and native backend reads. It must record zero legacy Organization requests and zero page errors.

If this check fails, the evidence must record `BrowserNotPractical`. It must name the exact missing existing capability.

When a browser requires a credential, an `auth` write, a product change, or a legacy service, it is not practical.

A missing browser binary or an occupied port is an environment failure. It is not a valid `BrowserNotPractical` result.

### Same-snapshot replay

The replay must use the same in-memory snapshot object and the same four fixed references. It must not parse a second fixture copy.

The first and second `OrganizationImportResult` values must have equal canonical bytes. Both results must contain the expected eight ledger entries.

The `S5` and `S7` canonical bytes must be equal. The `S5` and `S7` provenance bytes must also be equal.

All five table counts must remain `1`, `1`, `1`, `5`, and `8`. No recorded timestamp can change.

The prerequisite, rule, auth, receipt, and outbox byte sets must remain equal to their `S1` values.

### Disposal rollback

Disposal removes the complete local database and all runner-owned resources. It does not define a production rollback command.

The runner must stop Chromium, dashboard, backend, and PostgreSQL clients. It must close each runner-owned port.

When the catalog also disappears, container removal is sufficient.

The runner must remove the opaque cookie, process secret, temporary PostgreSQL data, browser output, trigger, function, and unsanitized evidence.

The sanitized evidence must record cleanup results. It must not contain a cookie, password, secret, contact value, or PostgreSQL URL password.

The runner must retain the sanitized artifact after disposal. It must remove every other runner output.

## User and operator journey

1. The operator checks the exact base HEAD and frozen fixture hash.
2. The runner starts one disposable real PostgreSQL database.
3. The migration runner applies all 23 migrations and checks the 0066.1 schema boundary.
4. The runner inserts the two Profile fixtures and one disposable Organization administrator grant.
5. The runner checks that all import, provenance, rule, auth, receipt, and outbox data starts empty.
6. The existing classifier returns three accepted rows and five quarantined rows in the frozen order.
7. The runner installs the local ledger failure trigger and calls the native Organization import Service.
8. PostgreSQL raises the expected error and rolls back the complete import transaction.
9. The runner observes unchanged canonical and provenance bytes.
10. The runner removes the failure trigger and calls the same import Service again.
11. PostgreSQL commits one Department, one Team, one Membership, five quarantine rows, and eight ledger rows.
12. The native backend returns the fresh Department, Team, session, administrator, and imported-person projections.
13. When the practicality gate passes, real Chromium displays the existing admin journey.
14. The runner imports the same snapshot again and observes exact replay.
15. The runner records zero auth, credential, rule, receipt, outbox, provider, legacy, production, deployment, and remote effects.
16. The runner disposes of every local resource and records the disposal result.
17. A reviewer accepts or falsifies the run from the sanitized artifact and its SHA-256 digest.

## Required evidence artifact

The future runner must write one sanitized local JSON artifact. The suggested local path is `/tmp/mono-web-0067-organization-import-evidence.json`.

The artifact must contain these fields:

1. Contract revision and exact base HEAD.
2. Source repository, source revision, snapshot ID, snapshot hash, and transformation revision.
3. Fixed authorization instant and hashed session-cookie identity.
4. PostgreSQL version, database name hash, migration count, and `databaseSchemaRevision`.
5. Qualified table inventory for `public` and `auth`.
6. Prerequisite row identities and sanitized values.
7. Classifier result, ordered outcome matrix, and occurrence-aware provenance.
8. Failed Service observation, SQLSTATE, trigger message, ordered write-attempt trace, and pre-failure and post-failure byte lengths, digests, counts, and equality.
9. Post-commit and post-replay byte lengths, digests, counts, and direct equality results.
10. Strict HTTP statuses and sanitized response bodies.
11. Person authority projection and its fixed `evaluatedAt` value.
12. Browser result or the exact `BrowserNotPractical` reason.
13. Rule-write, production-resource, legacy, provider, outbox, receipt, auth-write, credential, deployment, and remote-effect counters.
14. Process exit statuses, port-release observations, database disposal, and residual-object inventory.
15. Evidence classification as local runtime observation, with no production or proof claim.
16. The canonical `artifactCore` and its stored `evidenceSha256` value.

`artifactCore` contains fields 1 through 15. It excludes `evidenceSha256`.

The runner must compute `evidenceSha256 = sha256Hex(canonicalJsonBytes(artifactCore))`.

The stored artifact must add `evidenceSha256` to `artifactCore`. A reviewer must reproduce the digest from the stored core.

A failed check must remain in the artifact. The runner must not rewrite a failed result as skipped or accepted.

An SQL observer and a network guard must own forbidden-effect counters. Transaction rollback must not reset these counters.

The SQL observer must count each attempted rule-table or `auth` DML statement before delegation. Both counters must equal zero.

It must also count receipt-table and outbox DML attempts. Both counters must equal zero.

The network guard must allow only loopback destinations used by this journey. It must reject every other destination before dispatch.

The artifact must record the allowed destinations and every rejected destination. The production-resource counter must equal zero.

## Definition of done

All statements below must be true for completion:

1. The implementation starts from the exact base and changes no frozen fixture value.
2. A real local PostgreSQL server applies all 23 migrations without PGlite.
3. The 0066.1 catalog check places native tables in `public` and Better Auth tables in `auth`.
4. Setup creates only the named Profile rows, administrator grant, bounded Identity Layer, and temporary failure objects.
5. The existing decoder and classifier produce the exact eight-row outcome matrix.
6. Occurrence `0` and occurrence `1` survive as different provenance rows for source key `6722`.
7. The failed import raises SQLSTATE `P0001` after attempted canonical writes.
8. The failed import leaves canonical and provenance bytes and counts unchanged.
9. The successful import commits the exact five table counts.
10. Fresh native Department, Team, session, administrator, and person projections match this contract.
11. The same-snapshot replay returns equal result bytes and changes no persisted logical byte.
12. The practical browser path displays the imported values, or the artifact contains a permitted practicality failure.
13. The prerequisite, rule, auth, receipt, and outbox byte sets remain unchanged.
14. No forbidden effect counter is greater than zero.
15. Disposal removes every runner-owned database object, process, port, secret, and unsanitized artifact.
16. One sanitized evidence artifact contains every required observation and a reproducible digest.
17. Independent review can map each artifact claim to a named input, transition, authority, and observation.

## Falsifiers

Any condition below falsifies this contract:

- The implementation base differs from the exact base HEAD.
- Implementation starts before this contract is frozen.
- The source core or any fixed reference differs from this contract.
- The runner reads mutable, legacy, production, or remote source data.
- The runner uses PGlite, SQLite, an in-memory database, or a mocked transaction.
- The migration revision is not `23_declarative-authorization-rules`.
- A native table ends in `auth`, or a Better Auth table ends in `public`.
- The import bypasses `OrganizationShape.importLegacyOrganization`, `OrganizationLive`, or `importOrganizationSnapshot`.
- The implementation copies, replaces, or weakens the existing decoder or classifier.
- The ordered outcome matrix differs in result, reason, destination, or occurrence.
- The two `6722` rows collapse into one provenance row.
- A quarantined row loses its raw source, semantic identity, reason, or source metadata.
- The failure occurs outside `Database.withTransaction` or before attempted canonical writes.
- The failed import changes a canonical or provenance count, byte, timestamp, or digest.
- The successful import produces a table count other than `1`, `1`, `1`, `5`, and `8`.
- A fresh read comes from a fixture, stale cache, alternate database, or legacy fallback.
- A protected projection uses more than the fixed authorization instant.
- Identity supplies a role, membership, Department, Team, or administrator fact.
- An Organization administrator rule is added to the 0056 registry or rule tables.
- An `auth` catalog object or row changes after `S1` and before disposal.
- Any user, account, session, verification, password, or credential row is created.
- Replay changes a result byte, database byte, count, timestamp, or order.
- A browser claim lacks a real Chromium observation and native request capture.
- `BrowserNotPractical` hides a missing binary, occupied port, or runner error.
- Any receipt import, outbox delivery, provider call, legacy request, deployment, or remote effect occurs.
- Any production resource, data, credential, database, hostname, or secret becomes reachable.
- Cleanup leaves a process, port, database, trigger, function, secret, or unsanitized artifact.
- The evidence omits a failed check or claims proof, production acceptance, or production rollback authority.

## Non-goals and subsequent contracts

This contract does not authorize or design the following work:

| Excluded work | Named subsequent contract |
|---|---|
| Receipt data import | **Native Receipt import rehearsal** |
| Profile data migration | **Native Profile import rehearsal** |
| Content data migration | **Native Content import rehearsal** |
| Schools data migration | **Native Schools import rehearsal** |
| Recruitment data migration | **Native Recruitment import rehearsal** |
| Production Identity, account, or password import | **Production Identity and account migration** |
| Password reset and account recovery policy | **Production password reset and recovery policy** |
| Production Organization rollback | **Production Organization rollback plan** |
| Remote deployment or data cutover | **Remote migration deployment and cutover** |

These names reserve contract boundaries. They are not implementation tasks in spec 0067.

This contract also excludes Profile, Content, Schools, and Recruitment data from the frozen snapshot.

It excludes password migration, account migration, password-reset policy, production rollback, remote deployment, and production cutover.

It makes no claim about Receipt import, provider delivery, outbox delivery, legacy parity, hosted CI, or production readiness.
