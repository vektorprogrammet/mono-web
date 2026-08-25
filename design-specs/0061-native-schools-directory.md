# Design spec 0061 - native schools directory

## Metadata

| Field | Value |
|---|---|
| Goal | Replace the dead `/dashboard/skoler` loader with one native school directory read |
| Status | Frozen before implementation |
| Base | `2e031738d12f94c611426c5ac884861dec227abd` (`2e03173`) |
| Depends on | 0040 logical capability topology, 0045 Effect Model and Service authority, 0055 person-keyed authorization authorities |
| Route | `/dashboard/skoler` |
| HTTP | `GET /api/admin/schools` |
| Operator boundary | No production import, production data change, credentials, deployment, or external effect |

## Problem

The route loader calls `client.admin.scheduling.schools()`. The SDK sends `GET /api/admin/scheduling/schools` and expects a Hydra collection.

The native backend has no route for that path. The request reaches `RouteNotFound`, so the page has no native data path.

The current page is also the wrong product projection. It shows a capacity record ID, a school name, and a nested capacity value.

The accepted legacy schools page is a department-scoped directory. It shows active and inactive schools with contact and language facts.

The current SDK call comes from the assistant-scheduling endpoint. That endpoint returns current-semester capacity rows, not the school directory.

This contract corrects the journey. It does not preserve the accidental scheduling projection as the schools page.

## Source evidence

This contract uses these sources at the base revision:

- `apps/dashboard/app/routes/dashboard.skoler._index.tsx` owns the dead loader and its current three-column table.
- `packages/sdk/src/domains/admin/scheduling.ts` sends the Symfony-shaped collection request.
- `packages/sdk/src/schemas/scheduling.ts` accepts only numeric `id`, `name`, and an open nested capacity record.
- `apps/backend/src/router.ts` has no route for `/api/admin/scheduling/schools`.
- Design spec 0025 records the mismatch between the school directory and the scheduling SDK projection.
- Legacy `SchoolAdminController::showAction` scopes a member to one department and splits schools by active state.
- Legacy `SchoolAdminController::showSchoolsByDepartmentAction` lets a leader select a department.
- Legacy `school_admin/index.html.twig` owns the active tab, inactive tab, department context, and search control.
- Legacy `school_admin/school_table.html.twig` owns the school, contact, phone, email, and language columns.
- Legacy `School` owns name, free-text contact person, email, phone, language, active state, and department links.
- Legacy `SchoolCapacity` owns weekday counts for one school, department, and semester.
- Legacy `AssistantSchedulingController::getSchoolsAction` adapts each capacity row into two identical group records.
- Mono `AdminSchedulingSchoolProvider` keeps that adapter and returns the capacity row ID as `id`.
- Mono migration `Version20260810002046` records the valid capacity identity as school, semester, and department.
- Legacy `varp.yaml` declares `school` as a distinct domain with an Organization dependency.
- The mono Symfony tree places the same records under `App\Scheduling`, outside Organization and Admission.
- Design spec 0052 explicitly excludes School and school-capacity authority from its Organization slice.
- Native Admissions owns admission windows, application review, and applicant submission. It owns no school reference record.
- Native Profile owns person names and contacts. A school contact is free text and has no required `PersonId`.
- Native real-session tests sign in through `/login`, use Better Auth cookies, and exercise admin, leader, member, and denial paths.

## Actual product journey

The felt journey is the school directory, not the assistant-allocation input.

1. An authenticated team member opens `/dashboard/skoler`.
2. The request captures one `authorizationInstant`.
3. Identity resolves the session to one `PersonId`.
4. Organization resolves all memberships and the administrator grant at that instant.
5. The directory computes the caller scope from that complete projection.
6. The Schools authority reads schools that intersect the scope in one database snapshot.
7. The page shows active schools first and inactive schools in a second tab.
8. Each row shows school, contact person, phone, email, language, and authorized departments.
9. The user can search the loaded rows by visible text.
10. A multi-department person sees the union of all active membership departments.
11. A school linked to many visible departments appears once with every visible department.
12. An authenticated person with no active Organization authority sees a typed denial.
13. The page never calls Symfony, the scheduling-school endpoint, or a fixture fallback.

The page has no create, edit, delete, assistant-allocation, or capacity-edit command in this slice.

