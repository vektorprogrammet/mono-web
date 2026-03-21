# SDK Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace openapi-fetch SDK with domain-first Effect-TS client. Plain promise surface, Symfony adapter.

**Architecture:** Schema classes → Effect internals → adapter transforms → plain promise boundary. Dual export: default promises, /effect for Effect-native.

**Tech Stack:** Effect, @effect/platform, Schema, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-21-sdk-redesign-design.md`

---

## Phase 1: Foundation (no domain logic yet)

### Task 1: Setup — dependencies, tsconfig, package.json exports

**Files:**
- Modify: `packages/sdk/package.json`
- Modify: `packages/sdk/tsconfig.json`

**Context:** The current SDK depends on `openapi-fetch`, `openapi-react-query`, `@tanstack/react-query` (peer), and `react` (peer). We replace all of these with `effect` and `@effect/platform`. The package exports change from a single `"."` entrypoint to two: `"."` (promise surface) and `"./effect"` (Effect-native). The `config.ts` file stays unchanged — it provides `apiUrl` and `isFixtureMode`.

- [ ] **Step 1: Install new dependencies**

```bash
cd packages/sdk && bun add effect @effect/platform
```

- [ ] **Step 2: Remove old dependencies**

```bash
cd packages/sdk && bun remove openapi-fetch openapi-react-query openapi-typescript @tanstack/react-query react @types/react
```

Note: `openapi-typescript` is a devDep. `@tanstack/react-query` and `react` are peerDeps. `@types/react` is a devDep. Remove all of them.

- [ ] **Step 3: Update `packages/sdk/package.json`**

The exports field must change to serve two entrypoints. Remove the `generate` script (no more openapi-typescript). Remove `"files": ["dist", "generated"]` — generated types are gone, only `dist` is published.

```json
{
  "name": "@vektorprogrammet/sdk",
  "version": "0.2.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/promise.d.ts",
      "default": "./dist/promise.js"
    },
    "./effect": {
      "types": "./dist/effect-client.d.ts",
      "default": "./dist/effect-client.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "lint": "oxlint",
    "test": "vitest run",
    "release": "changeset publish"
  },
  "dependencies": {
    "effect": "^3",
    "@effect/platform": "^0.76"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@effect/vitest": "^0.18",
    "vitest": "^3",
    "typescript": "^5"
  }
}
```

**Important:** Check actual latest versions of `effect`, `@effect/platform`, and `@effect/vitest` before installing. The version numbers above are approximate — use whatever `bun add` installs.

- [ ] **Step 4: Update `packages/sdk/tsconfig.json`**

Remove `"jsx": "react-jsx"` (no React). Remove `"generated"` from include (no more generated types). Add `"strict": true` for Schema to work properly.

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Verify it compiles (empty build)**

Run: `cd packages/sdk && bun run build`
Expected: Succeeds (compiles existing `config.ts` and a stub `index.ts`). Errors from old imports are expected — we'll fix those in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/package.json packages/sdk/tsconfig.json packages/sdk/bun.lockb
git commit -m "chore(sdk): replace openapi-fetch deps with effect + @effect/platform"
```

---

### Task 2: Error hierarchy

**Files:**
- Create: `packages/sdk/src/errors.ts`

**Context:** The public error surface is a class hierarchy rooted at `SdkError`. Consumers use `instanceof` checks and the `.type` discriminant. Internally, each maps to a `Schema.TaggedError` for Effect's typed error channel. The `toSdkError()` function at the Effect→Promise boundary maps internal errors to public ones.

- [ ] **Step 1: Create `packages/sdk/src/errors.ts`**

```typescript
/**
 * Public error hierarchy for the SDK.
 * Consumers use instanceof checks and the .type discriminant.
 *
 * Internally, Effect TaggedErrors are mapped to these at the runPromise boundary.
 */

import { Schema } from "effect"

// --- Public error classes (exported to consumers) ---

export type SdkErrorType =
  | "unauthorized"
  | "not_found"
  | "validation"
  | "conflict"
  | "network"
  | "rate_limited"

export class SdkError extends Error {
  readonly type: SdkErrorType

  constructor(type: SdkErrorType, message: string, options?: ErrorOptions) {
    super(message, options)
    this.type = type
    this.name = "SdkError"
  }
}

export class UnauthorizedError extends SdkError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message)
    this.name = "UnauthorizedError"
  }
}

export class NotFoundError extends SdkError {
  constructor(message = "Not found") {
    super("not_found", message)
    this.name = "NotFoundError"
  }
}

export class ValidationError extends SdkError {
  readonly fields: Record<string, string>

  constructor(message = "Validation failed", fields: Record<string, string> = {}) {
    super("validation", message)
    this.name = "ValidationError"
    this.fields = fields
  }
}

export class ConflictError extends SdkError {
  constructor(message = "Conflict") {
    super("conflict", message)
    this.name = "ConflictError"
  }
}

export class NetworkError extends SdkError {
  override readonly cause: unknown

  constructor(message = "Network error", cause?: unknown) {
    super("network", message, { cause })
    this.name = "NetworkError"
    this.cause = cause
  }
}

export class RateLimitedError extends SdkError {
  constructor(message = "Rate limited") {
    super("rate_limited", message)
    this.name = "RateLimitedError"
  }
}

// --- Internal Effect TaggedErrors ---

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
) {}

export class Validation extends Schema.TaggedError<Validation>()(
  "Validation",
  {
    message: Schema.String,
    fields: Schema.Record({ key: Schema.String, value: Schema.String }),
  },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
) {}

export class Network extends Schema.TaggedError<Network>()(
  "Network",
  { message: Schema.String },
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { message: Schema.String },
) {}

export type InternalSdkError =
  | Unauthorized
  | NotFound
  | Validation
  | Conflict
  | Network
  | RateLimited

/**
 * Maps an internal Effect TaggedError to a public SdkError subclass.
 * Used at the Effect.runPromise boundary.
 */
export function toSdkError(error: InternalSdkError): SdkError {
  switch (error._tag) {
    case "Unauthorized":
      return new UnauthorizedError(error.message)
    case "NotFound":
      return new NotFoundError(error.message)
    case "Validation":
      return new ValidationError(error.message, error.fields as Record<string, string>)
    case "Conflict":
      return new ConflictError(error.message)
    case "Network":
      return new NetworkError(error.message)
    case "RateLimited":
      return new RateLimitedError(error.message)
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`
Expected: No errors from this file.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/errors.ts
git commit -m "feat(sdk): add SdkError class hierarchy and Effect TaggedError internals"
```

---

### Task 3: Transport — Effect HttpClient wrapper

**Files:**
- Create: `packages/sdk/src/transport.ts`

**Context:** This wraps `@effect/platform`'s `HttpClient` with auth resolution and request helpers. The auth option is `string | (() => string | Promise<string>) | undefined`. Every request helper returns `Effect<T, InternalSdkError>` — the caller supplies a Schema to decode the response. HTTP status codes map to typed errors: 401→Unauthorized, 404→NotFound, 409→Conflict, 422→Validation, 429→RateLimited, network failures→Network.

- [ ] **Step 1: Create `packages/sdk/src/transport.ts`**

```typescript
/**
 * Transport layer — wraps @effect/platform HttpClient with auth and error mapping.
 *
 * All request helpers return Effect<A, InternalSdkError> where A is decoded via Schema.
 * The caller provides the Schema; the transport handles HTTP, auth, and error mapping.
 */

