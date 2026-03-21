# SDK Redesign — Design Spec

## Goal

Replace the auto-generated openapi-fetch SDK with an idiomatic Effect-TS typed HTTP client. Domain-grouped methods returning `Effect`, Schema-validated responses, Hydra unwrapping in transport, types owned by the SDK.

## Scope

- **In:** Transport layer (Effect HttpClient), domain methods, Schema types, migration of all consumers
- **Out:** React Query hooks (consumer concern), OpenAPI spec generation (server concern)

## Problem

The current SDK wraps `openapi-fetch` with types generated from the Symfony OpenAPI spec. This is broken:
- `paths` interface generates as an empty object — all path types resolve to `never`
- Every SDK call requires `as any` casts, defeating type safety
- Collection responses leak Hydra envelopes (`hydra:member`) into consumers
- The spec export has quirks (`picturePath: []`) requiring manual patching
- The SDK has React/TanStack Query dependencies it doesn't need
- No runtime validation — responses are cast, not verified

## Architecture

```
packages/sdk/src/
  errors.ts             — Tagged errors (SdkError variants)
  schemas/
    common.ts           — Page<T>, shared schemas
    receipt.ts          — Receipt, AdminReceipt, ReceiptInput
    application.ts      — Application, ApplicationStatus
    interview.ts        — InterviewSchema, InterviewAssignInput
    user.ts             — User, LoginResponse
    dashboard.ts        — DashboardStats
    misc.ts             — Sponsor, Team, FieldOfStudy, etc.
  transport.ts          — Effect HttpClient wrapper: auth, Hydra unwrap, Schema decode
  domains/
    auth.ts             — login, passwordReset
    me.ts               — profile, dashboard stats
    receipts.ts         — user receipt CRUD
    admin/
      receipts.ts       — admin receipt list + status change
      applications.ts   — application list, delete, bulk-delete
      interviews.ts     — interview list, assign, schedule, **listSchemas**
      users.ts          — user list
      scheduling.ts     — assistants, schools, substitutes
      teams.ts          — team list, team interest
      surveys.ts        — survey list
      misc.ts           — mailing lists, admission stats, field of studies, sponsors
  client.ts             — makeSdk Layer + Sdk service tag
  config.ts             — apiUrl, isFixtureMode (unchanged)
  index.ts              — exports
```

## Errors (`errors.ts`)

```typescript
import { Schema } from "effect"

class HttpError extends Schema.TaggedError<HttpError>()("HttpError", {
  status: Schema.Number,
  message: Schema.String,
  url: Schema.String,
}) {}

class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  message: Schema.String,
  url: Schema.String,
  cause: Schema.Unknown,
}) {}

class NetworkError extends Schema.TaggedError<NetworkError>()("NetworkError", {
  url: Schema.String,
  cause: Schema.Unknown,
}) {}

type SdkError = HttpError | DecodeError | NetworkError
```

## Schemas (`schemas/`)

All types defined as `Schema.Class` — runtime validated, with methods.

```typescript
// schemas/common.ts
import { Schema } from "effect"

class Page<T> extends Schema.Class<Page<T>>("Page")({
  items: Schema.Array(Schema.Unknown), // refined per domain
  totalItems: Schema.Number,
}) {}

// Generic page factory
const PageOf = <A, I, R>(itemSchema: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    items: Schema.Array(itemSchema),
    totalItems: Schema.Number,
  })
```

```typescript
// schemas/receipt.ts
import { Schema } from "effect"

const ReceiptStatus = Schema.Literal("pending", "refunded", "rejected")

class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.NullOr(Schema.String),
  status: ReceiptStatus,
  refundDate: Schema.NullOr(Schema.String),
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

class AdminReceipt extends Schema.Class<AdminReceipt>("AdminReceipt")({
  id: Schema.Number,
  visualId: Schema.String,
  userName: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.NullOr(Schema.String),
  status: ReceiptStatus,
}) {}

class ReceiptInput extends Schema.Class<ReceiptInput>("ReceiptInput")({
  description: Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(5000)),
  sum: Schema.Number.pipe(Schema.positive()),
  receiptDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
}) {}
```

