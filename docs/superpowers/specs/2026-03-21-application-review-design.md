# Application Review Dashboard — Design Spec

## Goal

Enhance the existing `/dashboard/sokere` page to show computed application status, status-based filter tabs, and an interview assignment action. Establishes the admission review workflow in the new dashboard.

## Scope

- **In:** Application list with computed status display, status filter tabs, "Assign Interview" dialog, delete action
- **Out:** Interview scheduling (time/room/campus — that's a separate feature), bulk operations, pagination

---

## Backend

### Enhance `AdminApplicationListProvider`

The list endpoint already exists but `mapApplication()` does not include the computed application status. Add `ApplicationStatusRule` evaluation to each application in the result.

**Current `mapApplication()` output:** `id`, `userName`, `userEmail`, `interviewStatus`, `interviewScheduled`, `interviewer`, `previousParticipation`

**Add:** `applicationStatus` (int) — the `ApplicationStatus::*` constant value from `ApplicationStatusRule::determine()`

#### Changes to `AdminApplicationListProvider`

1. Inject `ApplicationStatusRule` as constructor dependency.
2. In `mapApplication()`, call `ApplicationStatusRule::determine()` with the application's derived inputs:
   - `isActiveAssistant` — `$app->getUser()->isActiveAssistant()` (checks assistant histories against the active semester)
   - `hasBeenAssistant` — `$app->getPreviousParticipation()` (bool)
   - `hasInterview` — `$interview !== null`
   - `isInterviewed` — `$interview?->getInterviewed() ?? false`
   - `interviewStatus` — `$interview?->getInterviewStatus()`
   - `interviewRoom` — `$interview?->getRoom()`
   - `interviewScheduledFormatted` — `$interview?->getScheduled()?->format('d.m.Y H:i')` — rule-internal only; the API response keeps `interviewScheduled` as ISO 8601, frontend formats for display
3. Include `'applicationStatus' => $status->getStep()` in the returned array.

#### Changes to `AdminApplicationListResource`

No structural change needed — `applications` is already typed as `array`. The individual item array gains the new `applicationStatus` key. Document the shape in a PHPDoc block on the property.

---

## Frontend

### Route: `dashboard.sokere._index.tsx`

Full rewrite of the existing stub.

#### Loader

```typescript
export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { data: null, activeFilter: "all" };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status"); // null means "All" tab — no param sent

  const { data } = await client.GET("/api/admin/applications", {
    params: { query: status ? { status } : {} },
  });

  return { data: data ?? null, activeFilter: status ?? "all" };
}
```

#### Action (Interview Assignment)

```typescript
export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  if (intent === "assign") {
    const applicationId = Number(form.get("applicationId")); // API expects int; Number() coerces string form value
    const interviewerId = Number(form.get("interviewerId"));
    const interviewSchemaId = Number(form.get("interviewSchemaId"));

    const { error } = await client.POST("/api/admin/interviews/assign", {
      body: { applicationId, interviewerId, interviewSchemaId },
    });

    if (error) return { error: "Kunne ikke tildele intervju" };
    return { success: true };
  }

  if (intent === "delete") {
    const applicationId = form.get("applicationId")?.toString(); // path param is string
    const { error } = await client.DELETE("/api/admin/applications/{id}", {
      params: { path: { id: applicationId! } },
    });
    if (error) return { error: "Kunne ikke slette søknad" };
    return { success: true };
  }

  return { error: "Unknown intent" };
}
```

#### Component

**Layout:**
- Status filter tabs (URL search param `?status=`): All | Nye (new) | Tildelt (assigned) | Intervjuet (interviewed) | Eksisterende (existing). The "All" tab omits the `?status` param entirely — the backend returns all applications when no status is provided. Unrecognized status values return `[]`.
- DataTable (existing TanStack Table wrapper). When data is null or the applications array is empty, render an empty table with "Ingen søkere" message.
- "Assign Interview" dialog (shadcn `Dialog`)
- "Delete" confirmation dialog (shadcn `AlertDialog`)

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Navn | `userName` | — |
| E-post | `userEmail` | — |
| Status | `applicationStatus` | Badge with color per status constant |
| Intervjustatus | `interviewStatus` | Text, nullable |
| Intervjuer | `interviewer` | Nullable |
| Tidspunkt | `interviewScheduled` | Locale formatted, nullable |
| Handlinger | — | Action buttons |

**Status badge colors:**

| `applicationStatus` | Label | Color |
|---------------------|-------|-------|
| `CANCELLED` (-1) | Kansellert | Red |
| `APPLICATION_NOT_RECEIVED` (0) | Ikke mottatt | Gray |
| `APPLICATION_RECEIVED` (1) | Søknad mottatt | Blue |
| `INVITED_TO_INTERVIEW` (2) | Invitert | Yellow |
| `INTERVIEW_ACCEPTED` (3) | Tidspunkt godtatt | Orange |
| `INTERVIEW_COMPLETED` (4) | Intervju gjennomført | Green |
| `ASSIGNED_TO_SCHOOL` (5) | Tatt opp | Emerald |

**Action buttons per row:**

| Condition | Available Action |
|-----------|-----------------|
| No interviewer assigned | "Tildel intervju" → opens assign dialog |
| Any application | "Slett" → opens delete confirm dialog |

#### Interview Assignment Dialog

Opens when user clicks "Tildel intervju" for an application row. Two parallel data fetches on dialog open (via `useFetcher` loaders or direct client calls):

1. `GET /api/admin/users` — to populate interviewer dropdown. This endpoint returns a single `AdminUserListResource` object with `activeUsers[]` and `inactiveUsers[]` array properties (not a Hydra collection). Read `data.activeUsers` (not `data["hydra:member"]`) and filter client-side to those with `role` of `ROLE_TEAM_LEADER` or `ROLE_ADMIN`.
2. `GET /api/admin/interview-schemas` — to populate schema dropdown. Returns Hydra collection of `{ id, name, questionCount }`.

Dialog fields:
- Interviewer select: `{firstName} {lastName}` options from active team leaders/admins
- Interview schema select: `{name}` options
- Submit button: "Tildel" → `useFetcher` POST with `intent=assign`, `applicationId`, `interviewerId`, `interviewSchemaId`

On success: dialog closes, loader revalidates automatically (React Router).

#### Fixture Mode

When `isFixtureMode` is true, return mock data shaped as `AdminApplicationListResource` (status `"new"`, applications array with representative entries covering each `applicationStatus` value).

---

## Navigation

The sidebar already links to `/dashboard/sokere` under "Opptak > Nye Søkere". No navigation changes needed.

---

## Application Status Reference

```
ApplicationStatus constants (used as applicationStatus in API response):
  CANCELLED             = -1  (interview cancelled)
  APPLICATION_NOT_RECEIVED = 0  (no application)
  APPLICATION_RECEIVED  = 1   (applied, no interview)
  INVITED_TO_INTERVIEW  = 2   (interview pending)
  INTERVIEW_ACCEPTED    = 3   (interview time confirmed)
  INTERVIEW_COMPLETED   = 4   (interviewed or returning assistant)
  ASSIGNED_TO_SCHOOL    = 5   (active assistant)

Determination logic (ApplicationStatusRule):
  isActiveAssistant → ASSIGNED_TO_SCHOOL
  hasBeenAssistant  → INTERVIEW_COMPLETED
  !hasInterview     → APPLICATION_RECEIVED
  isInterviewed     → INTERVIEW_COMPLETED
  interviewStatus:
    NO_CONTACT(4)         → APPLICATION_RECEIVED
    REQUEST_NEW_TIME(2)   → APPLICATION_RECEIVED
    PENDING(0)            → INVITED_TO_INTERVIEW
    ACCEPTED(1)           → INTERVIEW_ACCEPTED
    CANCELLED(3)          → CANCELLED
    default               → APPLICATION_NOT_RECEIVED
```

---

## Files

### Modified files

| File | Change |
|------|--------|
| `apps/server/src/App/Admission/Api/State/AdminApplicationListProvider.php` | Inject `ApplicationStatusRule`, add `applicationStatus` to `mapApplication()` |
| `apps/dashboard/app/routes/dashboard.sokere._index.tsx` | Full rewrite: loader + action + table + filter tabs + assignment dialog |
| `packages/sdk/openapi.json` | Regenerated after backend change |
| `packages/sdk/generated/api.d.ts` | Regenerated |

### No new files required

The `ApplicationStatusRule` already exists. `AdminApplicationListResource.applications` is already untyped `array`. No new PHP files needed for this feature.

---

## SDK Regeneration

After backend change:
1. `cd apps/server && php bin/console api:openapi:export --output=../../packages/sdk/openapi.json`
2. `cd packages/sdk && bun run generate`

The `applicationStatus` field will appear as `number` in the generated types.

---

## Testing

### Backend

- Unit test for `AdminApplicationListProvider`: each application item includes `applicationStatus` key
- Unit test: `applicationStatus` is `APPLICATION_RECEIVED` (1) when application has no interview
- Unit test: `applicationStatus` is `INVITED_TO_INTERVIEW` (2) when interview status is `PENDING`
- Unit test: `applicationStatus` is `ASSIGNED_TO_SCHOOL` (5) when user `isActiveAssistant()`
- Existing `ApplicationStatusRule` unit tests cover the rule logic itself — no duplication needed

### Frontend

- Loader returns data from `GET /api/admin/applications` with `?status` forwarded
- Status filter tab change updates URL search param and triggers loader revalidation
- Status badges render correct label and color for each `applicationStatus` value
- "Tildel intervju" button absent when interviewer already assigned
- Assignment dialog submits correct form fields via `useFetcher`
- Delete confirmation dialog appears before submitting delete action

---

## Sequence Diagram

```
User opens /dashboard/sokere
  → loader() calls GET /api/admin/applications (no ?status param → returns all; or ?status=new for filtered tab)
  → AdminApplicationListProvider evaluates ApplicationStatusRule per application
  → Returns { status, applications: [..., applicationStatus: int] }
  → Table renders with status badges and action buttons

User clicks "Tildel intervju" on unassigned application
  → Dialog opens
  → GET /api/admin/users → filter activeUsers to ROLE_TEAM_LEADER+
  → GET /api/admin/interview-schemas → populate schema select
  → User picks interviewer + schema, clicks "Tildel"
  → useFetcher POST /api/admin/interviews/assign { applicationId, interviewerId, interviewSchemaId }
  → InterviewAssignProcessor creates Interview entity, links to application
  → Dialog closes, React Router revalidates loader
  → Row now shows interviewer name, "Tildel intervju" button disappears
```
