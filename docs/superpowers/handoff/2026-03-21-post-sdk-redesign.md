# Handoff: Post-SDK Redesign & Dashboard Mutations

You are picking up work on the Vektorprogrammet monorepo after a major session.
Read this, then check CLAUDE.md and MEMORY.md for full context before proposing work.

## What just happened (2026-03-21)

Four workstreams completed in a single session (~39 commits):

### 1. Dashboard Mutations (First Mutation Pattern)

Built 3 dashboard pages establishing the React Router action → SDK → API pattern:
- **Admin receipts** (`/dashboard/utlegg`) — approve/reject/reopen with confirmation dialogs
- **My receipts** (`/dashboard/mine-utlegg`) — user CRUD with file upload (multipart FormData)
- **Application review** (`/dashboard/sokere`) — computed status badges, filter tabs, interview assignment dialog

Pattern: `useFetcher` for mutations, `AlertDialog` for confirmation, status filter via URL search params.

### 2. Guard Parity Batches A-D (24 fixes)

24 of 25 items fixed across 4 batches:
- **Batch A** (10): DB constraints (unique, range), validation (date order, score range, receipt visualId)
- **Batch B** (6): Logic fixes (RoleHierarchy checks all roles, Team department fix, setCancelled no-op, department ID comparison, password reset expiry)
- **Batch C** (5): Department scoping on 4 interview processors, event dispatch in ProfileProcessor/TeamApplicationProcessor, survey edit scoping
- **Batch D** (3): ProfileResource accountNumber, AdminTeamWriteResource fields, static content htmlId lookup

B1 skipped (bug not present as described). Batch E deferred (needs architecture decisions).

### 3. SDK Redesign

Replaced openapi-fetch with a domain-first Effect-TS client:
- **Effect internals** — Schema.Class for types, Effect.gen pipelines, Schema.TaggedError for errors
- **Plain promise surface** — consumers see `createClient(url, { auth: token })` and plain async/await
- **Dual export** — `@vektorprogrammet/sdk` (promises) + `@vektorprogrammet/sdk/effect`
- **Symfony adapter** — Hydra unwrap, integer→string status mapping, date parsing, IRI extraction
- **JWT context** — `client.context.role`, `.department`, `.hasRole()` decoded at creation
- **60 tests** — transport, adapter, schemas, context, client integration
- **21 routes migrated** — all dashboard routes use new SDK, no more `as any` casts or `hydra:member` unwrapping
- **Zero external deps** beyond `effect` + `@effect/platform`

### 4. Infrastructure

- **JWT fix** — PHP 8.5 + OpenSSL 3.6 requires unencrypted PKCS#8 keys, empty `JWT_PASSPHRASE`
- **WorktreeCreate hook** — copies `.env`, `.env.local`, JWT keys to worktrees
- **SDK typecheck hook** — PostToolUse runs `tsc --noEmit` on `packages/sdk/*.ts` edits
- **Quality gates** — SDK build + test in settings.json hooks

## Current state

**All tests pass.** 64 PHP unit tests (108 assertions), 60 SDK tests. Pushed to origin/main.

## Architecture

### SDK (`packages/sdk/src/`)

```
errors.ts              — SdkError class hierarchy + Schema.TaggedError internals
transport.ts           — Effect-based fetch wrapper, auth resolution, Hydra unwrap
context.ts             — JWT decode → ClientContext (role, department, teams)
config.ts              — apiUrl, isFixtureMode
adapter/
  status.ts            — application/interview status int→string maps
  dates.ts             — DateFromIso, NullableDateFromIso Schema transforms
  iri.ts               — IRI→numeric ID extraction
  errors.ts            — API Platform violation parser
schemas/               — Schema.Class definitions per domain
domains/               — Domain method factories (auth, me, receipts, admin/*, public/*)
promise.ts             — createClient (Promise surface, promisifyDomain wrapper)
effect-client.ts       — createEffectClient (Effect surface)
index.ts               — Public exports
```

