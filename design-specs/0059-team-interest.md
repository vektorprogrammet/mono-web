# Design spec 0059 - native team-interest read surface

## Metadata

| Field | Value |
|---|---|
| Goal | Serve the dashboard team-interest page from a native Organization-owned read over durable team-interest registrations |
| Status | Frozen before implementation |
| Base | `eb01f91` (`eb01f9126351b838b430c5291c4bbb2e4ee4a820`) |
| Depends on | 0040 logical capability topology, 0052 native Organization administration, 0055 person-keyed authorization authorities |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect |

## Problem

The dashboard route `apps/dashboard/app/routes/dashboard.teaminteresse._index.tsx` calls `client.admin.teams.interest()`, which issues `GET /api/admin/team-interest` (`packages/sdk/src/domains/admin/teams.ts`). The native backend router has no listener for that path (`apps/backend/src/router.ts:isOrganizationRoute`), so every page load falls through to the compatibility line and dies.

The accepted wire shape is proven by fixture: `apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts` answers `/api/admin/team-interest` with `{"hydra:member":[{"id":2901,"userName":"User-0025","teamName":"Team-0025"}],"hydra:totalItems":1}`, and the SDK unwraps that envelope through `transport.getCollection` into `{items: TeamInterest[], totalItems}` where `TeamInterest` is exactly `{id: Schema.Number, userName: Schema.String, teamName: Schema.String}`. Design spec 0025 §5 froze this mapping and marked richer legacy facts (semester, applicant email/phone, interview-versus-stand source) as `uncovered`.

## Source evidence

This contract uses these sources:

- `vektorprogrammet/src/AppBundle/Entity/TeamInterest.php` and `apps/server/src/App/Organization/Infrastructure/Entity/TeamInterest.php`: the legacy registration fact. Columns `id` (auto-increment), `name`, `email`, `timestamp`, ManyToMany `potentialTeams` (join table `teaminterest_team`), nullable ManyToOne `semester`, nullable `department_id` (added by `Version20181023133033`, backfilled from the semester's department).
- `TeamInterestController::showTeamInterestFormAction` (`POST/GET /teaminteresse/{id}`): the only writer. A stand visitor submits free-text name and email, picks at least one team, and the row is persisted with the current semester and department. No login occurs; the submitter usually has no user account and no `PersonId`.
- `apps/server/varp.yaml` places the TeamInterest entity and controller in the `team` module depending on `[user, organization, security]`, and `apps/server/src/App/Organization/Api/Resource/TeamInterestResource.php` exposes `GET /admin/team-interest` under the Organization API namespace: the modernized Symfony tree itself already classifies team interest as an Organization concern.
- `apps/server/templates/admission_admin/teamInterest.html.twig` renders stand registrations as name + email + team rows, confirming these records are the display source for the teaminteresse surface.
- The dashboard fixture above fixes the intended native wire shape.

### Ownership resolution

The legacy record is a durable human submission, not a derived projection: nothing in departments, teams, memberships, or applications entails it. It therefore cannot be recomputed and must be persisted somewhere. Three findings constrain the model:

1. The submission carries **no person identity**. The submitter is identified only by free-text name and email. A `PersonId`-keyed grant row (0055 style) cannot represent legacy data without inventing identities that do not exist in the source. The minimal record therefore keys the submitter by their submitted email and stores the name verbatim.
2. The fact references Organization entities (team, department, semester) and no other capability's state, and the modernized Symfony tree already houses it under `App\Organization`. Organization is the owner.
3. The wire row is one entry per (interested person × team), which is also the natural row granularity of the flattened join table.

### Shape discrepancy recorded, not invented

Three legacy shapes exist: the aggregate twig page (counts plus interview-side `application.teamInterest` flags), the mono API Platform resource (`{applicants: [{id, name, teams}], teams}`), and the SDK/fixture shape (`{id, userName, teamName}`). The interview-side application flag belongs to Admissions and is out of scope here. This contract freezes the fixture shape because 0025 already accepted it as the page contract and the SDK schema decodes nothing else.

## Decision

Organization gains one minimal persisted fact and one read query. No write route ships in this slice.

### Canonical state

One new table, `organization_team_interest_registrations`, in the Organization migration series:

- `registration_id`: `bigint GENERATED ALWAYS AS IDENTITY`, primary key. This deliberately deviates from the Organization text-ID house pattern: the frozen SDK schema demands a numeric `id`, and preserving legacy numeric identity keeps a future import lossless.
- `submitterName`: bounded non-empty text (max 255), stored verbatim.
- `submitterEmail`: bounded non-empty text with the standard email shape check (max 255).
- `teamId`: reference to `organization_teams`.
- `departmentId`: reference to `organization_departments`.
- `semesterId`: optional text reference. No foreign key crosses into `admission_period_semesters`; semesters are Organization-owned per 0040 but their concrete rows currently live in the Admissions series, and this contract does not move them.
- `submittedAt`: instant, set by the writer.
- `revision`: nonnegative integer.

One row represents one interested person choosing one team, mirroring the flattened `teaminterest_team` join and the fixture row granularity. Resubmissions are new rows; the legacy schema had no uniqueness constraint and none is added.

No role, leader, membership, or authorization copy appears in this table, and no row of the `auth` schema is readable or writable by it.

### Organization Service query

```text
listTeamInterestRegistrations(filter)
  filter:
    authorizedDepartmentIds: DepartmentId[]   (computed by the backend from one projection)
    departmentId?: DepartmentId               (narrowing subset of the authorized scope)
    semesterId?: SemesterId
  -> ReadonlyArray<TeamInterestRegistrationRow>
  row: { registrationId: number, submitterName: string, submitterEmail: string,
         teamId, departmentId, semesterId: string | null, submittedAt }
```

Failures are the existing `OrganizationDecodeError` and `OrganizationPersistenceError` only. The Service performs no authorization: it receives the authorized department set as explicit input, per 0055 §Shared rules.

### Authorization boundary

Gated like the other protected Organization reads through the backend authority flow:

```text
request Cookie -> Auth.resolveSession -> PersonId + one authorizationInstant
  -> Organization.resolvePersonAuthority (same instant)
     ├─ Active global administrator        -> all departments
     ├─ otherwise                          -> union of departments holding an
     |                                        ACTIVE team-leader membership
     └─ empty union                        -> typed denial, HTTP 403
```

A caller-supplied `department` parameter narrows the result inside the authorized scope; a known department outside the scope denies with 403 (`OrganizationRoleDenied`); an unknown department denies with 422 (`OrganizationInvalidReference`). An authenticated caller with no active leader membership receives 403, never an empty success. The adapter reuses one captured `authorizationInstant` for session resolution, projection, and scoping.

Legacy required `ROLE_TEAM_LEADER` for the kontrollpanel page; this contract preserves the leader floor. Plain active members are denied.

### HTTP boundary

The backend adds the exact route `GET /api/admin/team-interest`, dispatched through `makeOrganizationApiHttp` and registered in `isOrganizationRoute`. Query parameters mirror the Symfony controller exactly: `department` and `semester` (numeric-free native identifiers), both optional.

Success responses emit the fixture envelope byte-for-byte in shape:

```json
{ "hydra:member": [ { "id": 2901, "userName": "User-0025", "teamName": "Team-0025" } ],
  "hydra:totalItems": 1 }
```

Rows project only `registrationId -> id`, `submitterName -> userName`, and the referenced team's `name -> teamName`. `submitterEmail` and `submittedAt` are stored but never serialized; 0025 already accounts them as uncovered. Rows order by `registration_id ASC`, which reproduces the legacy insertion-order listing. An empty result is `{"hydra:member": [], "hydra:totalItems": 0}` — a success, not an error.

The SDK domain `admin.teams.interest()` changes none of its types or URL; the existing strict decode continues to succeed.

### Write path and seed

This slice defines storage and read only. The public `POST /teaminteresse/{id}` form remains Symfony-owned; a native create command, confirmation-mail outbox effect, and legacy-row import each require their own frozen contract. Until such a contract lands, a fresh native deployment returns the empty envelope. Disposable test seeds may insert rows directly for read evidence.

## Laws

1. One instant. Each request captures one `authorizationInstant`; session resolution, projection, scoping, and the read all observe it. A retry recomputes everything.
2. Read-only. The route mutates no row, writes no receipt or audit, and claims no command identity.
3. No auth-schema reads. Role and scope facts come solely from the Organization projection; the `auth` schema yields only the session's `PersonId`.
4. Stable ordering. Output order is `registration_id ASC` regardless of plan, concurrency, or environment.
5. No fabricated identity. No code derives a `PersonId` from `submitterEmail`, and no projection joins registrations to persons on email.

## Falsifiers

This contract is incomplete if one condition occurs:

- A response row carries any field beyond `id`, `userName`, and `teamName`, or `id` stops decoding as `Schema.Number`.
- A plain active member, an inactive leader, or an unauthenticated caller receives rows or an empty 200 instead of the typed denial.
- A `department` value outside the authorized scope returns data instead of 403.
- The read spans two authorization instants or reuses a previous request's projection.
- Any writer in this slice creates, updates, or deletes registration rows, or a production import runs under this contract.
- The registration table stores a leader flag, role, suspension state, or any column copied from memberships or the `auth` schema.
- Output ordering depends on database plan, locale, or iteration order.
- The SDK domain grows a second team-interest method, alias, or compatibility path.

## Evidence plan

1. PGlite model checks: schema round-trip of registration rows, exact-envelope serialization, and stable ordering under shuffled inserts.
2. PostgreSQL checks: identity-column behavior, reference integrity against `organization_teams`/`organization_departments`, and index usage for the department/semester filter.
3. HTTP adapter checks: fixture replay asserting the exact JSON body; 401 unauthenticated; 403 for member and inactive-leader actors; 403 out-of-scope and 422 unknown `department`; empty-envelope success.
4. SDK decode proof: `admin.teams.interest()` decodes the native response with the frozen `TeamInterest` schema and excess-property rejection.
5. Scope proof: multi-department leader observes the union; narrowing by each authorized department matches the unscoped filtered result.
6. Regression: the `dashboard-list-type-boundary` fixture journey passes against the native route with no SDK edit.

## Definition of done

1. This frozen contract precedes implementation commits for the native team-interest read.
2. The migration adds `organization_team_interest_registrations` exactly as specified, replay-safe, without touching existing tables.
3. `GET /api/admin/team-interest` answers from Organization state with the fixture shape, ordering, and gating above.
4. The backend computes the authorized department set from one `resolvePersonAuthority` evaluation per request.
5. The SDK requires no change and continues strict decoding.
6. No write route, no import, and no production data change ships under this contract.