## Ownership decision

School and capacity reference data belongs to a distinct logical `Schools` capability.

The existing topology omitted this capability. That omission does not transfer the state to the nearest implemented Service.

The evidence gives these ownership rules:

| Fact | Owner | Reason |
|---|---|---|
| School name, contact, email, phone, language, and active state | `Schools` | These facts describe an external teaching school. They are not entailed by Organization or Admissions state. |
| School-to-department association | `Schools` | The association says where Vektorprogrammet uses a school. Organization owns the referenced `DepartmentId`. |
| Weekday capacity for a school, department, and semester | `Schools` | The row is a planning assertion consumed by scheduling. It is not an admission result. |
| Department identity and active state | `Organization` | This remains canonical Organization state. |
| Semester identity and calendar | `Organization` | Design spec 0040 already assigns semesters to Organization. |
| Admission windows and applicants | `Admissions` | These facts do not own a school or its capacity. |
| Person names and contacts | `Profile` | These facts do not own the free-text school contact. |
| Assistant assignment to a school | A later operational contract | An assignment is not school reference data. This contract does not assign its owner. |

This contract amends the logical capability inventory with this row:

| Capability | Owns | Logical authority dependencies |
|---|---|---|
| `Schools` | schools, department associations, semester capacity plans | `Database`, `Organization` |

`Schools` is a capability, not a required process. It runs in the existing native backend process.

A later scheduler can depend on `Schools`. That dependency does not transfer ownership of school or capacity rows.

## Canonical schemas

### SchoolId

`SchoolId` is a positive safe integer. Numeric identity preserves the existing school identity without a synthetic text mapping.

### School

`School` is one authoritative `Model.Class` with these fields:

| Field | Schema | Rule |
|---|---|---|
| `schoolId` | `SchoolId` | Database generated and immutable |
| `name` | non-empty string, maximum 255 | Stored verbatim after outer whitespace validation |
| `contactPerson` | non-empty string, maximum 255 | Free text, not a `PersonId` |
| `email` | email string, maximum 255 | School contact email |
| `phone` | non-empty string, maximum 255 | Stored verbatim |
| `language` | `Norwegian` or `International` | Native replacement for the legacy `international` boolean |
| `active` | boolean | Controls active and inactive directory tabs |
| `revision` | nonnegative integer | Database generated, absent from create JSON |

The persisted model has select, insert, update, JSON-read, JSON-create, and JSON-update variants.

`schoolId` and `revision` are absent from create JSON. `schoolId` is absent from all update variants.

### SchoolDepartment

`SchoolDepartment` is one authoritative `Model.Class` with these fields:

| Field | Schema | Rule |
|---|---|---|
| `schoolId` | `SchoolId` | References `School` |
| `departmentId` | `DepartmentId` | References canonical Organization state |
| `revision` | nonnegative integer | Starts at zero |

The pair `(schoolId, departmentId)` is the semantic identity. The relation has no primary-department field.

### SchoolCapacityPlan

This contract freezes capacity ownership and shape for later consumers. The directory does not read or serialize this model.

| Field | Schema | Rule |
|---|---|---|
| `capacityId` | positive safe integer | Database generated and immutable |
| `schoolId` | `SchoolId` | References `School` |
| `departmentId` | `DepartmentId` | References Organization |
| `semesterId` | `SemesterId` | References the Organization-owned semester calendar |
| `monday` | nonnegative integer | One weekday count |
| `tuesday` | nonnegative integer | One weekday count |
| `wednesday` | nonnegative integer | One weekday count |
| `thursday` | nonnegative integer | One weekday count |
| `friday` | nonnegative integer | One weekday count |
| `revision` | nonnegative integer | Starts at zero |

The tuple `(schoolId, departmentId, semesterId)` is unique.

The model has no group map. The legacy provider copied one weekday record into groups 1 and 2 without supporting state.

A later capacity journey must use this canonical weekday shape. It cannot restore the copied group projection.

### Directory schemas

`SchoolDirectoryDepartment` contains exactly:

```text
{ departmentId: DepartmentId, name: string }
```

`SchoolDirectoryEntry` contains exactly:

```text
{
  schoolId: number,
  name: string,
  contactPerson: string,
  email: string,
  phone: string,
  language: "Norwegian" | "International",
  departments: SchoolDirectoryDepartment[],
  isActive: boolean
}
```

