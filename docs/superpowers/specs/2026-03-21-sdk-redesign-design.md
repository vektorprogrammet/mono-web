# SDK Redesign — Design Spec

## Goal

Replace the openapi-fetch SDK with a domain-first typed client. Effect internals, plain promise surface, Symfony adapter. The interface speaks Vektorprogrammet's domain language — admission, recruitment, accounting, team management — not HTTP verbs or PHP endpoint paths.

## Problem

The current SDK wraps `openapi-fetch` with types generated from the Symfony OpenAPI spec:
- `paths` interface generates as empty — all path types resolve to `never`
- Every call requires `as any` casts, defeating type safety
- Hydra envelopes (`hydra:member`) leak into consumers
- PHP integer status constants leak into consumers (`applicationStatus: 2` instead of `"invited"`)
- No runtime validation — responses are cast, not verified
- React/TanStack Query dependencies baked into a transport library

## Consumer API

Two entrypoints from the same codebase. The Effect SDK is the real implementation; the Promise SDK wraps each method with `Effect.runPromise`.

### Default — plain promises

```typescript
import { createClient } from "@vektorprogrammet/sdk"

const sdk = createClient("https://api.example.com", token?)

const page = await sdk.receipts.list({ status: "pending" })
// page: Page<Receipt> — inferred from createClient return type
```

### Effect-native — for consumers who want Effect composition

```typescript
import { createEffectClient } from "@vektorprogrammet/sdk/effect"

const sdk = createEffectClient("https://api.example.com", token?)

const page = yield* sdk.receipts.list({ status: "pending" })
// Effect<Page<Receipt>, SdkError, never> — inferred
```

The Effect SDK returns `Effect<T, SdkError>`. The Promise SDK wraps with `Effect.runPromise`. Both share the same domain methods, schemas, adapter, and context. The only difference is the boundary.

```json
// package.json exports
{
  "exports": {
    ".": "./dist/promise.js",
    "./effect": "./dist/effect.js"
  }
}
```

### Client Context

Decoded from the JWT at creation time. No server call. Used by the UI for conditional rendering (show/hide buttons, route guards), not for security — the server enforces all access rules.

```typescript
sdk.context.isAuthenticated    // boolean
sdk.context.role               // "user" | "team_member" | "team_leader" | "admin" | null
sdk.context.department         // { id: number, name: string } | null
sdk.context.teams              // { id: number, name: string }[]
sdk.context.userId             // number | null

// UI usage — not security, just convenience
sdk.context.hasRole("team_leader")          // boolean — true if role >= team_leader
sdk.context.isInDepartment(departmentId)    // boolean
```

When `token` is omitted (public/unauthenticated SDK), `context.isAuthenticated` is false and all role/department fields are null. Public endpoints (`sdk.public.*`) still work.

### Authentication

```typescript
sdk.auth.login(username, password)   → Promise<{ token: string }>
sdk.auth.resetPassword(email)        → Promise<void>
sdk.auth.setPassword(code, password) → Promise<void>
```

### Current User

```typescript
sdk.me.profile()              → Promise<UserProfile>
sdk.me.dashboard()            → Promise<DashboardStats>
sdk.me.updateProfile(data)    → Promise<void>
```

### User Receipts

```typescript
sdk.receipts.list(params?)            → Promise<Page<Receipt>>
sdk.receipts.create(input, file?)     → Promise<{ id: number }>
sdk.receipts.update(id, input, file?) → Promise<void>
sdk.receipts.delete(id)               → Promise<void>
```

### Admin Receipts

```typescript
sdk.admin.receipts.list(params?)  → Promise<Page<AdminReceipt>>
sdk.admin.receipts.approve(id)    → Promise<SdkResult<void>>
sdk.admin.receipts.reject(id)     → Promise<SdkResult<void>>
sdk.admin.receipts.reopen(id)     → Promise<SdkResult<void>>
```

`approve/reject/reopen` are domain operations, not `updateStatus("refunded")`. The SDK speaks the domain language.

### Applications

```typescript
sdk.admin.applications.list(params?)       → Promise<Page<Application>>
sdk.admin.applications.get(id)             → Promise<ApplicationDetail>
sdk.admin.applications.delete(id)          → Promise<void>
sdk.admin.applications.bulkDelete(ids)     → Promise<void>
```

### Interviews