```typescript
// schemas/application.ts
import { Schema, Match } from "effect"

const ApplicationStatusCode = Schema.Int.pipe(Schema.between(-1, 5))

class Application extends Schema.Class<Application>("Application")({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  applicationStatus: ApplicationStatusCode,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
}) {
  get statusLabel(): string {
    return Match.value(this.applicationStatus).pipe(
      Match.when(-1, () => "Avbrutt"),
      Match.when(0, () => "Ikke mottatt"),
      Match.when(1, () => "Mottatt"),
      Match.when(2, () => "Invitert"),
      Match.when(3, () => "Akseptert"),
      Match.when(4, () => "Fullført"),
      Match.when(5, () => "Tildelt skole"),
      Match.orElse(() => "Ukjent"),
    )
  }
}
```

## Transport Layer (`transport.ts`)

Uses `@effect/platform` HttpClient — Effect-native, testable via Layer.

```typescript
import { Effect, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpClientError } from "@effect/platform"

const makeTransport = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  const request = <A>(
    schema: Schema.Schema<A>,
    req: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<A, SdkError> =>
    pipe(
      client.execute(req),
      Effect.flatMap((response) =>
        Match.value(response.status).pipe(
          Match.when(204, () => Effect.succeed(undefined as A)),
          Match.when((s) => s >= 400, () =>
            Effect.flatMap(response.text, (message) =>
              Effect.fail(new HttpError({
                status: response.status,
                message,
                url: req.url,
              }))
            )
          ),
          Match.orElse(() =>
            pipe(
              HttpClientResponse.schemaBodyJson(schema)(response),
              Effect.mapError((cause) =>
                new DecodeError({ message: "Response decode failed", url: req.url, cause })
              ),
            )
          ),
        )
      ),
      Effect.catchTag("RequestError", (e) =>
        Effect.fail(new NetworkError({ url: req.url, cause: e }))
      ),
      Effect.catchTag("ResponseError", (e) =>
        Effect.fail(new HttpError({ status: e.response.status, message: e.message, url: req.url }))
      ),
    )

  // params values are stringified via URLSearchParams
  const get = <A>(schema: Schema.Schema<A>, path: string, params?: Record<string, string | number | boolean>) =>
    request(schema, HttpClientRequest.get(path).pipe(
      params ? HttpClientRequest.setUrlParams(params) : identity,
    ))

  // params values are stringified via URLSearchParams
  const getCollection = <A>(itemSchema: Schema.Schema<A>, path: string, params?: Record<string, string | number | boolean>) => {
    const HydraResponse = Schema.Struct({
      "hydra:member": Schema.Array(itemSchema),
      "hydra:totalItems": Schema.Number,
    })
    const PageSchema = Schema.transform(
      HydraResponse,
      Schema.Struct({ items: Schema.Array(itemSchema), totalItems: Schema.Number }),
      {
        decode: (hydra) => ({ items: hydra["hydra:member"], totalItems: hydra["hydra:totalItems"] }),
        encode: (page) => ({ "hydra:member": page.items, "hydra:totalItems": page.totalItems }),
      }
    )
    return request(PageSchema, HttpClientRequest.get(path).pipe(
      params ? HttpClientRequest.setUrlParams(params) : identity,
    ))
  }

  const post = <A>(schema: Schema.Schema<A>, path: string, body: unknown) =>
    request(schema, HttpClientRequest.post(path).pipe(
      HttpClientRequest.jsonBody(body),
    ))

  const put = <A>(schema: Schema.Schema<A>, path: string, body: unknown) =>
    request(schema, HttpClientRequest.put(path).pipe(
      HttpClientRequest.jsonBody(body),
    ))

  const del = (path: string) =>
    request(Schema.Void, HttpClientRequest.del(path))

  const postFormData = <A>(schema: Schema.Schema<A>, path: string, formData: FormData) =>
    request(schema, HttpClientRequest.post(path).pipe(
      HttpClientRequest.formDataBody(formData),
    ))

  return { get, getCollection, post, put, del, postFormData } as const
})

type Transport = Effect.Effect.Success<typeof makeTransport>
```

## Non-Hydra Endpoints