`SchoolDirectoryPage` contains exactly:

```text
{
  activeSchools: SchoolDirectoryEntry[],
  inactiveSchools: SchoolDirectoryEntry[],
  nextCursor: string | null
}
```

Every decoder rejects excess properties.

Each school appears in exactly one array. `isActive` must agree with the containing array.

`departments` contains only the intersection between the school associations and caller scope. It is sorted by `departmentId` and deduplicated.

Global administrators can also observe an unassigned school. Its `departments` value is empty.

## Directory laws

1. One instant drives session resolution, Organization authority, scope, and the directory read.
2. One read-only database snapshot supplies the Organization projection, school rows, and department names.
3. A retry captures a new instant and recomputes all authority.
4. The read changes no row, receipt, audit record, revision, or outbox request.
5. A school appears once, even when many visible department links reach it.
6. A scoped caller never observes an unauthorized department association.
7. Active state comes only from `School.active`.
8. Global-administrator status does not change a school's active state.
9. Rows order by `name COLLATE "C"`, then `schoolId`.
10. A cursor names the last emitted `(name, schoolId)` tuple.
11. The next page resumes strictly after that tuple.
12. A full page walk visits each visible school exactly once inside one snapshot.
13. Search changes only the Foldkit projection of loaded rows. It creates no server authority.
14. Capacity rows cannot change any directory byte in this slice.

## Authority matrix

The request captures one `authorizationInstant` after session decoding. Every matrix row uses that instant.

| Caller projection | Scope | Result |
|---|---|---|
| Missing or invalid session | None | HTTP 401, `UnauthenticatedActor` |
| Active global administrator | All departments and unassigned schools | HTTP 200 |
| One or more active memberships | Union of every active membership department | HTTP 200 |
| Memberships exist, but none are active | None | HTTP 403, `AuthorityInactive` |
| Only future or ended administrator grants exist | None | HTTP 403, `AuthorityInactive` |
| No membership or administrator record exists | None | HTTP 403, `NotInScope` |

Team leadership does not increase the read scope. The legacy directory had a team-member read floor.

An optional `department` query narrows the authorized union. It cannot create authority.

A known department outside the caller scope returns HTTP 403. An unknown department returns HTTP 422.

An authorized scope with no matching school returns HTTP 200 with empty arrays.

## Service and Layer contract

`Schools` is an Effect `Context.Service`. Its public shape contains one query in this slice:

```text
listDirectory(input)
  input:
    scope: All | DepartmentIds<nonempty>
    departmentId?: DepartmentId
    cursor?: SchoolDirectoryCursor
    limit: integer in [1, 100]
  -> SchoolDirectoryPage
```

The default limit is 50 at the HTTP boundary. The Service receives a decoded limit.

`SchoolDirectoryCursor` is opaque outside the capability. It encodes version 1 and the last `(name, schoolId)` tuple.

The Service fails with these typed failures only:

- `SchoolsDecodeError`
- `SchoolsCursorInvalid`
- `SchoolsPersistenceError`

Authorization is a named journey program, not a second Service:

```text
readSchoolsDirectory(personId, authorizationInstant, query)
  requires Database | Organization | Schools
```

The journey opens one read-only transaction. It resolves Organization authority, maps the matrix, and invokes `Schools.listDirectory` in that transaction.

`SchoolsLive` has this structural requirement:

```text
Layer.Layer<Schools, never, Database>
```

The logical `Organization` dependency remains visible in the named journey and capability graph. `SchoolsLive` does not construct Organization or Database.

The composition root creates `schoolsLayer` once, merges it into the existing capability graph, and disposes it with the ManagedRuntime.

The HTTP adapter imports no SQL client. It decodes the request, invokes the journey, and maps typed results.

## Persistence and migration contract

The Schools capability owns `packages/domain/src/schools/migrations/0001-schools-directory.sql`.

The application migration manifest imports it as the next ordered migration. Tests and runners use that same source.

The migration creates these tables:

1. `schools_directory_schools`
2. `schools_directory_departments`

`schools_directory_schools` stores the `School` fields. `school_id` is `bigint GENERATED ALWAYS AS IDENTITY`.

