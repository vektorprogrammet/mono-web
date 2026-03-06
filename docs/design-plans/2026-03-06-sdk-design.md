# TypeScript SDK Design

## Goal

A shared `@monoweb/sdk` package that auto-generates a type-safe API client from the Symfony API Platform OpenAPI spec. Homepage and dashboard consume it with TanStack Query. When the backend migrates from Symfony to the TS api, consumer code stays the same — only the spec source changes.

## Architecture

```
apps/server (Symfony API Platform)
  → php bin/console api:openapi:export → openapi.json
  → openapi-typescript → generated/api.d.ts
  → openapi-fetch + openapi-react-query → typed client + declarative hooks
  → apps/homepage, apps/dashboard import @monoweb/sdk
```

## Package Structure

```
packages/
  sdk/
    package.json            # @monoweb/sdk
    openapi.json            # committed spec (auto-generated via CLI export)
    tsconfig.json
    src/
      client.ts             # createClient() — imperative openapi-fetch wrapper
      query.ts              # createQueryClient() — declarative openapi-react-query wrapper
      index.ts              # barrel export (both layers)
    generated/
      api.d.ts              # openapi-typescript output (auto-generated, committed)
```

### Key files

- `openapi.json` — committed so TS devs can regenerate types without PHP
- `generated/api.d.ts` — committed so apps can type-check without running codegen
- Both auto-generated, never hand-edited

## Consumer API

### Setup (per app)

```typescript
// apps/homepage/src/lib/api.ts
import { createClient, createQueryClient } from "@monoweb/sdk";

// Imperative client — for loaders, server-side, or custom hooks
export const api = createClient(import.meta.env.VITE_API_URL);

// Declarative client — for React components with TanStack Query
export const $api = createQueryClient(import.meta.env.VITE_API_URL);
```

### Declarative (recommended for components)

```typescript
function Departments() {
  const { data, isLoading } = $api.useQuery("get", "/api/public/departments");
  return <ul>{data?.map(d => <li key={d.id}>{d.name}</li>)}</ul>;
}

function SubmitApplication() {
  const mutation = $api.useMutation("post", "/api/applications");
  return <button onClick={() => mutation.mutate({ body: { ... } })}>Apply</button>;
}
```

### Imperative (for loaders or custom logic)

```typescript
async function loadDepartments() {
  const { data, error } = await api.GET("/api/public/departments");
  if (error) throw error;
  return data;
}
```

Both are fully typed — path autocomplete, request body types, response types, all inferred from the OpenAPI spec.

## Turbo Pipeline

```
apps/server#api:spec → packages/sdk#generate → packages/sdk#build → apps/*#build
```

| Task | Command | Cache | Notes |
|------|---------|-------|-------|
| `api:spec` | `php bin/console api:openapi:export --output=../../packages/sdk/openapi.json` | No | Requires PHP + vendor/ |
| `generate` | `openapi-typescript openapi.json -o generated/api.d.ts` | By openapi.json hash | Pure codegen |
| `build` | `tsc -b` | Standard | Depends on generate |

**Day-to-day TS work** uses the committed `openapi.json` — no PHP needed. Re-export only when API changes.

**CI check** (future): compare committed `openapi.json` against fresh export, fail if they differ.

## Dependencies

### packages/sdk

| Dependency | Type | Purpose |
|-----------|------|---------|
| `openapi-fetch` | runtime | 1kb type-safe fetch wrapper |
| `openapi-react-query` | runtime | Declarative TanStack Query integration |
| `openapi-typescript` | dev | CLI codegen (spec → types) |
| `@tanstack/react-query` | peer | Apps provide their own version |

### Apps add

- `@monoweb/sdk: workspace:*`
- `@tanstack/react-query` (own version)
- `VITE_API_URL` env var pointing at the server

## Auth

JWT token passed via middleware on the fetch client:

```typescript
const api = createClient(baseUrl, {
  headers: { Authorization: `Bearer ${token}` },
});
```

Or dynamically via openapi-fetch middleware for token refresh patterns.

## Migration Path

When the TS api replaces a Symfony endpoint:
1. The TS api serves the same OpenAPI path with the same schema
2. Re-export the spec (now from TS api instead of Symfony)
3. Regenerate types
4. Consumer code unchanged — same paths, same types

The SDK is the abstraction boundary. Apps never know which backend serves the data.

## Decisions

| Decision | Rationale |
|----------|-----------|
| `openapi-typescript` + `openapi-fetch` | Most popular (2.5M/wk), types-only codegen, minimal surface area |
| `openapi-react-query` for declarative layer | Same ecosystem, 1kb wrapper, zero-maintenance hooks |
| Both imperative + declarative exported | Let devs choose; no lock-in to one pattern |
| Committed spec + types | TS devs never need PHP; freshness enforced by CI |
| CLI export (not runtime fetch) | No running server needed; works in CI without MySQL |
| Peer dep on @tanstack/react-query | Apps control their own version |