Consumer pattern:
```typescript
import { createClient } from "@vektorprogrammet/sdk"
const client = createClient(apiUrl, { auth: token })
const page = await client.admin.receipts.list({ status: "pending" })
// page: { items: AdminReceipt[], totalItems: number, page: number, pageSize: number }
await client.admin.receipts.approve(id)  // domain operation, throws SdkError on failure
```

### Dashboard mutation pattern

```typescript
// Loader: SDK call in server-side loader
export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request)
  const client = createAuthenticatedClient(token)  // from api.server.ts
  const page = await client.admin.receipts.list({ status })
  return { receipts: page.items }
}

// Action: useFetcher.submit → action → SDK call → revalidation
export async function action({ request }: Route.ActionArgs) {
  const client = createAuthenticatedClient(requireAuth(request))
  const form = await request.formData()
  await client.admin.receipts.approve(Number(form.get("receiptId")))
  return { success: true }
}
```

## Four prioritized workstreams (sequential)

Full plan: `docs/superpowers/plans/2026-03-21-remaining-workstreams.md`

### 1. Interview Scheduling UI (high complexity)

Enhance existing interview list page with schedule/reschedule/conduct dialogs.
- Backend endpoints exist (schedule, conduct, cancel)
- SDK methods exist (`client.admin.interviews.schedule/conduct/cancel`)
- Need: datetime picker, room/campus fields, reschedule cycle, score entry, bulk assign

### 2. Homepage Connection (medium)

Connect the public homepage to the SDK.
- SDK public methods exist (`client.public.departments/sponsors/fieldOfStudies`)
- Need: admission period check, application form (POST /api/applications), department content
- Gap: some public API endpoints may not exist yet in API Platform

### 3. Guard Parity Batch E (high, bounded)

6 architecture decisions:
- AUTH-2: Default-deny (needs AccessRules for all routes first)
- AUTH-6: JWT revocation (recommend short TTL + refresh)
- AUTH-7: Role hierarchy in AccessControlService
- TEAM-4: Suspended leader role retention
- DATA-6/DATA-12: FK cascade policies
- INTERVIEW-5: Response code expiry

### 4. Frontend Test Infrastructure (low-medium)

- vitest + happy-dom for dashboard
- SDK mock factory pattern
- First tests on receipt pages
- CI integration

## Key reference documents

| Document | Location | Purpose |
|----------|----------|---------|
| SDK design spec | `docs/superpowers/specs/2026-03-21-sdk-redesign-design.md` | Full SDK interface, types, error model |
| SDK architecture vision | `docs/sdk-architecture.html` | Domain-first design, adapter pattern, migration plan |
| Interface design principles | `docs/interface-design.html` | Contain and Declare — the two principles |
| Remaining workstreams plan | `docs/superpowers/plans/2026-03-21-remaining-workstreams.md` | Tasks for all 4 workstreams |
| Receipt admin spec | `docs/superpowers/specs/2026-03-21-receipt-admin-management-design.md` | First mutation pattern reference |
| Guard parity spec | `docs/superpowers/specs/2026-03-21-guard-parity-batches-design.md` | Batch E items and rationale |
| Migration dashboard | `docs/migration/dashboard.md` | 23 routes, priority order |
| State contracts | `docs/migration/contracts/` | Application, interview, receipt, membership state machines |

## Conventions

- **SDK:** Domain methods speak the ubiquitous language (`approve` not `updateStatus`). Types inferred from Schema.Class. Effect is hidden.
- **PHP:** Invoke `php-conventions` skill. Always verify fixtures after DB constraints. `dangerouslyDisableSandbox: true` for tests.
- **Dashboard:** useFetcher for mutations, AlertDialog for confirmations, Norwegian labels throughout.
- **Worktrees:** Agents commit via symlink to main repo — check main, not worktree branch. WorktreeCreate hook copies .env + JWT keys.
- **Testing:** `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/ --no-coverage` for PHP. `cd packages/sdk && bun run test` for SDK.

## How to verify

```bash
cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/ --no-coverage  # 64 tests, 108 assertions
cd packages/sdk && bun run build && bun run test                                  # 60 tests
```