`schools_directory_departments` has a composite primary key on `(school_id, department_id)`.

The association table has these foreign keys:

- `school_id` references `schools_directory_schools` with `ON DELETE CASCADE`.
- `department_id` references `organization_departments` with `ON DELETE RESTRICT`.

The migration adds an index on `(department_id, school_id)` and a stable directory index on `(name COLLATE "C", school_id)`.

The migration does not create a capacity table. `SchoolCapacityPlan` ownership is frozen, but no capacity consumer cuts over in this journey.

A later capacity contract must add its table in the Schools migration series. It must reference the same school and Organization identities.

The physical `admission_period_semesters` table currently carries a native semester calendar. Its name does not transfer semantic ownership to Admissions.

This slice does not move or copy semester rows because the directory does not read them. A capacity contract must first reconcile that table with Organization ownership.

There is no command receipt, audit table, or outbox table for this read-only slice.

There is no legacy-row import or production backfill. A later import requires a separate frozen contract and operator authority.

## HTTP boundary

The backend adds exactly this native read:

```text
GET /api/admin/schools?department=<DepartmentId>&cursor=<opaque>&limit=<1..100>
```

All query parameters are optional. Unknown parameters fail strict decoding with HTTP 422.

The response is the exact `SchoolDirectoryPage` shape. It is not Hydra and has no JSON-LD fields.

Failure mapping is exact:

| Failure | HTTP status |
|---|---:|
| Missing or invalid session | 401 |
| `AuthorityInactive` or `NotInScope` | 403 |
| Unknown department | 422 |
| Department outside caller scope | 403 |
| Malformed cursor, limit, or query | 422 |
| Database or row decode failure | 503 |

`GET /api/admin/scheduling/schools` does not become a native route. No forwarding or compatibility response remains.

## SDK boundary

The SDK adds one strict administrator domain:

```text
client.admin.schools.list({ department? })
  -> { activeSchools: SchoolDirectoryEntry[], inactiveSchools: SchoolDirectoryEntry[] }
```

The method calls `GET /api/admin/schools`. It walks `nextCursor` until the server returns null.

The SDK sends the next cursor only after strict page decoding. It rejects a repeated cursor as a transport decode failure.

The clean cutover removes these parts:

- `AdminSchedulingDomain.schools`
- the `SchedulingSchool` schema and exports
- the `/api/admin/scheduling/schools` dashboard fixture
- every production caller of the old method

The assistant and substitute methods can remain in `AdminSchedulingDomain`. They do not authorize a school alias.

The SDK adds no legacy shape, Hydra alternative, excess-property allowance, or fixture fallback.

## Full-Foldkit state ownership

The React route mounts one `vektor-schools-directory` custom element. React Router owns route matching only.

Foldkit owns:

- remote `AsyncData`
- active or inactive tab selection
- search text
- optional department narrowing
- request identity
- page accumulation
- retry count
- stale-response rejection
- empty, loading, denial, failure, and ready states
- all rendered directory rows

The Foldkit command uses only `client.admin.schools.list()`.

A success message replaces the Model only when its request ID matches the active request.

A retry creates a new request ID. A stale success or failure leaves the Model unchanged.

The view uses an accessible heading, tabs, search label, table headers, status text, and retry button.

The ready view shows these columns:

- `Skole`
- `Kontaktperson`
- `Telefon`
- `E-post`
- `Språk`
- `Avdeling`

React owns no loader fetch, `useLoaderData`, local store, effect, table state, or fallback data.

The navigation marks `Skoler` as a team-member link. This matches the authority matrix.

## Disposable seed and evidence plan

The seed is local and disposable. It creates records in this order:

1. Better Auth users and credential accounts for the browser personas.
2. Profile person and contact rows required by native authentication.
3. Organization departments, teams, memberships, and one administrator grant.
4. Schools and school-to-department associations.

The seed includes these cases:

- one active global administrator
- one active member in one department
- one active member in two departments
- one person with only an ended membership
- one person with no Organization authority record
- one active school in one department
- one inactive school in one department
- one school linked to two departments
- one unassigned school visible only to the administrator
- one department with no school

The evidence contains these parts:

