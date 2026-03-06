# TypeScript SDK Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `@monoweb/sdk` — a type-safe API client package generated from the Symfony API Platform OpenAPI spec.

**Architecture:** Export the OpenAPI spec from Symfony via CLI, generate TypeScript types with `openapi-typescript`, wrap with `openapi-fetch` (imperative) and `openapi-react-query` (declarative). Ship as a workspace package consumed by homepage and dashboard.

**Tech Stack:** openapi-typescript, openapi-fetch, openapi-react-query, @tanstack/react-query, Bun, Turborepo

---

### Task 1: Export the OpenAPI spec from Symfony

**Files:**
- Create: `packages/sdk/openapi.json`

**Context:** The Symfony server at `apps/server` uses API Platform 3.4 which auto-generates an OpenAPI 3.0 spec. We need PHP + composer deps installed to export it.

**Step 1: Install composer deps in apps/server**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/apps/server
composer install --no-interaction
```

Expected: vendor/ directory created, no errors.

**Step 2: Export the OpenAPI spec**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/apps/server
php bin/console api:openapi:export --output=../../packages/sdk/openapi.json
```

Expected: `packages/sdk/openapi.json` created. Verify it's valid JSON:

```bash
python3 -c "import json; d=json.load(open('../../packages/sdk/openapi.json')); print(d['info']['title'], d['info']['version'])"
```

Expected output: `Vektorprogrammet API 1.0.0`

**Step 3: Verify the spec has paths**

```bash
python3 -c "import json; d=json.load(open('/Users/nori/Projects/ntnu/vektor/v1/monoweb/packages/sdk/openapi.json')); print(f\"{len(d['paths'])} paths\")"
```

Expected: Something like `50+ paths` (the 93 endpoints map to ~50 unique paths with multiple methods).

**Step 4: Commit**

```bash
git add packages/sdk/openapi.json
git commit -m "chore: export OpenAPI spec from Symfony API Platform"
```

---