Some endpoints return custom shapes, not Hydra collections:
- `GET /api/admin/users` → `{ activeUsers: User[], inactiveUsers: User[], departmentName: string }` — use `transport.get` with a custom schema
- `GET /api/admin/applications` → Hydra collection (standard)
- `GET /api/me/dashboard` → single object (use `transport.get`)

Domain methods for these endpoints define their own response schemas and use `transport.get` instead of `transport.getCollection`.

Key differences from the plain-fetch version:
- **Schema validation on every response** — decode errors are typed, not silent casts
- **Effect-native** — composable, testable, interruptible
- **HttpClient from Layer** — swap for test double without changing domain code
- **Hydra transform** — `Schema.transform` converts Hydra envelope → `Page<T>` in the schema layer
- **Tagged errors** — consumers use `Effect.catchTag("HttpError", ...)` for precise handling

## Domain Methods

Each returns `Effect<T, SdkError, Transport>`. No promises, no exceptions.

```typescript
// domains/receipts.ts
import { Effect } from "effect"
import { Receipt, ReceiptInput } from "../schemas/receipt.js"

const make = (transport: Transport) => ({
  list: (params?: { status?: string }) =>
    transport.getCollection(Receipt, "/api/my/receipts", params),

  create: (input: ReceiptInput, file?: File) => {
    const form = new FormData()
    form.append("description", input.description)
    form.append("sum", String(input.sum))
    form.append("receiptDate", input.receiptDate)
    Array.match(file ? [file] : [], {
      onEmpty: () => {},
      onNonEmpty: ([f]) => form.append("picture", f),
    })
    return transport.postFormData(Schema.Struct({ id: Schema.Number }), "/api/receipts", form)
  },

  update: (id: number, input: ReceiptInput, file?: File) => {
    const form = new FormData()
    form.append("description", input.description)
    form.append("sum", String(input.sum))
    form.append("receiptDate", input.receiptDate)
    Array.match(file ? [file] : [], {
      onEmpty: () => {},
      onNonEmpty: ([f]) => form.append("picture", f),
    })
    return transport.postFormData(Schema.Struct({ id: Schema.Number }), `/api/receipts/${id}`, form)
  },

  del: (id: number) =>
    transport.del(`/api/receipts/${id}`),
})
```

## Client (`client.ts`)

Effect service with Layer — the SDK is a dependency, not a global.

```typescript
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "@effect/platform"

class Sdk extends Context.Tag("Sdk")<Sdk, {
  readonly auth: ReturnType<typeof createAuthDomain>
  readonly me: ReturnType<typeof createMeDomain>
  readonly receipts: ReturnType<typeof createReceiptsDomain>
  readonly admin: {
    readonly receipts: ReturnType<typeof createAdminReceiptsDomain>
    readonly applications: ReturnType<typeof createAdminApplicationsDomain>
    readonly interviews: ReturnType<typeof createAdminInterviewsDomain>
    readonly users: ReturnType<typeof createAdminUsersDomain>
    readonly scheduling: ReturnType<typeof createAdminSchedulingDomain>
    readonly teams: ReturnType<typeof createAdminTeamsDomain>
    readonly surveys: ReturnType<typeof createAdminSurveysDomain>
    readonly misc: ReturnType<typeof createAdminMiscDomain>
  }
}>() {}

const SdkLive = Layer.effect(
  Sdk,
  Effect.gen(function* () {
    const transport = yield* makeTransport
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
        surveys: createAdminSurveysDomain(transport),
        misc: createAdminMiscDomain(transport),
      },
    }
  }),
)
```

## Consumer Migration

### Before
```typescript
const client = createAuthenticatedClient(token);
const { data } = await client.GET("/api/admin/receipts" as any, { params: { query: { status } } });
const receipts = (data as any)?.["hydra:member"] ?? [];
```

### After (in React Router loader/action)
```typescript
import { Effect } from "effect"
import { Sdk } from "@vektorprogrammet/sdk"

// In loader — must bridge to Promise for React Router
const program = Effect.gen(function* () {
  const sdk = yield* Sdk
  return yield* sdk.admin.receipts.list({ status })
})

const { items, totalItems } = await Effect.runPromise(
  program.pipe(Effect.provide(SdkLive))
)
```