```typescript
sdk.admin.interviews.list(params?)                               → Promise<Page<Interview>>
sdk.admin.interviews.assign(applicationId, interviewerId, schemaId) → Promise<void>
sdk.admin.interviews.schedule(id, input)                         → Promise<void>
sdk.admin.interviews.conduct(id, score, answers)                 → Promise<void>
sdk.admin.interviews.cancel(id)                                  → Promise<SdkResult<void>>
sdk.admin.interviews.schemas()                                   → Promise<InterviewSchema[]>
```

### Users

```typescript
sdk.admin.users.list() → Promise<{ active: User[], inactive: User[] }>
```

### Scheduling

```typescript
sdk.admin.scheduling.assistants(params?) → Promise<Page<Assistant>>
sdk.admin.scheduling.schools(params?)    → Promise<Page<School>>
sdk.admin.scheduling.substitutes(params?) → Promise<Page<Substitute>>
```

### Teams

```typescript
sdk.admin.teams.list()      → Promise<Team[]>
sdk.admin.teams.interest()  → Promise<Page<TeamInterest>>
```

### Other

```typescript
sdk.admin.mailingLists()    → Promise<MailingList[]>
sdk.admin.admissionStats()  → Promise<AdmissionStats>
sdk.public.departments()    → Promise<Department[]>
sdk.public.fieldOfStudies() → Promise<FieldOfStudy[]>
sdk.public.sponsors()       → Promise<Sponsor[]>
sdk.public.teams()          → Promise<Team[]>
```

## Domain Types

**Single source of truth: Effect Schema classes.** Public types are inferred via `Schema.Schema.Type`, not hand-written interfaces. Consumers import plain TypeScript types — they never see Schema internals.

```typescript
// Internal: Schema.Class defines shape + validation + transform + methods
class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.Date,
  submitDate: Schema.Date,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.Date),
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

// Public: inferred from Schema, re-exported from index.ts
export type Receipt = Schema.Schema.Type<typeof Receipt>
// Consumers see: { id: number, visualId: string, ..., isPending: boolean, formattedAmount: string }
```

Schema classes provide:
- **Runtime validation** — adapter decodes API responses through Schema, catching malformed data
- **Transform pipeline** — `Schema.transform` composes HTTP JSON → domain object (date strings → Date, integers → enums)
- **Methods on instances** — `receipt.isPending`, `receipt.formattedAmount`, `application.statusLabel`
- **Property-based testing** — `Arbitrary.make(Receipt)` generates valid test data from the schema constraints
- **Single definition** — no type/interface duplication, schema IS the type

### Receipt

```typescript
// Schema (internal)
class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number.pipe(Schema.positive()),
  receiptDate: Schema.Date,
  submitDate: Schema.Date,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.Date),
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

class AdminReceipt extends Schema.Class<AdminReceipt>("AdminReceipt")({
  ...Receipt.fields,
  userName: Schema.String,
}) {}

class ReceiptInput extends Schema.Class<ReceiptInput>("ReceiptInput")({
  description: Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(5000)),
  sum: Schema.Number.pipe(Schema.positive()),
  receiptDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
}) {}

// Consumer sees (via re-export):
// type Receipt = { id: number, visualId: string, description: string, sum: number,
//   receiptDate: Date, submitDate: Date, status: "pending" | "refunded" | "rejected",
//   refundDate: Date | null, isPending: boolean, formattedAmount: string }
```

### Application

```typescript
const ApplicationStatus = Schema.Literal(
  "not_received", "received", "invited", "accepted",
  "completed", "assigned", "cancelled"
)

class Application extends Schema.Class<Application>("Application")({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  status: ApplicationStatus,             // derived in adapter, never an integer
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.Date),
  previousParticipation: Schema.Boolean,
}) {
  get statusLabel(): string {
    return Match.value(this.status).pipe(
      Match.when("not_received", () => "Ikke mottatt"),
      Match.when("received", () => "Mottatt"),
      Match.when("invited", () => "Invitert"),
      Match.when("accepted", () => "Akseptert"),
      Match.when("completed", () => "Fullført"),
      Match.when("assigned", () => "Tildelt skole"),
      Match.when("cancelled", () => "Avbrutt"),
      Match.exhaustive,
    )
  }
}
// Consumer sees: { ..., status: ApplicationStatus, statusLabel: string }
```

