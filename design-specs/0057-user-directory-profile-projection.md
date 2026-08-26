# Design spec 0057 - user directory Profile projection

## Metadata

| Field | Value |
|---|---|
| Goal | Replace the mocked `/dashboard/brukere` page with one native admin user directory owned by Profile, with Organization-derived department and status |
| Status | Contract remains frozen; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence are pending |
| Base | `eb01f9126351b838b430c5291c4bbb2e4ee4a820` (`eb01f91`) |
| Depends on | 0040 logical capability topology, 0045 Effect Model/Service authority, 0053 native Profile self-edit, 0055 person-keyed authorization authorities |
| Required by | 0058 Organization-owned person field-of-study association (named follow-up contract) |
| Routes | `GET /api/admin/users`, `/dashboard/brukere` |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect. Disposable local PostgreSQL and Chromium evidence only |

## Problem

The `/dashboard/brukere` page has no warranted data path. Its loader calls
`client.admin.users.list()` toward `GET /api/admin/users`, but no native backend
route listens there. The call fails, the loader swallows the error, and the page
renders `getActiveUsers()` and `getInactiveUsers()` from
`apps/dashboard/app/mock/api/data-brukere.ts` in every environment.

The legacy Symfony page renders these columns from the `User` entity:
Fornavn, Etternavn, Tlf, E-post, Linje, Avdeling, and Aktivert. The native page
mocks the same shapes with invented people. Neither column set reaches the
browser from canonical state today.

### Rejected alternative: listing Identity

Building the directory from the Better Auth tables is rejected. One line per reason:

- Role, department, or permission data stored in or read from the `auth` schema is forbidden by the spec 0054 and spec 0055 falsifiers.
- Spec 0054 frozen contract 8 admits no social providers, no SSO, and no plugins; an identity listing requires the Better Auth admin plugin.
- `auth.user.name` is one single string; Profile owns the structured `firstName` and `lastName`.
- Phone, study programme, department, and activation status do not exist in the `auth` schema.
- The checked-in foreign key makes `auth.user.id` reference `person_profiles(person_id)`; `auth.user` is a credential subset of the Profile person population, so an Identity listing cannot enumerate all persons and inverts the ownership direction.

## Decision

Profile owns the directory read. Organization derives each person's departments
and activity. The existing backend router authority flow gates the route.

```text
request Cookie
    |
    v
Auth session resolution -> PersonId + one authorizationInstant
    |
    v
caller authority projection (Organization)
    |
    +-------------------------------------+
    | active global administrator         | department leader            | otherwise
    v                                     v                              v
all departments                    union of active-leader        typed 403 denial
                                   departments as scope
    |                                     |
    +------------------+------------------+
                       |
                       v
        Profile paged directory scan
        person_profiles JOIN person_contact_profiles
        one database snapshot
                       |
                       v
        per-person Organization derivation
        membership -> team -> department
        interval + suspension at the instant
                       |
                       v
        { activeUsers, inactiveUsers }
```

### Profile directory read

Profile scans `person_profiles` joined to `person_contact_profiles`. The scan
is paged. One page carries at most `limit` persons ordered by `lastName`,
then `firstName`, then `personId`. A cursor token names the last emitted sort
tuple; the next page resumes strictly after it.

A missing contact row for a scanned person is a typed persistence failure. The
directory never fabricates contact values and never silently drops the row.

The read is read-only. It writes no row, bumps no revision, and emits no outbox
request.

### Organization derivation

For each scanned person, the directory derives its Organization facts from
canonical Organization state at the request's `authorizationInstant`, using the
same law as the spec 0055 person projection:

- A membership is active at instant `t` when `startAt <= t`, `endAt` is absent or `t < endAt`, the membership is not suspended, and the referenced team and department are active.
- `departments[]` holds every distinct department reachable through the person's resolvable memberships via `membership.teamId -> team.departmentId`, in stable sorted order. Detached memberships with no team contribute nothing.
- `isActive` is true when at least one membership is active at the instant. It is false otherwise, including when every membership is historical, suspended, or detached.
- The global-administrator status (`Active`, `Inactive`, `Absent`) travels beside these facts as its own field. It never overrides `isActive`, never selects a primary department, and never filters a row.

A person with multiple departments yields one entry containing all departments.
The derivation never collapses the set to one primary department.

Deleted-team history yields an `Inactive` row, not an exclusion. A person row
exists exactly when a `person_profiles` row exists.

### Gating

The gate reuses the spec 0055 flow: cookie to session to `PersonId`, one
captured `authorizationInstant`, one caller projection from Organization. No
gate step consults Better Auth beyond session resolution, and no gate step reads
the `auth` schema.

| Caller projection at the instant | Scope | Result |
|---|---|---|
| Active global administrator | All departments | Full directory |
| At least one active team-leader membership | Union of those leader departments | Rows whose `departments[]` intersect the scope |
| Memberships exist but none active, or grants only ended | None | Typed 403 denial, `AuthorityInactive` |
| No Organization authority record | None | Typed 403 denial, `NotInScope` |

An empty intersection yields a 200 with empty arrays; it is a legitimate view,
not a denial. A list query evaluates the whole authorized scope. It never
selects one membership and discards the others.

### HTTP and SDK contract

`GET /api/admin/users` mounts under the existing backend router dispatch beside
the other `/api/admin/*` routes. The adapter decodes transport data, resolves
authority through the shared helpers, and maps typed results. It imports no SQL
and implements no domain transition.

The response keeps the frozen shape:

```text
{
  activeUsers:   DirectoryEntry[],
  inactiveUsers: DirectoryEntry[],
  nextCursor: string | null
}
```

Each entry carries exactly:

- `personId`
- `firstName`
- `lastName`
- `email`
- `phone`
- `studyProgramme`: always `null` in this slice
- `departments[]`: sorted, deduplicated
- `isActive`: boolean

Every person lands in exactly one array: `activeUsers` when `isActive` is true,
`inactiveUsers` otherwise. The SDK keeps its `{ activeUsers, inactiveUsers }`
result and its `list()` method. It walks pages with `nextCursor` until
exhaustion; the stable ordering law makes the accumulated arrays deterministic.

HTTP maps failures as follows:

| Failure | Status |
|---|---:|
| Missing or invalid session | 401 |
| Typed scope or inactivity denial | 403 |
| Malformed paging cursor | 422 |
| Missing contact row for a scanned person | 503 |
| Database failure | 503 |

### Study programme

`studyProgramme` is `null` in every entry of this slice. The value becomes
non-null only when spec 0058 adds the Organization-owned person-to-field-of-study
association. No interim source substitutes for it: not the legacy `User.fieldOfStudy`
column, not `organization_field_of_studies`, not the auth schema. This is a named
follow-up contract, not an omission to backfill quietly.

## Laws

1. One captured `authorizationInstant` per request drives the caller gate and every row derivation. No row uses a different instant.
2. The read is read-only. No command table, revision, audit row, or outbox request changes.
3. No code in the directory path reads the `auth` schema. Session resolution enters through the typed Auth Service seam and nothing more.
4. The caller projection, the paged scan, and all per-person Organization facts derive from one database snapshot in one transaction. The directory never mixes snapshots.
5. Paging is stable: ordering by `lastName`, then `firstName`, then `personId`; a full walk visits each person exactly once, and page boundaries neither duplicate nor drop a person within one snapshot.
6. Historical, suspended, and detached memberships yield `isActive: false` rows, never exclusions.
7. Multi-department persons keep all departments inside one entry. No primary department exists.
8. `isActive` derives only from membership intervals, suspension, and team and department activity at the instant. The global-administrator status never overrides it.

## Falsifiers

This slice inherits every falsifier of specs 0054 and 0055. Additionally, the
slice is incomplete if one condition occurs:

- A directory row or field is sourced from `auth.user`, `auth.session`, or any other `auth`-schema table.
- A person is shown in `activeUsers` whose only membership ended strictly before the captured instant.
- A multi-department person produces one row per department, instead of one entry whose `departments[]` holds every department.
- A caller who is neither an active global administrator nor an active department leader receives rows instead of a typed 403 denial.
- A `studyProgramme` value is fabricated from anything except the future spec 0058 Organization-owned association.
- A person with a missing contact row disappears silently instead of failing the read.
- The page renders `getActiveUsers()` or any mock value outside fixture mode.

## Evidence plan

1. Pure model checks against the domain laws: interval boundaries (`startAt` inclusive, `endAt` exclusive), suspension, deactivated team and department, detached and historical memberships, multi-department accumulation, `isActive` independence from the global-administrator status, gate mapping for all caller shapes, and sort-tuple stability.
2. PostgreSQL snapshot check: one connection ends a membership while a second walks the directory; the walk observes one snapshot with no mixed rows. A second check inserts a person between pages and proves the cursor skips no row and duplicates none.
3. HTTP checks: 401 without a session; typed 403 for a plain member, an inactive leader, and an inactive administrator; 200 per scope with an active administrator seeing cross-department persons and a leader seeing exactly the scope intersection, including a 200 with empty arrays.
4. SDK checks: strict decode of the frozen response shape, rejection of excess entry fields, and the unchanged `list()` two-array result across page walks.
5. Browser journey on seeded disposable PostgreSQL: authenticate as an administrator, open `/dashboard/brukere`, observe both tabs filled from native data, switch tabs, verify the Fornavn through Avdeling columns, verify a seeded multi-department person shows both departments in one row, verify an ended-membership person sits under Inaktive Brukere; authenticate as a department leader and observe the scoped rows; authenticate as a plain member and observe the denial state. Record zero mock-module reads and zero queries against the `auth` schema beyond session resolution.

## Definition of done

1. This frozen contract precedes implementation commits.
2. Profile exposes one paged directory read that owns the `person_profiles` and `person_contact_profiles` scan.
3. Every department and activity fact derives from canonical Organization state at the request instant through the membership-to-team-to-department path.
4. `GET /api/admin/users` dispatches under the existing backend router authority flow; the adapter contains no SQL and no business transition logic.
5. The gate admits an active global administrator to all departments, a department leader to the union of active-leader departments, and issues typed 403 denials to everyone else; unauthenticated requests receive 401.
6. The response keeps the `{ activeUsers, inactiveUsers }` shape with the frozen eight-field entry, `studyProgramme` null throughout.
7. The SDK decodes strictly and keeps the `list()` two-array contract across paged walks.
8. `/dashboard/brukere` renders native data in production mode and surfaces denial states without fixture fallback.
9. No role, membership, department, or status copy exists in Profile state or the `auth` schema.
10. All eight laws hold under the evidence plan, on PostgreSQL for snapshot and paging behavior.
11. Focused model, database, HTTP, SDK, and browser checks pass; root type, format, lint, build, and test gates pass on the committed revision.
12. No production import, production data change, credential change, deployment, or external effect occurs.