import { Effect, Layer, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpClientError } from "@effect/platform"
import {
  Unauthorized, NotFound, Validation, Conflict, Network, RateLimited,
  type InternalSdkError,
} from "./errors.js"

export type AuthOption = string | (() => string | Promise<string>)

/**
 * Resolves the auth token — supports static string or async function.
 */
const resolveAuth = (auth: AuthOption): Effect.Effect<string> =>
  typeof auth === "string"
    ? Effect.succeed(auth)
    : Effect.promise(async () => {
        const result = auth()
        return result instanceof Promise ? result : result
      })

/**
 * Maps HTTP status codes and network errors to InternalSdkError.
 */
const mapHttpError = (error: HttpClientError.HttpClientError): InternalSdkError => {
  if (error._tag === "ResponseError") {
    const status = error.response.status
    if (status === 401 || status === 403) return new Unauthorized({ message: `HTTP ${status}` })
    if (status === 404) return new NotFound({ message: "Not found" })
    if (status === 409) return new Conflict({ message: "Conflict" })
    if (status === 422) return new Validation({ message: "Validation failed", fields: {} })
    if (status === 429) return new RateLimited({ message: "Rate limited" })
    return new Network({ message: `HTTP ${status}` })
  }
  return new Network({ message: error.message })
}

export interface Transport {
  get<A, I>(url: string, schema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>): Effect.Effect<A, InternalSdkError>
  getCollection<A, I>(url: string, itemSchema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>): Effect.Effect<{ items: A[], totalItems: number }, InternalSdkError>
  post<A, I>(url: string, body: unknown, schema: Schema.Schema<A, I>): Effect.Effect<A, InternalSdkError>
  postVoid(url: string, body: unknown): Effect.Effect<void, InternalSdkError>
  put(url: string, body: unknown): Effect.Effect<void, InternalSdkError>
  del(url: string): Effect.Effect<void, InternalSdkError>
  postFormData<A, I>(url: string, formData: FormData, schema: Schema.Schema<A, I>): Effect.Effect<A, InternalSdkError>
  postFormDataVoid(url: string, formData: FormData): Effect.Effect<void, InternalSdkError>
}

/**
 * Creates a Transport backed by @effect/platform HttpClient.
 *
 * Auth is injected into every request as a Bearer token header.
 * Responses are decoded through the provided Schema.
 * HTTP errors are mapped to InternalSdkError.
 */