### Convenience wrapper for React Router (in `api.server.ts`)
```typescript
import { Effect, Layer } from "effect"
import { HttpClient } from "@effect/platform"
import { Sdk, SdkLive } from "@vektorprogrammet/sdk"

export function runSdk<A, E>(
  token: string,
  effect: (sdk: Sdk) => Effect.Effect<A, E>,
) {
  const AuthenticatedClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.makeDefault.pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)),
      HttpClient.mapRequest(HttpClientRequest.setHeader("Accept", "application/json")),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const sdk = yield* Sdk
      return yield* effect(sdk)
    }).pipe(
      Effect.provide(SdkLive),
      Effect.provide(AuthenticatedClient),
    )
  )
}

// Usage in loader:
export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request)
  const page = await runSdk(token, (sdk) => sdk.admin.receipts.list({ status }))
  return { receipts: page.items }
}
```

### React Query usage (consumer side)
```typescript
const { data } = useQuery({
  queryKey: ["admin", "receipts", { status }],
  queryFn: () => runSdk(token, (sdk) => sdk.admin.receipts.list({ status })),
})
```

## Testing

Effect's Layer system makes the SDK fully testable without HTTP:

```typescript
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient } from "@effect/platform"

// Mock transport returns canned responses
const TestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.makeDefault.pipe(/* mock responses */),
)

it.effect("lists receipts for user", () =>
  Effect.gen(function* () {
    const sdk = yield* Sdk
    const page = yield* sdk.receipts.list()
    expect(page.items).toHaveLength(2)
    expect(Schema.is(Receipt)(page.items[0])).toBe(true)
  }).pipe(
    Effect.provide(SdkLive),
    Effect.provide(TestHttpClient),
  )
)
```

Property-based tests via Schema Arbitrary:
```typescript
import { Arbitrary } from "effect"
import * as fc from "fast-check"

it.prop("round-trips Receipt schema", [Arbitrary.make(Receipt)], ([receipt]) => {
  const encoded = Schema.encodeSync(Receipt)(receipt)
  const decoded = Schema.decodeUnknownSync(Receipt)(encoded)
  expect(decoded).toEqual(receipt)
})
```

## Exports

```typescript
// packages/sdk/src/index.ts
export { Sdk, SdkLive } from "./client.js"
export { apiUrl, isFixtureMode } from "./config.js"
export * from "./schemas/index.js"
export * from "./errors.js"
```

## Dependencies

| Before | After |
|--------|-------|
| `openapi-fetch` | removed |
| `openapi-react-query` | removed |
| `openapi-typescript` (devDep) | removed |
| `@tanstack/react-query` (peer) | removed |
| `react` (peer) | removed |
| — | `effect` |
| — | `@effect/platform` |
| — | `@effect/schema` (included in effect) |

## Removed

| File | Reason |
|------|--------|
| `packages/sdk/generated/api.d.ts` | Types now Schema classes |
| `packages/sdk/openapi.json` | Moves to `apps/server/` (server concern) |
| `packages/sdk/src/client.ts` (old) | Replaced by Effect service |
| `packages/sdk/src/query.ts` | React Query is consumer concern |
| `packages/sdk/src/provider.tsx` | React Query is consumer concern |

## Migration Strategy

1. Add `effect` + `@effect/platform` deps
2. Build new SDK alongside old exports
3. Add `runSdk` helper to `api.server.ts`
4. Migrate one route at a time (start with receipts)
5. Remove old exports once all consumers migrate
6. Move `openapi.json` to `apps/server/`

## Files

### New
| File | Purpose |
|------|---------|
| `packages/sdk/src/errors.ts` | HttpError, DecodeError, NetworkError |
| `packages/sdk/src/transport.ts` | Effect HttpClient wrapper |
| `packages/sdk/src/schemas/*.ts` | Schema classes per domain |
| `packages/sdk/src/domains/*.ts` | Domain method factories |
| `packages/sdk/src/domains/admin/*.ts` | Admin domain methods |

### Modified
| File | Change |
|------|--------|
| `packages/sdk/src/client.ts` | Rewrite as Effect service |
| `packages/sdk/src/index.ts` | New exports |
| `packages/sdk/package.json` | Swap deps |
| `apps/dashboard/app/lib/api.server.ts` | `runSdk` helper |
| All 25 dashboard route files | Migrate to `runSdk` |
