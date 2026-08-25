# Design spec 0060 - native mailing-list projection

## Metadata

| Field | Value |
|---|---|
| Goal | Serve the dashboard mailing-list page from a pure Organization read-time projection with no new persisted state |
| Status | Frozen before implementation |
| Base | `eb01f91` (`eb01f9126351b838b430c5291c4bbb2e4ee4a820`) |
| Depends on | 0040 logical capability topology, 0052 native Organization administration, 0055 person-keyed authorization authorities |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect |

## Problem

The dashboard route `apps/dashboard/app/routes/dashboard.epostliste._index.tsx` calls `client.admin.mailingLists()`, which issues `GET /api/admin/mailing-lists` (`packages/sdk/src/domains/admin/misc.ts`). The native backend router has no listener for that path, so every page load dies at the compatibility fallthrough.

The accepted wire shape is proven by fixture: `apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts` answers `/api/admin/mailing-lists` with `[{"name":"List-0025","emails":["first@example.invalid","second@example.invalid"]},{"name":"Empty-0025","emails":[]}]`, a bare array of `{name, emails: string[]}`, and the SDK decodes exactly that via `transport.get(..., Schema.Array(MailingList))`. Design spec 0025 §5 froze the flatten rule for the page and recorded the legacy type selection as uncovered.

## Source evidence

This contract uses these sources:

- Legacy controller family (`vektorprogrammet/src/AppBundle/Controller/MailingListController.php`, routes `routing.yml:1251-1278`): three GET routes — `/kontrollpanel/epostlister/assistenter`, `/kontrollpanel/epostlister/teammedlemmer`, `/kontrollpanel/epostlister/alle` — each reading query parameters `department` and `semester` (numeric IDs, resolved by `BaseController::getDepartmentOrThrow404` / `getSemesterOrThrow404`).
- The modernized mono tree (`apps/server/src/App/Organization/Api/State/MailingListProvider.php`) confirms the semantics and adds the API defaults: `type` defaults to `assistants`; unknown `department` or `semester` yields an empty result; unknown `type` yields empty users. The legacy `Assistent`/`Team`/`Alle` form values became `assistants`/`team`/`all`.
- Member sources, per `UserRepository`: `assistants` = users with an AssistantHistory row in the department and semester; `team` = users whose TeamMembership interval covers the semester in that department; `all` = the union of both, deduplicated by user identity in first-seen order.
- Email source (the decisive question): the legacy twig renders `{{ u.companyEmail ? u.companyEmail : u.email }}`, but both the legacy API-era mapping and the mono `MailingListProvider` map `'email' => $user->getEmail()`. The canonical native contact fact is Profile's `person_contact_profiles.email` (`PersonContactProfile`), owned by the Profile capability per 0040. The company-email fallback is an Identity-era artifact with no canonical native home; this contract uses Profile contact email only.
- There is no durable mailing-list state anywhere in either tree: no table, no entity, no write path. Every byte of output is derivable from memberships, assistant history, and person contacts.

### Capability placement

The member-selection facts split across capabilities:

- team membership intervals: canonical Organization state (`organization_memberships`), already evaluated by the 0055 authority machinery;
- assistant history: not yet modeled natively (no domain module owns it); it belongs to Admissions' accepted-assistant record;
- person names and emails: canonical Profile state (`person_profiles`, `person_contact_profiles`).

Organization is therefore the composition point, not the sole owner. The Service composes its own membership facts with Profile reads through explicit Layer inputs, mirroring how Recruitment already consumes Profile. This contract does not move any fact between owners.

The list name is a request-derived label (`{type}-{departmentId}`), not stored state.

## Decision

A pure derived projection, computed at one instant from Organization membership facts plus Profile contact emails. No new table, column, receipt, audit row, or outbox entry is created. No mailing-list state may ever be persisted.

### Projection

```text
projectMailingLists(input) -> ReadonlyArray<MailingList>
  input:
    type: "assistants" | "team" | "all"
    authorizedDepartmentIds: DepartmentId[]   (from one authority evaluation)
    departmentId?: DepartmentId               (narrowing subset)
    semesterId?: SemesterId                   (defaults to the current semester
                                               per the Admissions calendar when absent)
    membersByDepartment: Map<DepartmentId, PersonId[]>   (injected source rows)
    contacts: Map<PersonId, { name, email }>  (Profile read result)
```

One `MailingList` per distinct department present in the authorized scope:

- `name`: `{type}` + department identifier, stable and derived — never stored.
- `emails`: for each selected member in stable `(personId)` order, the Profile contact email; persons without a resolvable contact profile contribute nothing and are never invented. Duplicates collapse to one entry each, keeping first occurrence. A department with zero eligible members still emits its list with `emails: []` — the fixture proves an empty list is a real success value.

Type selection mirrors the mono provider exactly:

| `type` | Members |
|---|---|
| `assistants` (default) | persons holding an assistant-history fact in the department and semester |
| `team` | persons with an active-at-instant membership interval covering the semester in the department |
| `all` | union of both, deduplicated by person, assistants-first order preserved |