1. Model checks for every derived variant and excess-property rejection.
2. Pure authority checks for every matrix row at exact interval boundaries.
3. Pure projection checks for scope intersection, deduplication, tab partition, and stable ordering.
4. PGlite checks for migration replay, foreign keys, and deterministic cursor walking.
5. PostgreSQL checks for the read-only snapshot and a concurrent association change between pages.
6. HTTP checks for 401, all 403 cases, 422 cases, empty success, and strict query decoding.
7. SDK checks for strict page decoding, full cursor walking, repeated-cursor rejection, and Hydra rejection.
8. Foldkit Update checks for loading, retry, stale result, tab, search, empty, denial, and failure transitions.
9. Accessibility checks for the heading, tabs, search input, table, alert, and keyboard use.
10. Real-session Chromium checks against disposable PostgreSQL and the native backend.

The browser journey signs in through the real login page. It does not inject a bearer token into a dashboard request.

The administrator observes all schools and the unassigned school. The multi-department member observes one shared school row with both departments.

The one-department member observes only that department. The ended member and no-authority person observe typed denial states.

The browser switches tabs, searches by school and contact, and retries one forced native failure.

A request ledger records no call to Symfony, `/api/admin/scheduling/schools`, or a fixture server.

PGlite does not prove PostgreSQL snapshot behavior. Only the PostgreSQL check supports that claim.

## Definition of done

1. This frozen contract precedes implementation commits for `/dashboard/skoler`.
2. The logical capability inventory includes `Schools` with the ownership and dependencies in this contract.
3. One authoritative `School` model derives all persisted and JSON variants.
4. The canonical migration creates only the school and department-association tables required by this read.
5. The migration manifest runs the same Schools migration in PGlite and PostgreSQL.
6. `SchoolsLive` requires Database structurally and is built once in the process composition root.
7. The named directory journey resolves one Organization projection at one `authorizationInstant` in one read-only snapshot.
8. The team-member scope, administrator scope, inactive denial, and no-authority denial match the matrix.
9. `GET /api/admin/schools` returns the exact strict page shape and failure statuses.
10. The SDK exposes only `client.admin.schools.list()` for this directory and walks every page safely.
11. The old scheduling-school SDK method, schema export, fixture route, and production caller are removed.
12. `/dashboard/skoler` is a full-Foldkit owner with no React data or interaction state.
13. The ready page shows active and inactive tabs, search, and all six frozen columns.
14. Capacity rows and copied scheduling groups do not affect any directory response or view.
15. Focused model, migration, database, HTTP, SDK, Foldkit, accessibility, and real-session browser checks pass.
16. The browser ledger records no Symfony request, old scheduling-school request, or fixture fallback.
17. No compatibility endpoint, dual read, dual write, production import, credentials, deployment, or external effect occurs.

## Falsifiers

This contract is incomplete if one condition occurs:

- Organization, Admissions, Profile, Recruitment, or Identity writes a school or capacity reference row.
- A school contact becomes a Profile person without an explicit `PersonId` assertion.
- One primary department replaces a person's complete active membership scope.
- One primary department replaces a school's visible department set.
- A team leader gets a wider directory scope than another active member with the same memberships.
- An inactive or no-authority person receives an empty HTTP 200 instead of a typed 403.
- One school appears more than once because it has many department associations.
- A scoped caller observes an unauthorized department association.
- Capacity state changes a directory byte.
- A nested group capacity is persisted or synthesized from one weekday record.
- The response contains Hydra, JSON-LD, a total from Symfony pagination, or an excess field.
- The SDK accepts both the native and Symfony-shaped school responses.
- The backend serves `/api/admin/scheduling/schools` as an alias or forwarder.
- An HTTP adapter imports SQL or computes the directory projection.
- A request uses more than one authorization instant or mixes database snapshots.
- A request constructs a Layer, ManagedRuntime, or database pool.
- React owns directory data, tab state, search state, retry state, or a fetch effect.
- A fixture, mock module, bearer-token map, or swallowed loader error supplies production rows.
- A disposable seed or checked-in legacy scan is presented as production-import approval.
- PGlite evidence is presented as PostgreSQL snapshot proof.

## Non-goals

This contract does not authorize school create, update, delete, capacity editing, assistant allocation, or school assignment.

It does not migrate legacy school or capacity rows. It does not change production data.

It does not decide the owner of assistant placement. It does not add a scheduling algorithm.