Status derivation (adapter responsibility, matching `ApplicationManager::getApplicationStatus()`):
```
status(app) =
  | "assigned"     if app.user.isActiveAssistant()
  | "completed"    if app.user.hasBeenAssistant() OR app.interview?.interviewed
  | match interview.interviewStatus:
      ACCEPTED(1)         → "accepted"
      CANCELLED(3)        → "cancelled"
      PENDING(0)          → "invited"
      NO_CONTACT(4)       → "received"
      REQUEST_NEW_TIME(2) → "received"
  | "received"     if app.admissionPeriod != null
  | "not_received" otherwise
```

### Interview

```typescript
const InterviewSchedulingStatus = Schema.Literal(
  "no_contact", "pending", "accepted", "request_new_time", "cancelled"
)

class Interview extends Schema.Class<Interview>("Interview")({
  id: Schema.Number,
  schedulingStatus: InterviewSchedulingStatus,
  interviewed: Schema.Boolean,
  scheduled: Schema.NullOr(Schema.Date),
  conducted: Schema.NullOr(Schema.Date),
  interviewer: Schema.NullOr(Schema.String),
  applicationId: Schema.Number,
}) {}

class InterviewSchema_ extends Schema.Class<InterviewSchema_>("InterviewSchema")({
  id: Schema.Number,
  name: Schema.String,
}) {}  // Interview questionnaire template (not a JSON schema)

class InterviewScheduleInput extends Schema.Class<InterviewScheduleInput>("InterviewScheduleInput")({
  datetime: Schema.Date,
  room: Schema.NullOr(Schema.String),
  interviewerId: Schema.Number,
}) {}

interface InterviewScore {
  explanatoryPower: number
  roleModel: number
  suitability: number
  suitableAssistant: number
}
```

### User

```typescript
interface User {
  id: number
  firstName: string
  lastName: string
  email: string
  role: string
}

interface UserProfile {
  id: number
  firstName: string
  lastName: string
  email: string
  phone: string | null
  department: string
  fieldOfStudy: string | null
}
```

### Dashboard

```typescript
interface DashboardStats {
  // shape TBD — mirrors /api/me/dashboard response
}
```

### Other

```typescript
interface Department {
  id: number
  name: string
  city: string
}

interface Team {
  id: number
  name: string
}

interface TeamInterest {
  id: number
  userName: string
  teamName: string
}

interface FieldOfStudy {
  id: number
  name: string
}

interface Sponsor {
  id: number
  name: string
  logoUrl: string | null
  url: string | null
}

interface MailingList {
  name: string
  emails: string[]
}

interface AdmissionStats {
  // shape TBD — mirrors /api/admin/admission-stats response
}

interface Page<T> {
  items: T[]
  totalItems: number
}
```

## Error Model

```typescript
// Mutations that can fail with domain-specific errors return SdkResult<T>
type SdkResult<T> = { ok: true; data: T } | { ok: false; error: SdkError }

type SdkError =
  | { type: "unauthorized" }
  | { type: "not_found" }
  | { type: "validation"; fields: Record<string, string> }
  | { type: "conflict"; message: string }
  | { type: "network"; cause: unknown }
```

Methods that return `Promise<T>` (not `SdkResult`) throw on unexpected errors (network, unauthorized). This is the same contract as `fetch` — callers can try/catch if needed.

Methods that return `Promise<SdkResult<T>>` have known failure modes. `sdk.admin.receipts.approve(id)` can fail with `"not_found"` (receipt deleted) or `"conflict"` (already refunded). These are not exceptional — they're expected outcomes the UI must handle.

## Internal Architecture

Brief — implementation, not the contract.

### Effect pipeline

All domain methods are `Effect.gen` pipelines internally. The public surface wraps them with `Effect.runPromise`, converting Effect types to plain promises. Consumers never import from `effect`.

```
Consumer calls sdk.admin.receipts.approve(id)
  → runs Effect.gen pipeline
    → HttpClient request via @effect/platform
    → Schema.decode response
    → Schema.TaggedError on failure
  → Effect.runPromise at boundary
  → returns Promise<SdkResult<void>>
```

### Schema internals

Domain models are `Schema.Class` with `Schema.transform` from API response shapes. This is where Hydra unwrap, status derivation, date parsing, and IRI resolution happen. None of this is exposed.

### Dependency injection

`HttpClient` from `@effect/platform` is provided via `Layer`. Auth token is injected at `createClient` time by wrapping the base `HttpClient` with an auth header. This makes the SDK testable — swap `HttpClient` for a mock and test domain logic in isolation.