Until Admissions freezes an assistant-history contract, the `membersByDepartment` input is the single seam: the adapter supplies team members from Organization today, and assistant sources plug into the same input without changing this contract's laws.

### Authorization boundary

Identical gating to spec 0059: cookie -> session -> `PersonId` + one `authorizationInstant` -> `Organization.resolvePersonAuthority`; active global administrator reads all departments, otherwise the union of departments with an ACTIVE team-leader membership; empty union denies with typed 403. A caller-supplied `department` narrows within scope (out-of-scope known department: 403; unknown: 422). One captured instant covers resolution, scoping, and the projection.

### HTTP boundary

The backend adds the exact route `GET /api/admin/mailing-lists`, dispatched through `makeOrganizationApiHttp` and registered in `isOrganizationRoute`. Query parameters mirror the mono provider exactly: `type` (default `assistants`), `department` (optional), `semester` (optional). An invalid `type` value maps to `422` under strict Effect decoding — the mono provider returned empty users for unknown types, and strictness wins where no fixture depends on the lax behavior; every other failure keeps the shared error taxonomy (401 unauthenticated, 403 denied, 503 persistence).

Success responses emit the fixture shape as a bare JSON array of `{name, emails}` objects, ordered stably by list name:

```json
[ { "name": "List-0025", "emails": ["first@example.invalid", "second@example.invalid"] },
  { "name": "Empty-0025", "emails": [] } ]
```

An empty authorized-but-unmatched result is `[]` — a success. The SDK domain `admin.misc.mailingLists()` changes none of its types or URL; the existing strict decode continues to succeed.

## Laws

1. One instant. All membership activity, semester coverage, and authority facts evaluate against one captured `authorizationInstant`; no request mixes snapshots.
2. Pure derivation. The response is a function of canonical inputs only. Two evaluations over identical state at identical instants return byte-identical bodies.
3. Zero persistence. No mailing-list table, cache table, materialized view, command receipt, or audit row exists for this surface — now or later.
4. No fabricated emails. Every serialized email resolves to a `person_contact_profiles` row. No fallback synthesizes, transforms, or guesses an address; missing contacts shrink the list silently.
5. No auth-schema reads. Role and scope come solely from the Organization projection.
6. Stable ordering. Lists order by name; members order by `personId`; deduplication preserves first-seen position.
7. Explicit inputs. The projection receives member rows and contacts as arguments; it performs no ambient service lookups, so the pure transition stays testable without a database.

## Falsifiers

This contract is incomplete if one condition occurs:

- A response entry carries anything beyond `name` and `emails`, or an email appears that has no corresponding `person_contact_profiles` row for a selected member.
- Any migration, seed, or code path creates a persisted mailing-list structure, cache, or snapshot.
- A plain active member, inactive leader, or unauthenticated caller receives lists instead of the typed denial.
- A caller-supplied department outside the authorized scope returns lists instead of 403.
- Two evaluations over the same state at the same instant produce different bytes.
- The projection reads or writes the `auth` schema, or derives role facts outside the Organization projection.
- A company email, username-derived address, or Identity artifact leaks into the output.
- The SDK grows a second mailing-list method, alias, or compatibility decode path.
- Ordering depends on plan, hash iteration, locale, or concurrency.

## Evidence plan

1. Pure truth tables: for each `type`, member sets spanning assistants-only, team-only, overlap, disjoint, and missing-contact cases, assert the exact projected arrays including empty-list entries and dedup order.
2. PGlite checks: seeded departments, teams, memberships (active/ended/suspended across the semester boundary), and contact profiles produce the exact wire body; a second run returns identical bytes.
3. HTTP adapter checks: default `type=assistants`; explicit `team` and `all`; `department` narrowing inside scope; 403 out-of-scope and non-leader actors; 401 unauthenticated; 422 unknown `type` and unknown `department`.
4. Instant law check: mutate a membership end between two requests and observe the second response reflect the change while each response stays internally consistent.
5. Anti-fabrication check: delete one member's contact profile and confirm that member's email vanishes while the list itself survives.
6. SDK decode proof: `admin.misc.mailingLists()` decodes the native response with the frozen `MailingList` schema.
7. Regression: the `dashboard-list-type-boundary` fixture journey passes against the native route with no SDK edit.

## Definition of done

1. This frozen contract precedes implementation commits for the native mailing-list projection.
2. No new migration ships for this slice; existing Organization and Profile tables remain the only storage touched.
3. `GET /api/admin/mailing-lists` answers with the fixture shape, defaults, ordering, and gating above, computed at one instant.
4. The projection is a pure function with injected member and contact inputs, proven by truth tables without a database.
5. Emails originate exclusively from `person_contact_profiles`; the evidence includes the missing-contact case.
6. The SDK requires no change and continues strict decoding.
7. No production import, production data change, credential change, deployment, or external effect occurs.