export function createTransport(baseUrl: string, auth?: AuthOption): Transport {
  const withAuth = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientRequest.HttpClientRequest> => {
    if (!auth) return Effect.succeed(request)
    return pipe(
      resolveAuth(auth),
      Effect.map((token) =>
        HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`),
      ),
    )
  }

  const buildUrl = (path: string, params?: Record<string, string | number | undefined>): string => {
    const url = new URL(path, baseUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  const executeJson = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<unknown, InternalSdkError> =>
    pipe(
      withAuth(request),
      Effect.flatMap((req) =>
        pipe(
          HttpClient.fetchOk(req),
          Effect.flatMap(HttpClientResponse.json),
          Effect.catchTag("ResponseError", (e) => Effect.fail(mapHttpError(e))),
          Effect.catchTag("RequestError", (e) => Effect.fail(mapHttpError(e))),
        ),
      ),
    )

  const executeVoid = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<void, InternalSdkError> =>
    pipe(
      withAuth(request),
      Effect.flatMap((req) =>
        pipe(
          HttpClient.fetchOk(req),
          Effect.asVoid,
          Effect.catchTag("ResponseError", (e) => Effect.fail(mapHttpError(e))),
          Effect.catchTag("RequestError", (e) => Effect.fail(mapHttpError(e))),
        ),
      ),
    )

  return {
    get<A, I>(url: string, schema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      return pipe(
        executeJson(HttpClientRequest.get(buildUrl(url, params))),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    getCollection<A, I>(url: string, itemSchema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      // Hydra collections: { "hydra:member": [...], "hydra:totalItems": N }
      return pipe(
        executeJson(HttpClientRequest.get(buildUrl(url, params))),
        Effect.flatMap((json: any) => {
          const members: unknown[] = json?.["hydra:member"] ?? []
          const totalItems: number = json?.["hydra:totalItems"] ?? 0
          return pipe(
            Effect.forEach(members, (item) =>
              Schema.decodeUnknown(itemSchema)(item).pipe(
                Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
              ),
            ),
            Effect.map((items) => ({ items, totalItems })),
          )
        }),
      )
    },

    post<A, I>(url: string, body: unknown, schema: Schema.Schema<A, I>) {
      return pipe(
        executeJson(
          HttpClientRequest.post(buildUrl(url)).pipe(
            HttpClientRequest.jsonBody(body),
          ) as HttpClientRequest.HttpClientRequest,
        ),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    postVoid(url: string, body: unknown) {
      return executeVoid(
        HttpClientRequest.post(buildUrl(url)).pipe(
          HttpClientRequest.jsonBody(body),
        ) as HttpClientRequest.HttpClientRequest,
      )
    },

    put(url: string, body: unknown) {
      return executeVoid(
        HttpClientRequest.put(buildUrl(url)).pipe(
          HttpClientRequest.jsonBody(body),
        ) as HttpClientRequest.HttpClientRequest,
      )
    },

    del(url: string) {
      return executeVoid(HttpClientRequest.del(buildUrl(url)))
    },

    postFormData<A, I>(url: string, formData: FormData, schema: Schema.Schema<A, I>) {
      return pipe(
        executeJson(
          HttpClientRequest.post(buildUrl(url)).pipe(
            HttpClientRequest.formDataBody(formData),
          ),
        ),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    postFormDataVoid(url: string, formData: FormData) {
      return executeVoid(
        HttpClientRequest.post(buildUrl(url)).pipe(
          HttpClientRequest.formDataBody(formData),
        ),
      )
    },
  }
}
```

**Important:** The exact `@effect/platform` API may differ from what's shown here. Before implementing, check the actual API:
- `HttpClient.fetchOk` may be `HttpClient.execute` or similar
- `HttpClientRequest.setHeader` may use a different signature
- `HttpClientRequest.jsonBody` may return an Effect, not a plain request
- `HttpClientResponse.json` parses the body as JSON

Verify against the actual `@effect/platform` docs (use context7 or web search). The transport's contract (the `Transport` interface) is stable — the implementation may need adjustment.

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`
Expected: No errors from this file (or minor API mismatches to fix).

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/transport.ts
git commit -m "feat(sdk): add Effect-based transport layer with auth and error mapping"
```

---

### Task 4: Adapter utilities

**Files:**
- Create: `packages/sdk/src/adapter/status.ts`
- Create: `packages/sdk/src/adapter/dates.ts`
- Create: `packages/sdk/src/adapter/iri.ts`
- Create: `packages/sdk/src/adapter/errors.ts`

**Context:** These are pure transform functions used inside Schema.transform pipelines. They convert Symfony-specific response shapes to domain types. Each is a small, focused module.

- [ ] **Step 1: Create `packages/sdk/src/adapter/status.ts`**

Application and interview status integer→string mappings, as specified in the design spec.

```typescript
/**
 * Status integer → string enum transforms for Symfony API responses.
 */

const APPLICATION_STATUS_MAP: Record<number, string> = {
  0: "not_received",
  1: "received",
  2: "invited",
  3: "accepted",
  4: "completed",
  5: "assigned",
  [-1]: "cancelled",
}

const INTERVIEW_STATUS_MAP: Record<number, string> = {
  0: "pending",
  1: "accepted",
  2: "request_new_time",
  3: "cancelled",
  4: "no_contact",
}

export type ApplicationStatus =
  | "not_received" | "received" | "invited" | "accepted"
  | "completed" | "assigned" | "cancelled"

export type InterviewSchedulingStatus =
  | "pending" | "accepted" | "request_new_time" | "cancelled" | "no_contact"

export function parseApplicationStatus(raw: number): ApplicationStatus {
  const status = APPLICATION_STATUS_MAP[raw]
  if (!status) throw new Error(`Unknown application status: ${raw}`)
  return status as ApplicationStatus
}

export function parseInterviewStatus(raw: number): InterviewSchedulingStatus {
  const status = INTERVIEW_STATUS_MAP[raw]
  if (!status) throw new Error(`Unknown interview status: ${raw}`)
  return status as InterviewSchedulingStatus
}
```

- [ ] **Step 2: Create `packages/sdk/src/adapter/dates.ts`**

```typescript
/**
 * ISO date string → Date parsing for Schema.transform pipelines.
 */

import { Schema } from "effect"

/**
 * Schema transform: ISO date string from API → JavaScript Date.
 * Accepts full ISO 8601 ("2026-01-10T12:00:00+01:00") or date-only ("2026-01-10").
 */
export const DateFromIso = Schema.transform(
  Schema.String,
  Schema.DateFromSelf,
  {
    decode: (s) => new Date(s),
    encode: (d) => d.toISOString(),
  },
)

/**
 * Nullable variant — null stays null, string becomes Date.
 */
export const NullableDateFromIso = Schema.transform(
  Schema.NullOr(Schema.String),
  Schema.NullOr(Schema.DateFromSelf),
  {
    decode: (s) => (s === null ? null : new Date(s)),
    encode: (d) => (d === null ? null : d.toISOString()),
  },
)
```

- [ ] **Step 3: Create `packages/sdk/src/adapter/iri.ts`**

```typescript
/**
 * IRI reference → numeric ID extraction.
 * API Platform returns "/api/users/42" — we extract 42.
 */

export function parseIri(iri: string): number {
  const match = iri.match(/\/(\d+)$/)
  if (!match) throw new Error(`Invalid IRI: ${iri}`)
  return Number(match[1])
}

export function parseOptionalIri(iri: string | null): number | null {
  return iri === null ? null : parseIri(iri)
}
```

- [ ] **Step 4: Create `packages/sdk/src/adapter/errors.ts`**

```typescript
/**
 * API Platform violation list → ValidationError fields mapping.
 *
 * API Platform returns:
 * { "violations": [{ "propertyPath": "description", "message": "This value is too short." }] }
 */

export function parseViolations(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {}
  const violations = (body as any)["violations"]
  if (!Array.isArray(violations)) return {}

  const fields: Record<string, string> = {}
  for (const v of violations) {
    if (typeof v?.propertyPath === "string" && typeof v?.message === "string") {
      fields[v.propertyPath] = v.message
    }
  }
  return fields
}
```

- [ ] **Step 5: Verify all compile**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/adapter/
git commit -m "feat(sdk): add adapter utilities — status maps, date parsing, IRI extraction, violation parsing"
```

---

### Task 5: Client context — JWT decode

**Files:**
- Create: `packages/sdk/src/context.ts`

**Context:** The client context is decoded from the JWT at creation time. No server call. The JWT payload contains `roles`, `department`, `teams`, `userId`. The `hasRole` method checks role hierarchy: admin > team_leader > team_member > user.

- [ ] **Step 1: Create `packages/sdk/src/context.ts`**

```typescript
/**
 * Client context decoded from JWT claims.
 * Used for UI convenience (conditional rendering), not security.
 */

export interface ClientContext {
  readonly isAuthenticated: boolean
  readonly role: "user" | "team_member" | "team_leader" | "admin" | null
  readonly department: { id: number; name: string } | null
  readonly teams: { id: number; name: string }[]
  readonly userId: number | null
  hasRole(role: "user" | "team_member" | "team_leader" | "admin"): boolean
  isInDepartment(departmentId: number): boolean
}

const ROLE_HIERARCHY: Record<string, number> = {
  user: 0,
  team_member: 1,
  team_leader: 2,
  admin: 3,
}

/**
 * Decodes a JWT token (base64url) without verification.
 * We only need the payload claims for UI hints — the server verifies the signature.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return {}
    const payload = parts[1]!
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json)
  } catch {
    return {}
  }
}

function extractRole(roles: unknown): ClientContext["role"] {
  if (!Array.isArray(roles)) return null
  if (roles.includes("ROLE_ADMIN")) return "admin"
  if (roles.includes("ROLE_TEAM_LEADER")) return "team_leader"
  if (roles.includes("ROLE_TEAM_MEMBER")) return "team_member"
  if (roles.includes("ROLE_USER")) return "user"
  return null
}

export function createContext(token?: string): ClientContext {
  if (!token) {
    return {
      isAuthenticated: false,
      role: null,
      department: null,
      teams: [],
      userId: null,
      hasRole: () => false,
      isInDepartment: () => false,
    }
  }

  const claims = decodeJwtPayload(token)
  const role = extractRole(claims.roles)
  const department = claims.department as { id: number; name: string } | null ?? null
  const teams = (Array.isArray(claims.teams) ? claims.teams : []) as { id: number; name: string }[]
  const userId = typeof claims.userId === "number" ? claims.userId : null

  return {
    isAuthenticated: true,
    role,
    department,
    teams,
    userId,
    hasRole(requiredRole) {
      if (!role) return false
      return ROLE_HIERARCHY[role]! >= ROLE_HIERARCHY[requiredRole]!
    },
    isInDepartment(departmentId) {
      return department?.id === departmentId
    },
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/context.ts
git commit -m "feat(sdk): add JWT-based client context for UI role/department checks"
```

---

## Phase 2: Schemas + Domain Methods

**Parallelizable:** Tasks 6–14 are independent of each other. They all depend on Phase 1 being complete. Each task creates schema classes in `schemas/` and domain methods in `domains/`. **Task 8 (Receipts) is the reference implementation** — all other domains follow the same pattern.

### Task 6: Common schemas — Page, shared primitives

**Files:**
- Create: `packages/sdk/src/schemas/common.ts`

**Context:** `Page<T>` is the generic collection response after Hydra unwrapping. Shared primitives include the department, team, sponsor, and field-of-study types used across multiple domains.

- [ ] **Step 1: Create `packages/sdk/src/schemas/common.ts`**

```typescript
import { Schema } from "effect"

// --- Page (generic collection response, post-Hydra-unwrap) ---

export class Page<A> {
  constructor(
    readonly items: A[],
    readonly totalItems: number,
    readonly page: number = 1,
    readonly pageSize: number = 30,
  ) {}
}

// Pagination params for list methods
export const PaginationParams = Schema.Struct({
  page: Schema.optional(Schema.Number),
  pageSize: Schema.optional(Schema.Number),
})
export type PaginationParams = Schema.Schema.Type<typeof PaginationParams>

// --- Shared domain types ---

export class Department extends Schema.Class<Department>("Department")({
  id: Schema.Number,
  name: Schema.String,
  city: Schema.String,
}) {}

export class Team extends Schema.Class<Team>("Team")({
  id: Schema.Number,
  name: Schema.String,
}) {}

export class TeamInterest extends Schema.Class<TeamInterest>("TeamInterest")({
  id: Schema.Number,
  userName: Schema.String,
  teamName: Schema.String,
}) {}

export class FieldOfStudy extends Schema.Class<FieldOfStudy>("FieldOfStudy")({
  id: Schema.Number,
  name: Schema.String,
}) {}

export class Sponsor extends Schema.Class<Sponsor>("Sponsor")({
  id: Schema.Number,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
}) {}

export class MailingList extends Schema.Class<MailingList>("MailingList")({
  name: Schema.String,
  emails: Schema.Array(Schema.String),
}) {}

export class AdmissionStats extends Schema.Class<AdmissionStats>("AdmissionStats")({
  totalApplicants: Schema.Number,
  accepted: Schema.Number,
  rejected: Schema.Number,
  interviewed: Schema.Number,
  assignedAssistants: Schema.Number,
}) {}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/schemas/common.ts
git commit -m "feat(sdk): add common Schema classes — Page, Department, Team, Sponsor, etc."
```

---

### Task 7: Auth domain

**Files:**
- Create: `packages/sdk/src/schemas/user.ts`
- Create: `packages/sdk/src/domains/auth.ts`

**Context:** Auth methods don't require a token. They're available on the unauthenticated client.

- [ ] **Step 1: Create `packages/sdk/src/schemas/user.ts`**

```typescript
import { Schema } from "effect"

export class LoginResponse extends Schema.Class<LoginResponse>("LoginResponse")({
  token: Schema.String,
}) {}

export class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  role: Schema.String,
}) {}

export class UserProfile extends Schema.Class<UserProfile>("UserProfile")({
  id: Schema.Number,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.NullOr(Schema.String),
  department: Schema.String,
  fieldOfStudy: Schema.NullOr(Schema.String),
  profilePhoto: Schema.NullOr(Schema.String),
}) {}
```

- [ ] **Step 2: Create `packages/sdk/src/domains/auth.ts`**

```typescript
import { Effect } from "effect"
import type { Transport } from "../transport.js"
import { LoginResponse } from "../schemas/user.js"
import type { InternalSdkError } from "../errors.js"

export interface AuthDomain {
  login(username: string, password: string): Effect.Effect<{ token: string }, InternalSdkError>
  resetPassword(email: string): Effect.Effect<void, InternalSdkError>
  setPassword(code: string, password: string): Effect.Effect<void, InternalSdkError>
}

export function createAuthDomain(transport: Transport): AuthDomain {
  return {
    login(username, password) {
      return transport.post("/api/login", { username, password }, LoginResponse)
    },
    resetPassword(email) {
      return transport.postVoid("/api/reset-password", { email })
    },
    setPassword(code, password) {
      return transport.postVoid("/api/set-password", { code, password })
    },
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/schemas/user.ts packages/sdk/src/domains/auth.ts
git commit -m "feat(sdk): add auth domain — login, resetPassword, setPassword"
```

---

### Task 8: Receipts domain (reference implementation)

**Files:**
- Create: `packages/sdk/src/schemas/receipt.ts`
- Create: `packages/sdk/src/domains/receipts.ts`
- Create: `packages/sdk/src/domains/admin/receipts.ts`

**Context:** This is the most complete domain — user CRUD + admin operations + file upload. All other domains follow this pattern. The receipts domain demonstrates:
- Schema.Class with computed properties (`isPending`, `formattedAmount`)
- Hydra collection unwrapping via `transport.getCollection`
- Form data upload for receipts with photos
- Admin domain operations (`approve`, `reject`, `reopen`) that speak the domain language

- [ ] **Step 1: Create `packages/sdk/src/schemas/receipt.ts`**

```typescript
import { Schema } from "effect"

export class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.String,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.String),
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

export class AdminReceipt extends Schema.Class<AdminReceipt>("AdminReceipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.String,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.String),
  userName: Schema.String,
}) {}

export class ReceiptInput extends Schema.Class<ReceiptInput>("ReceiptInput")({
  description: Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(5000)),
  sum: Schema.Number.pipe(Schema.positive()),
  receiptDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
}) {}

export class ReceiptCreateResponse extends Schema.Class<ReceiptCreateResponse>("ReceiptCreateResponse")({
  id: Schema.Number,
}) {}
```

**Note:** Dates are kept as strings for simplicity in this first pass. The `DateFromIso` adapter transform from Task 4 can be wired in later if consumers need `Date` objects. The spec shows `Schema.Date` but the server returns ISO strings — the consumer-facing type is a design decision. Start with strings, upgrade to Date transforms if needed.

- [ ] **Step 2: Create `packages/sdk/src/domains/receipts.ts`** (user receipts)

```typescript
import { Effect } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"
import type { Page } from "../schemas/common.js"
import { Receipt, ReceiptCreateResponse, ReceiptInput } from "../schemas/receipt.js"

export interface ReceiptsDomain {
  list(params?: { status?: string; page?: number; pageSize?: number }): Effect.Effect<Page<Receipt>, InternalSdkError>
  create(input: typeof ReceiptInput.Type, file?: File): Effect.Effect<{ id: number }, InternalSdkError>
  update(id: number, input: typeof ReceiptInput.Type, file?: File): Effect.Effect<void, InternalSdkError>
  delete(id: number): Effect.Effect<void, InternalSdkError>
}

export function createReceiptsDomain(transport: Transport): ReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.status) query.status = params.status
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/receipts", Receipt, query)
    },

    create(input, file) {
      if (file) {
        const formData = new FormData()
        formData.append("description", input.description)
        formData.append("sum", String(input.sum))
        formData.append("receiptDate", input.receiptDate)
        formData.append("file", file)
        return transport.postFormData("/api/receipts", formData, ReceiptCreateResponse)
      }
      return transport.post("/api/receipts", input, ReceiptCreateResponse)
    },

    update(id, input, file) {
      if (file) {
        const formData = new FormData()
        formData.append("description", input.description)
        formData.append("sum", String(input.sum))
        formData.append("receiptDate", input.receiptDate)
        formData.append("file", file)
        return transport.postFormDataVoid(`/api/receipts/${id}`, formData)
      }
      return transport.put(`/api/receipts/${id}`, input)
    },

    delete(id) {
      return transport.del(`/api/receipts/${id}`)
    },
  }
}
```

- [ ] **Step 3: Create `packages/sdk/src/domains/admin/receipts.ts`** (admin operations)

```typescript
import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import type { Page } from "../../schemas/common.js"
import { AdminReceipt } from "../../schemas/receipt.js"

export interface AdminReceiptsDomain {
  list(params?: { status?: string; page?: number; pageSize?: number }): Effect.Effect<Page<AdminReceipt>, InternalSdkError>
  approve(id: number): Effect.Effect<void, InternalSdkError>
  reject(id: number): Effect.Effect<void, InternalSdkError>
  reopen(id: number): Effect.Effect<void, InternalSdkError>
}

export function createAdminReceiptsDomain(transport: Transport): AdminReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.status) query.status = params.status
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/receipts", AdminReceipt, query)
    },

    approve(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "refunded" })
    },

    reject(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "rejected" })
    },

    reopen(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "pending" })
    },
  }
}
```

- [ ] **Step 4: Verify all compile**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/schemas/receipt.ts packages/sdk/src/domains/receipts.ts packages/sdk/src/domains/admin/receipts.ts
git commit -m "feat(sdk): add receipts domain — user CRUD + admin approve/reject/reopen"
```

---

### Task 9: Me domain

**Files:**
- Create: `packages/sdk/src/schemas/dashboard.ts`
- Create: `packages/sdk/src/domains/me.ts`

**Follow the receipts pattern.** Schema classes:

```typescript
// schemas/dashboard.ts
class DashboardStats extends Schema.Class<DashboardStats>("DashboardStats")({
  name: Schema.String,
  department: Schema.String,
  activeAssistants: Schema.Number,
  pendingApplications: Schema.Number,
  upcomingInterviews: Schema.Number,
}) {}
```

Domain methods:
- `profile()` → `transport.get("/api/me/profile", UserProfile)`
- `dashboard()` → `transport.get("/api/me/dashboard", DashboardStats)`
- `updateProfile(data)` → `transport.put("/api/me/profile", data)`

- [ ] **Step 1: Create schema and domain files**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add me domain — profile, dashboard, updateProfile"
```

---

### Task 10: Applications domain

**Files:**
- Create: `packages/sdk/src/schemas/application.ts`
- Create: `packages/sdk/src/domains/admin/applications.ts`

**Follow the receipts pattern.** Key difference: the Application Schema uses `parseApplicationStatus` from `adapter/status.ts` to convert the server's integer `applicationStatus` to a string enum. Use `Schema.transform` to decode the raw API response shape into the domain type.

```typescript
// schemas/application.ts
const ApplicationStatus = Schema.Literal(
  "not_received", "received", "invited", "accepted",
  "completed", "assigned", "cancelled"
)

class Application extends Schema.Class<Application>("Application")({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  status: ApplicationStatus,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
}) {
  get statusLabel(): string {
    const labels: Record<string, string> = {
      not_received: "Ikke mottatt", received: "Mottatt", invited: "Invitert",
      accepted: "Akseptert", completed: "Fullført", assigned: "Tildelt skole",
      cancelled: "Avbrutt",
    }
    return labels[this.status] ?? this.status
  }
}
```

**Important:** The raw API response has `applicationStatus: number`. The Schema needs a `Schema.transform` to convert. Create a `RawApplication` struct for the API shape and transform it to `Application`:

```typescript
const RawApplication = Schema.Struct({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  applicationStatus: Schema.Number,
  // ... other raw fields
})

const ApplicationFromRaw = Schema.transform(RawApplication, Application, {
  decode: (raw) => ({
    ...raw,
    status: parseApplicationStatus(raw.applicationStatus),
  }),
  encode: (app) => ({ ... }) // reverse if needed
})
```

Domain methods:
- `list(params?)` → `transport.getCollection("/api/admin/applications", ApplicationFromRaw, query)`
- `get(id)` → `transport.get("/api/admin/applications/${id}", ApplicationFromRaw)`
- `delete(id)` → `transport.del("/api/admin/applications/${id}")`
- `bulkDelete(ids)` → `transport.postVoid("/api/admin/applications/bulk-delete", { ids })`

- [ ] **Step 1: Create schema and domain files**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add applications domain with status integer→string derivation"
```

---

### Task 11: Interviews domain

**Files:**
- Create: `packages/sdk/src/schemas/interview.ts`
- Create: `packages/sdk/src/domains/admin/interviews.ts`

**Follow the receipts pattern.** Uses `parseInterviewStatus` from `adapter/status.ts` for the `schedulingStatus` field. Domain methods map to the spec's interview operations.

Domain methods:
- `list(params?)` → getCollection
- `assign(applicationId, interviewerId, schemaId)` → postVoid
- `schedule(id, input)` → put
- `conduct(id, score, answers)` → postVoid
- `cancel(id)` → put
- `schemas()` → get (returns `InterviewSchema[]`)

- [ ] **Step 1: Create schema and domain files**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add interviews domain — assign, schedule, conduct, cancel"
```

---

### Task 12: Users domain

**Files:**
- Create: `packages/sdk/src/domains/admin/users.ts`

**Simple.** Single method: `list()` → returns `{ active: User[], inactive: User[] }`. The server splits users into two arrays. Use the `User` schema from `schemas/user.ts`.

- [ ] **Step 1: Create domain file**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add users domain — active/inactive split"
```

---

### Task 13: Scheduling domain

**Files:**
- Create: `packages/sdk/src/schemas/scheduling.ts`
- Create: `packages/sdk/src/domains/admin/scheduling.ts`

**Follow the receipts pattern.** Three list methods: `assistants`, `schools`, `substitutes`. Each returns a `Page<T>`. Define `Assistant`, `School`, `Substitute` Schema classes based on what the existing API returns. Check the existing dashboard routes for the expected shapes.

- [ ] **Step 1: Create schema and domain files**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add scheduling domain — assistants, schools, substitutes"
```

---

### Task 14: Teams domain

**Files:**
- Create: `packages/sdk/src/domains/admin/teams.ts`

**Simple.** Uses `Team` and `TeamInterest` from `schemas/common.ts`.

Domain methods:
- `list()` → `transport.get("/api/admin/teams", Schema.Array(Team))`
- `interest()` → `transport.getCollection("/api/admin/team-interest", TeamInterest)`

- [ ] **Step 1: Create domain file**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add teams domain — list, interest"
```

---

### Task 15: Misc + Public domains

**Files:**
- Create: `packages/sdk/src/domains/admin/misc.ts`
- Create: `packages/sdk/src/domains/public.ts`

**Simple.** Misc: `mailingLists()`, `admissionStats()`. Public: `departments()`, `fieldOfStudies()`, `sponsors()`, `teams()`. All use schemas from `schemas/common.ts`.

- [ ] **Step 1: Create domain files**
- [ ] **Step 2: Verify compilation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(sdk): add misc and public domains — mailing lists, stats, departments, sponsors"
```

---

## Phase 3: Client Assembly + Exports

### Task 16: Client factory — createClient (Promise surface)

**Files:**
- Create: `packages/sdk/src/sdk.ts`
- Create: `packages/sdk/src/promise.ts`

**Context:** `sdk.ts` assembles all domains into a single client object. `promise.ts` wraps each method with `Effect.runPromise` and maps errors via `toSdkError`. This is the default export (`"."`).

- [ ] **Step 1: Create `packages/sdk/src/sdk.ts`**

This defines the Sdk type — the assembled client with all domains. Both Promise and Effect exports share this structure.

```typescript
import type { Effect } from "effect"
import type { InternalSdkError } from "./errors.js"
import type { ClientContext } from "./context.js"
import type { AuthDomain } from "./domains/auth.js"
import type { ReceiptsDomain } from "./domains/receipts.js"
import type { AdminReceiptsDomain } from "./domains/admin/receipts.js"
// ... import all other domain types

export interface AdminDomain {
  receipts: AdminReceiptsDomain
  applications: AdminApplicationsDomain
  interviews: AdminInterviewsDomain
  users: AdminUsersDomain
  scheduling: AdminSchedulingDomain
  teams: AdminTeamsDomain
  mailingLists(): Effect.Effect<MailingList[], InternalSdkError>
  admissionStats(): Effect.Effect<AdmissionStats, InternalSdkError>
}

export interface EffectSdk {
  auth: AuthDomain
  me: MeDomain
  receipts: ReceiptsDomain
  admin: AdminDomain
  public: PublicDomain
  context: ClientContext
}
```

- [ ] **Step 2: Create `packages/sdk/src/promise.ts`**

This wraps the Effect SDK, converting every method from `Effect<A, E>` to `Promise<A>` that throws `SdkError`.

```typescript
import { Effect } from "effect"
import { createTransport, type AuthOption } from "./transport.js"
import { toSdkError, type InternalSdkError } from "./errors.js"
import { createContext, type ClientContext } from "./context.js"
import { createAuthDomain } from "./domains/auth.js"
import { createReceiptsDomain } from "./domains/receipts.js"
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js"
// ... import all domain factories

export type { ClientContext }
export { SdkError, UnauthorizedError, NotFoundError, ValidationError, ConflictError, NetworkError, RateLimitedError } from "./errors.js"

// Re-export all schema types for consumers
export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js"
export type { Application } from "./schemas/application.js"
// ... all other schema type re-exports

export type ClientOptions = {
  auth?: AuthOption
}

/**
 * Wraps an Effect method into a Promise that throws SdkError on failure.
 */
function promisify<Args extends unknown[], A>(
  fn: (...args: Args) => Effect.Effect<A, InternalSdkError>,
): (...args: Args) => Promise<A> {
  return (...args) =>
    Effect.runPromise(
      fn(...args).pipe(
        Effect.mapError(toSdkError),
        Effect.catchAll((e) => Effect.fail(e)), // ensures SdkError is thrown
      ),
    )
}

/**
 * Wraps an entire domain object — every method becomes Promise-returning.
 */
function promisifyDomain<T extends Record<string, (...args: any[]) => Effect.Effect<any, InternalSdkError>>>(
  domain: T,
): { [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any> ? (...args: A) => Promise<R> : never } {
  const result: any = {}
  for (const key of Object.keys(domain)) {
    result[key] = promisify(domain[key as keyof T] as any)
  }
  return result
}

export function createClient(baseUrl: string, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth)
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined
  const context = createContext(initialToken)

  const auth = createAuthDomain(transport)
  const me = createMeDomain(transport)
  const receipts = createReceiptsDomain(transport)
  const adminReceipts = createAdminReceiptsDomain(transport)
  const adminApplications = createAdminApplicationsDomain(transport)
  const adminInterviews = createAdminInterviewsDomain(transport)
  const adminUsers = createAdminUsersDomain(transport)
  const adminScheduling = createAdminSchedulingDomain(transport)
  const adminTeams = createAdminTeamsDomain(transport)
  const adminMisc = createAdminMiscDomain(transport)
  const publicDomain = createPublicDomain(transport)

  return {
    auth: promisifyDomain(auth),
    me: promisifyDomain(me),
    receipts: promisifyDomain(receipts),
    admin: {
      receipts: promisifyDomain(adminReceipts),
      applications: promisifyDomain(adminApplications),
      interviews: promisifyDomain(adminInterviews),
      users: promisifyDomain(adminUsers),
      scheduling: promisifyDomain(adminScheduling),
      teams: promisifyDomain(adminTeams),
      mailingLists: promisify(adminMisc.mailingLists),
      admissionStats: promisify(adminMisc.admissionStats),
    },
    public: promisifyDomain(publicDomain),
    context,
  }
}

export type Sdk = ReturnType<typeof createClient>
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/sdk.ts packages/sdk/src/promise.ts
git commit -m "feat(sdk): add createClient factory with Promise surface and promisifyDomain wrapper"
```

---

### Task 17: Effect client export

**Files:**
- Create: `packages/sdk/src/effect-client.ts`

**Context:** The Effect export (`"./effect"`) exposes the same domain structure but without Promise wrapping. Consumers who use Effect directly import from `@vektorprogrammet/sdk/effect`.

- [ ] **Step 1: Create `packages/sdk/src/effect-client.ts`**

```typescript
import { createTransport, type AuthOption } from "./transport.js"
import { createContext } from "./context.js"
import { createAuthDomain } from "./domains/auth.js"
import { createReceiptsDomain } from "./domains/receipts.js"
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js"
// ... import all domain factories

export type { InternalSdkError } from "./errors.js"
export type { ClientContext } from "./context.js"

// Re-export all schema types
export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js"
// ... all other schema type re-exports

export type ClientOptions = {
  auth?: AuthOption
}

export function createEffectClient(baseUrl: string, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth)
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined
  const context = createContext(initialToken)

  return {
    auth: createAuthDomain(transport),
    me: createMeDomain(transport),
    receipts: createReceiptsDomain(transport),
    admin: {
      receipts: createAdminReceiptsDomain(transport),
      applications: createAdminApplicationsDomain(transport),
      interviews: createAdminInterviewsDomain(transport),
      users: createAdminUsersDomain(transport),
      scheduling: createAdminSchedulingDomain(transport),
      teams: createAdminTeamsDomain(transport),
      mailingLists: createAdminMiscDomain(transport).mailingLists,
      admissionStats: createAdminMiscDomain(transport).admissionStats,
    },
    public: createPublicDomain(transport),
    context,
  }
}

export type EffectSdk = ReturnType<typeof createEffectClient>
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/sdk && bunx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/effect-client.ts
git commit -m "feat(sdk): add createEffectClient for Effect-native consumers"
```

---

### Task 18: Public API — index exports

**Files:**
- Modify: `packages/sdk/src/index.ts` (replace contents)

**Context:** The old `index.ts` exports `createClient`, `createQueryApi`, `QueryProvider`, `apiUrl`, `isFixtureMode`, pre-configured instances, and `paths`. The new version exports only what consumers need. `apiUrl` and `isFixtureMode` stay (they're used by the dashboard).

- [ ] **Step 1: Replace `packages/sdk/src/index.ts`**

```typescript
// Re-export the Promise surface as the default API
export { createClient, type Sdk, type ClientOptions } from "./promise.js"
export { apiUrl, isFixtureMode } from "./config.js"

// Error types for instanceof checks
export {
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
} from "./errors.js"

// Domain types (re-exported from Schema classes)
export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js"
export type { Application } from "./schemas/application.js"
export type { Interview } from "./schemas/interview.js"
export type { User, UserProfile, LoginResponse } from "./schemas/user.js"
export type { DashboardStats } from "./schemas/dashboard.js"
export type {
  Department, Team, TeamInterest, FieldOfStudy, Sponsor,
  MailingList, AdmissionStats, Page,
} from "./schemas/common.js"
export type { ClientContext } from "./context.js"
```

- [ ] **Step 2: Build the full SDK**

Run: `cd packages/sdk && bun run build`
Expected: Compiles with no errors. `dist/` contains `promise.js`, `effect-client.js`, and all supporting modules.

- [ ] **Step 3: Verify package exports resolve correctly**

Run: `cd packages/sdk && node -e "require('./dist/promise.js')"` (or use bun)
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/index.ts
git commit -m "feat(sdk): update index.ts with new public API exports"
```

---

## Phase 4: Dashboard Migration

### Task 19: Replace `api.server.ts`

**Files:**
- Modify: `apps/dashboard/app/lib/api.server.ts`

**Context:** The current file imports `createClient` from the SDK and wraps it with auth headers. The new SDK handles auth internally — just pass the token to `createClient`.

- [ ] **Step 1: Update `apps/dashboard/app/lib/api.server.ts`**

```typescript
import { createClient } from "@vektorprogrammet/sdk"
import { apiUrl } from "@vektorprogrammet/sdk"

export function createAuthenticatedClient(token: string) {
  return createClient(apiUrl, { auth: token })
}
```

This is a thin wrapper for backward compatibility. Routes can gradually switch from `createAuthenticatedClient(token)` to `createClient(apiUrl, { auth: token })` directly.

- [ ] **Step 2: Verify the dashboard still typechecks**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: Type errors in every route that uses `.GET()`, `.POST()`, `.PUT()` (old openapi-fetch methods). This is expected — routes will be migrated one by one.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/app/lib/api.server.ts
git commit -m "refactor(dashboard): update api.server.ts to use new SDK createClient"
```

---

### Task 20: Migrate dashboard routes

**Files (18 routes to migrate):**
- `apps/dashboard/app/routes/login.tsx`
- `apps/dashboard/app/routes/glemt-passord.tsx`
- `apps/dashboard/app/routes/tilbakestill-passord.$code.tsx`
- `apps/dashboard/app/routes/dashboard.tsx`
- `apps/dashboard/app/routes/dashboard._index.tsx`
- `apps/dashboard/app/routes/dashboard.profile._index.tsx`
- `apps/dashboard/app/routes/dashboard.utlegg._index.tsx`
- `apps/dashboard/app/routes/dashboard.mine-utlegg._index.tsx`
- `apps/dashboard/app/routes/dashboard.sokere._index.tsx`
- `apps/dashboard/app/routes/dashboard.intervjuer._index.tsx`
- `apps/dashboard/app/routes/dashboard.brukere._index.tsx`
- `apps/dashboard/app/routes/dashboard.assistenter._index.tsx`
- `apps/dashboard/app/routes/dashboard.skoler._index.tsx`
- `apps/dashboard/app/routes/dashboard.vikarer._index.tsx`
- `apps/dashboard/app/routes/dashboard.teaminteresse._index.tsx`
- `apps/dashboard/app/routes/dashboard.epostliste._index.tsx`
- `apps/dashboard/app/routes/dashboard.statistikk._index.tsx`

**Parallelizable:** Each route is independent. Can be done by separate workers simultaneously.

**Pattern for each route:**

1. Read the existing route to understand what SDK calls it makes
2. Replace `client.GET("/api/...")` with the appropriate domain method
3. Replace `client.POST("/api/...")` / `client.PUT("/api/...")` with domain methods
4. Remove `as any` casts, Hydra envelope unwrapping, integer status mapping
5. Verify the route typechecks

**Example — login.tsx migration:**

Before:
```typescript
const client = createClient(apiUrl)
const { data, error, response } = await client.POST("/api/login", { body: { username, password } })
if (error || !data?.token) { /* handle error */ }
```

After:
```typescript
const sdk = createClient(apiUrl)
try {
  const { token } = await sdk.auth.login(username, password)
  return redirect("/dashboard", { headers: { "Set-Cookie": createAuthCookie(token) } })
} catch (e) {
  if (e instanceof RateLimitedError) {
    return { error: "For mange innloggingsforsøk. Prøv igjen om 15 minutter." }
  }
  return { error: "Feil brukernavn eller passord" }
}
```

**Example — receipts route migration:**

Before:
```typescript
const { data } = await client.GET("/api/admin/receipts" as any, { params: { query: status ? { status } : {} } })
const receipts = ((data as any)?.["hydra:member"] as Receipt[]) ?? []
```

After:
```typescript
const sdk = createClient(apiUrl, { auth: token })
const { items: receipts } = await sdk.admin.receipts.list({ status })
```

- [ ] **Step 1: Migrate each route** (parallelize across workers)

For each route:
1. Read the current file
2. Identify all SDK calls (`client.GET`, `client.POST`, `client.PUT`, `client.DELETE`)
3. Replace with domain method calls
4. Replace error handling with try/catch + SdkError discrimination
5. Remove local type definitions that are now provided by the SDK (e.g., `type Receipt = { ... }`)

- [ ] **Step 2: Verify the full dashboard typechecks**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit per route or per batch**

```bash
git commit -m "refactor(dashboard): migrate login route to new SDK domain methods"
git commit -m "refactor(dashboard): migrate receipt routes to new SDK"
git commit -m "refactor(dashboard): migrate application + interview routes to new SDK"
git commit -m "refactor(dashboard): migrate remaining admin routes to new SDK"
```

---

### Task 21: Cleanup — remove old SDK files and dependencies

**Files:**
- Delete: `packages/sdk/generated/api.d.ts`
- Delete: `packages/sdk/openapi.json`
- Delete: `packages/sdk/src/query.ts` (React Query wrapper)
- Delete: `packages/sdk/src/provider.tsx` (React Query provider)
- Delete: `packages/sdk/src/client.ts` (old openapi-fetch wrapper)

**Context:** These files are now unused. The generated types are replaced by Schema classes. React Query is no longer a dependency of the SDK — consumers bring their own data-fetching layer.

- [ ] **Step 1: Delete old files**

```bash
cd packages/sdk
rm -f generated/api.d.ts openapi.json src/query.ts src/provider.tsx src/client.ts
rmdir generated 2>/dev/null || true
```

- [ ] **Step 2: Remove old dependency references from dashboard**

Search for imports of `QueryProvider`, `createQueryApi`, `$api`, `paths` from the SDK in the dashboard. Remove or replace them.

Run: `grep -r "createQueryApi\|QueryProvider\|\$api\|openapi-react-query\|openapi-fetch" apps/dashboard/`
Expected: No matches (all migrated in Task 20).

- [ ] **Step 3: Build everything**

Run: `turbo build`
Expected: All packages and apps build successfully.

- [ ] **Step 4: Commit**

```bash
git add -A packages/sdk/ apps/dashboard/
git commit -m "chore(sdk): remove openapi-fetch, React Query, and generated types

BREAKING CHANGE: SDK no longer exports createQueryApi, QueryProvider, or paths type.
All consumers use createClient with domain methods instead."
```

---

## Phase 5: Testing

### Task 22: Transport tests

**Files:**
- Create: `packages/sdk/src/__tests__/transport.test.ts`

**Context:** Test the transport layer with a mock HttpClient. Verify auth resolution (static string, async function, undefined), Hydra collection unwrapping, and HTTP status → error mapping.

- [ ] **Step 1: Create transport tests**

Use `@effect/vitest` with `it.effect` for Effect-native test assertions. Mock the fetch layer by providing a custom `HttpClient` that returns canned responses.

Key test cases:
- Static auth token is sent as `Authorization: Bearer <token>`
- Dynamic auth function is called before each request
- No auth option → no Authorization header
- 200 response → decoded through Schema
- 401 response → `Unauthorized` error
- 404 response → `NotFound` error
- 409 response → `Conflict` error
- 422 response → `Validation` error with fields
- 429 response → `RateLimited` error
- Network error → `Network` error
- Hydra collection → `{ items, totalItems }` correctly extracted

- [ ] **Step 2: Run tests**

Run: `cd packages/sdk && bun run test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/__tests__/transport.test.ts
git commit -m "test(sdk): transport layer tests — auth, error mapping, Hydra unwrap"
```

---

### Task 23: Adapter tests

**Files:**
- Create: `packages/sdk/src/__tests__/adapter.test.ts`

**Context:** Test the pure adapter functions in isolation.

Key test cases:
- `parseApplicationStatus(0)` → `"not_received"`, ..., `parseApplicationStatus(-1)` → `"cancelled"`
- `parseApplicationStatus(99)` → throws
- `parseInterviewStatus(0)` → `"pending"`, ..., `parseInterviewStatus(4)` → `"no_contact"`
- `parseIri("/api/users/42")` → `42`
- `parseIri("invalid")` → throws
- `parseViolations({ violations: [...] })` → `{ field: message }`
- `parseViolations(null)` → `{}`

- [ ] **Step 1: Create adapter tests**
- [ ] **Step 2: Run tests**
- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/__tests__/adapter.test.ts
git commit -m "test(sdk): adapter utility tests — status maps, IRI parsing, violation parsing"
```

---

### Task 24: Schema round-trip tests

**Files:**
- Create: `packages/sdk/src/__tests__/schemas.test.ts`

**Context:** Every Schema class round-trips through encode/decode using `Arbitrary.make`. This catches Schema definition bugs (e.g., wrong field types, missing optional markers).

- [ ] **Step 1: Create schema round-trip tests**

Use `it.prop` from `@effect/vitest` with `Arbitrary.make(SchemaClass)` for each Schema class:

```typescript
import { it } from "@effect/vitest"
import { Schema, Arbitrary } from "effect"
import { Receipt } from "../schemas/receipt.js"
// ... import all schema classes

it.prop("Receipt round-trips", [Arbitrary.make(Receipt)], (receipt) => {
  const encoded = Schema.encodeSync(Receipt)(receipt)
  const decoded = Schema.decodeUnknownSync(Receipt)(encoded)
  expect(decoded).toEqual(receipt)
})

// Repeat for: AdminReceipt, Application, Interview, User, UserProfile,
// DashboardStats, Department, Team, Sponsor, FieldOfStudy, etc.
```

- [ ] **Step 2: Run tests**

Run: `cd packages/sdk && bun run test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/__tests__/schemas.test.ts
git commit -m "test(sdk): Schema round-trip property tests for all domain types"
```

---

### Task 25: Context tests

**Files:**
- Create: `packages/sdk/src/__tests__/context.test.ts`

Key test cases:
- `createContext()` → unauthenticated context (all null/false)
- `createContext(validJwt)` → extracts role, department, teams, userId
- `context.hasRole("team_leader")` → true when role is admin, true when role is team_leader, false when role is team_member
- `context.isInDepartment(42)` → true when department.id === 42
- `createContext("invalid-token")` → unauthenticated context (graceful failure)

- [ ] **Step 1: Create context tests**
- [ ] **Step 2: Run tests**
- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/__tests__/context.test.ts
git commit -m "test(sdk): JWT context decoding and role hierarchy tests"
```

---

### Task 26: Integration — verify dashboard builds and works

- [ ] **Step 1: Full build**

Run: `turbo build`
Expected: All packages and apps build.

- [ ] **Step 2: Dashboard typecheck**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: SDK tests**

Run: `cd packages/sdk && bun run test`
Expected: All pass.

- [ ] **Step 4: Dashboard dev server smoke test**

Run: `cd apps/dashboard && bun run dev`
Navigate to login page, verify it loads. Navigate to `/dashboard/utlegg`, verify receipt list renders.

- [ ] **Step 5: Final commit if any adjustments needed**

Only if integration revealed issues.