### Task 2: Create the SDK package scaffold

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/src/index.ts` (empty placeholder)
- Modify: `package.json` (root — add `packages/*` to workspaces)

**Step 1: Create package.json**

Create `packages/sdk/package.json`:

```json
{
  "name": "@monoweb/sdk",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "generate": "openapi-typescript openapi.json -o generated/api.d.ts",
    "build": "tsc -b",
    "lint": "oxlint"
  },
  "dependencies": {
    "openapi-fetch": "^0.13",
    "openapi-react-query": "^0.3"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5"
  },
  "devDependencies": {
    "openapi-typescript": "^7",
    "typescript": "^5"
  }
}
```

**Step 2: Create tsconfig.json**

Create `packages/sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "generated"]
}
```

**Step 3: Create placeholder index**

Create `packages/sdk/src/index.ts`:

```typescript
// @monoweb/sdk — auto-generated API client
// See docs/design-plans/2026-03-06-sdk-design.md
```

**Step 4: Update root workspaces**

In `/Users/nori/Projects/ntnu/vektor/v1/monoweb/package.json`, change:

```json
"workspaces": ["apps/*"]
```

to:

```json
"workspaces": ["apps/*", "packages/*"]
```

**Step 5: Install deps**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
bun install
```

Expected: resolves `openapi-fetch`, `openapi-react-query`, `openapi-typescript` without errors.

**Step 6: Commit**

```bash
git add packages/sdk/ package.json bun.lock
git commit -m "feat(sdk): scaffold @monoweb/sdk package"
```

---

### Task 3: Generate TypeScript types from the OpenAPI spec

**Files:**
- Create: `packages/sdk/generated/api.d.ts`

**Step 1: Run openapi-typescript**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/packages/sdk
npx openapi-typescript openapi.json -o generated/api.d.ts
```

Expected: `generated/api.d.ts` created with `export interface paths { ... }` containing all API routes.

**Step 2: Verify the generated types**

```bash
head -30 generated/api.d.ts
```

Expected: Should start with a comment header and contain `export interface paths {` with entries like `"/api/public/departments"`.

**Step 3: Verify TypeScript is happy**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/packages/sdk
npx tsc --noEmit
```

Expected: No errors (or only errors from the empty src/index.ts which we'll fix next task).

**Step 4: Commit**

```bash
git add packages/sdk/generated/
git commit -m "feat(sdk): generate TypeScript types from OpenAPI spec"
```

---

### Task 4: Implement the SDK client modules

**Files:**
- Create: `packages/sdk/src/client.ts`
- Create: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/src/index.ts`

**Step 1: Create the imperative client**

Create `packages/sdk/src/client.ts`:

```typescript
import createFetchClient from "openapi-fetch";
import type { paths } from "../generated/api";

export function createClient(
  baseUrl: string,
  options?: Parameters<typeof createFetchClient>[0],
) {
  return createFetchClient<paths>({ baseUrl, ...options });
}

export type ApiClient = ReturnType<typeof createClient>;
```

**Step 2: Create the declarative query client**

Create `packages/sdk/src/query.ts`:

```typescript
import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import type { paths } from "../generated/api";

export function createQueryApi(
  baseUrl: string,
  options?: Parameters<typeof createFetchClient>[0],
) {
  const fetchClient = createFetchClient<paths>({ baseUrl, ...options });
  return createQueryClient(fetchClient);
}

export type QueryApi = ReturnType<typeof createQueryApi>;
```

**Step 3: Create the barrel export**

Replace `packages/sdk/src/index.ts` with:

```typescript
export { createClient, type ApiClient } from "./client";
export { createQueryApi, type QueryApi } from "./query";
export type { paths } from "../generated/api";
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/packages/sdk
npx tsc --noEmit
```

Expected: No errors.

**Step 5: Commit**

```bash
git add packages/sdk/src/
git commit -m "feat(sdk): implement createClient and createQueryApi"
```

---

### Task 5: Add turbo pipeline tasks

**Files:**
- Modify: `turbo.json`
- Modify: `apps/server/package.json` (add api:spec script)

**Step 1: Add api:spec script to server**

In `apps/server/package.json`, add to `scripts`:

```json
"api:spec": "php bin/console api:openapi:export --output=../../packages/sdk/openapi.json"
```

**Step 2: Add generate and api:spec tasks to turbo.json**

In `turbo.json`, add to `tasks`:

```json
"api:spec": {
  "cache": false
},
"generate": {
  "dependsOn": ["^api:spec"],
  "inputs": ["openapi.json"],
  "outputs": ["generated/**"]
}
```

Also update the existing `build` task outputs to include `dist/**` (already there).

**Step 3: Verify the pipeline**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
npx turbo generate --dry-run
```

Expected: Shows `@monoweb/sdk#generate` in the task list.

**Step 4: Run the generate task**

```bash
npx turbo generate
```

Expected: Runs `openapi-typescript openapi.json -o generated/api.d.ts` successfully.

**Step 5: Commit**

```bash
git add turbo.json apps/server/package.json
git commit -m "feat(sdk): add turbo pipeline — api:spec → generate → build"
```

---

### Task 6: Verify end-to-end with a smoke test

**Files:**
- Create: `packages/sdk/src/smoke.test.ts` (temporary, delete after verification)

**Step 1: Write a quick type-level smoke test**

Create `packages/sdk/src/smoke.test.ts`:

```typescript
import { createClient, createQueryApi } from "./index";

// Type-level test: verify createClient returns a typed client
const api = createClient("http://localhost:8000");

// Verify we can call GET on a known path
// This will fail at runtime (no server) but should compile
async function _typeTest() {
  const result = await api.GET("/api/public/departments");
  // If this compiles, the types are correctly wired
  console.log(result.data, result.error);
}

// Verify createQueryApi returns something with useQuery
const $api = createQueryApi("http://localhost:8000");
// $api.useQuery, $api.useMutation should exist (React context needed at runtime)

console.log("Smoke test: types compile correctly");
```

**Step 2: Run TypeScript check**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb/packages/sdk
npx tsc --noEmit
```

Expected: No errors. This proves the full chain works: spec → types → client → consumer.

**Step 3: Delete the smoke test**

```bash
rm packages/sdk/src/smoke.test.ts
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(sdk): verify end-to-end type safety"
```

---

### Task 7: Update root configuration and clean up

**Files:**
- Modify: `.oxlintrc.json` (ignore generated files)
- Modify: `.gitignore` (optional: note about generated files)

**Step 1: Add generated files to oxlint ignore**

In `.oxlintrc.json`, update `ignorePatterns`:

```json
"ignorePatterns": ["apps/server/**", "packages/sdk/generated/**"]
```

**Step 2: Verify turbo build includes SDK**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
npx turbo build --dry-run
```

Expected: `@monoweb/sdk#build` appears in the task list.

**Step 3: Run full turbo build**

```bash
npx turbo build
```

Expected: All packages build successfully, including `@monoweb/sdk`.

**Step 4: Commit**

```bash
git add .oxlintrc.json
git commit -m "chore(sdk): ignore generated files in oxlint"
```

---

## Acceptance Criteria

1. `packages/sdk/openapi.json` contains the full Symfony API Platform spec
2. `packages/sdk/generated/api.d.ts` contains generated TypeScript types for all API paths
3. `packages/sdk/src/index.ts` exports `createClient` and `createQueryApi`
4. `npx tsc --noEmit` passes in `packages/sdk/`
5. `turbo build` includes `@monoweb/sdk` in the pipeline
6. `turbo generate` regenerates types from the spec
7. Apps can import `@monoweb/sdk` and get full type inference on API paths