## Adapter Layer

The Symfony adapter is the only layer that changes when `@monoweb/api` replaces Symfony. It handles:

| Concern | Symfony adapter | Future TS adapter |
|---------|----------------|-------------------|
| Collections | `hydra:member` → `Page<T>` | Direct `Page<T>` |
| Application status | Integer (0-5, -1) → string enum | Direct string enum |
| Interview status | Integer (0-4) → string enum | Direct string enum |
| Dates | ISO string → `Date` | ISO string → `Date` |
| IRI references | `/api/users/42` → `42` | Direct ID |
| Errors | API Platform violation list → `SdkError` | Direct error shape |
| Receipt photo | `/uploads/receipts/abc.jpg` → full URL | Direct URL |

### Status derivation

Application status integers map as:
```
0 (APPLICATION_NOT_RECEIVED) → "not_received"
1 (APPLICATION_RECEIVED)     → "received"
2 (INVITED_TO_INTERVIEW)     → "invited"
3 (INTERVIEW_ACCEPTED)       → "accepted"
4 (INTERVIEW_COMPLETED)      → "completed"
5 (ASSIGNED_TO_SCHOOL)       → "assigned"
-1 (CANCELLED)               → "cancelled"
```

Interview scheduling status integers map as:
```
0 (PENDING)          → "pending"
1 (ACCEPTED)         → "accepted"
2 (REQUEST_NEW_TIME) → "request_new_time"
3 (CANCELLED)        → "cancelled"
4 (NO_CONTACT)       → "no_contact"
```

These transforms live in `Schema.transform` — the adapter decodes the raw API response directly into the domain type.

## Files

```
packages/sdk/src/
  index.ts              — Public exports: createClient, types, SdkResult, SdkError
  sdk.ts                — createClient factory, Sdk type, Effect.runPromise boundary
  config.ts             — apiUrl, isFixtureMode (unchanged)
  errors.ts             — Schema.TaggedError internals, SdkError mapping
  transport.ts          — Effect HttpClient wrapper: auth, request helpers
  adapter/
    hydra.ts            — Hydra collection → Page<T> transform
    status.ts           — Integer → string enum transforms (application, interview)
    dates.ts            — ISO string → Date parsing
    iri.ts              — IRI reference → ID extraction
    errors.ts           — API Platform error format → SdkError
  schemas/
    common.ts           — Page<T>, shared primitives
    receipt.ts          — Receipt, AdminReceipt, ReceiptInput
    application.ts      — Application, ApplicationStatus, ApplicationDetail
    interview.ts        — Interview, InterviewSchema, InterviewScore
    user.ts             — User, UserProfile, LoginResponse
    dashboard.ts        — DashboardStats
    department.ts       — Department, Team, Sponsor, FieldOfStudy, etc.
  domains/
    auth.ts             — login, resetPassword, setPassword
    me.ts               — profile, dashboard, updateProfile
    receipts.ts         — user receipt CRUD
    public.ts           — departments, fieldOfStudies, sponsors, teams
    admin/
      receipts.ts       — admin receipt list, approve, reject, reopen
      applications.ts   — application list, get, delete, bulkDelete
      interviews.ts     — interview list, assign, schedule, conduct, cancel, schemas
      users.ts          — user list (active/inactive split)
      scheduling.ts     — assistants, schools, substitutes
      teams.ts          — team list, team interest
      misc.ts           — mailing lists, admission stats
```

## Consumer Migration

### Login route

**Before:**
```typescript
// apps/dashboard/app/routes/login.tsx
import { createClient, apiUrl } from "@vektorprogrammet/sdk"

const client = createClient(apiUrl)
const { data, error, response } = await client.POST("/api/login", {
  body: { username, password },
})

if (error || !data?.token) {
  if (response?.status === 429) {
    return { error: "For mange innloggingsforsøk. Prøv igjen om 15 minutter." }
  }
  return { error: "Feil brukernavn eller passord" }
}

return redirect("/dashboard", {
  headers: { "Set-Cookie": createAuthCookie(data.token) },
})
```

**After:**
```typescript
import { createClient } from "@vektorprogrammet/sdk"

const sdk = createClient(apiUrl)
try {
  const { token } = await sdk.auth.login(username, password)
  return redirect("/dashboard", {
    headers: { "Set-Cookie": createAuthCookie(token) },
  })
} catch (e) {
  // SdkError with type discrimination
  return { error: "Feil brukernavn eller passord" }
}
```

### Receipts route

**Before:**
```typescript
// apps/dashboard/app/routes/dashboard.utlegg._index.tsx
const client = createAuthenticatedClient(token)
const { data } = await client.GET("/api/admin/receipts" as any, {
  params: { query: status ? { status } : {} },
})
const receipts = ((data as any)?.["hydra:member"] as Receipt[]) ?? []

// Action: status change via raw PUT
await client.PUT("/api/admin/receipts/{id}/status" as any, {
  params: { path: { id: receiptId } },
  body: { status: newStatus },
})
```

**After:**
```typescript
import { createClient } from "@vektorprogrammet/sdk"

const sdk = createClient(apiUrl, token)
const { items: receipts } = await sdk.admin.receipts.list({ status })

// Action: domain operations
const result = await sdk.admin.receipts.approve(receiptId)
if (!result.ok) {
  return { error: result.error.type }  // "not_found" | "conflict"
}
```

### Applications route

**Before:**
```typescript
// apps/dashboard/app/routes/dashboard.sokere._index.tsx
type Application = {
  applicationStatus: number  // PHP integer constant
  // ...
}

const { data } = await client.GET("/api/admin/applications" as any, { ... })
// Consumer must map integer → label:
const applicationStatusMeta: Record<number, { label: string }> = {
  [-1]: { label: "Avbrutt" },
  [0]: { label: "Ikke mottatt" },
  [1]: { label: "Mottatt" },
  // ...
}

// Action: interview assignment via raw POST
await client.POST("/api/admin/interviews/assign" as any, {
  body: { applicationId, interviewerId, interviewSchemaId },
})
```

**After:**
```typescript
import { createClient, type Application } from "@vektorprogrammet/sdk"

const sdk = createClient(apiUrl, token)
const { items: applications } = await sdk.admin.applications.list({ status })
// application.status is "received" | "invited" | ... — no integer mapping needed

// Action: domain operation
await sdk.admin.interviews.assign(applicationId, interviewerId, schemaId)
```

## Dependencies

### Add
- `effect`
- `@effect/platform`

### Remove
- `openapi-fetch`
- `openapi-react-query`
- `openapi-typescript` (devDep)
- `@tanstack/react-query` (peer)
- `react` (peer)

### Remove files
| File | Reason |
|------|--------|
| `generated/api.d.ts` | Types now Schema classes in `schemas/` |
| `openapi.json` | Moves to `apps/server/` (server concern) |
| `src/query.ts` | React Query is consumer concern |
| `src/provider.tsx` | React Query is consumer concern |

## Testing

### Unit tests — adapter transforms

Mock `HttpClient` via Layer, verify each adapter transform in isolation:

- Hydra envelope → `Page<T>`
- Integer status → string enum (all application statuses, all interview statuses)
- ISO date string → `Date` object
- IRI reference → numeric ID
- API Platform violation list → `SdkError`

### Property tests — Schema round-trips

Every Schema class round-trips through encode/decode using `@effect/schema` Arbitrary:

```typescript
it.prop("Receipt round-trips", [Arbitrary.make(Receipt)], (receipt) => {
  const encoded = Schema.encodeSync(Receipt)(receipt)
  const decoded = Schema.decodeUnknownSync(Receipt)(encoded)
  expect(decoded).toEqual(receipt)
})
```

### Integration — dashboard e2e

Existing dashboard routes serve as integration tests. Migrate one route, verify it works against the Symfony backend, then proceed.

### Status derivation tests

Dedicated test suite for `deriveApplicationStatus` — the most complex adapter logic. Test cases from the contract:

| Input | Expected |
|-------|----------|
| `isActiveAssistant = true, interview.cancelled` | `"assigned"` (assistant overrides) |
| `hasBeenAssistant = true` | `"completed"` |
| `interview.status = ACCEPTED(1)` | `"accepted"` |
| `interview.status = CANCELLED(3)` | `"cancelled"` |
| `interview.status = PENDING(0)` | `"invited"` |
| `interview.status = NO_CONTACT(4)` | `"received"` |
| `interview = null, admissionPeriod != null` | `"received"` |
| `interview = null, admissionPeriod = null` | `"not_received"` |
