# Live design spec 0003 — Effect v4 Receipt SDK compatibility

> **Summary:** One SDK-only maintainer journey that migrates the real `mono-web/packages/sdk` implementation to the exact Effect `4.0.0-beta.107` boundary and proves an authenticated, deterministic Receipt trace. It preserves both existing SDK entrypoints and domain verbs, fails closed before transport when configuration is absent or invalid, proves strict Hydra/Receipt decoding, preserves typed HTTP/network errors, and proves Effect interruption aborts the underlying fetch. This is not a disposable shipped probe, a backend/consumer migration, a route cutover, or a production-success claim.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0003` |
| Status | `accepted` — product lead accepted after independent review on `2026-08-10` |
| Owner | SDK platform lane / future bounded writer |
| Intended implementation lane | Stage-1 SDK platform — Effect v4 compatibility and Receipt tracer |
| Created | `2026-08-10` |
| Base checkpoint | `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` (`mono-web` canonical main checkpoint) |
| Journey count | One maintainer journey; one future implementation PR |

This accepted spec was authored from a separate manual worktree. It has no implementation, install, build, test, provider, publication, or consumer evidence. Implementation has not started. Status records independent review and explicit product-lead acceptance under the lifecycle; the product lead remains read-only to production code.

## Goal, constraints, and values

### Goal

Give an SDK maintainer a repeatable, local, no-backend journey that changes the actual SDK implementation from Effect 3 to exact Effect `4.0.0-beta.107` while preserving the current client contract. The journey must exercise the existing default Promise entrypoint (`@vektorprogrammet/sdk`, export `"."`) and Effect entrypoint (`@vektorprogrammet/sdk/effect`, export `"./effect"`) through one deterministic Receipt fixture:

```text
explicit base URL + Bearer token
  → admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })
  → GET /api/admin/receipts?... with Hydra JSON
  → strict Schema boundary
  → current Page-compatible value + AdminReceipt values + Date fields
  → admin.receipts.approve(id)
  → PUT /api/admin/receipts/{id}/status { status: "refunded" }
  → 204
  → void
```

The same tracer also demonstrates the fail-closed configuration boundary, malformed-input rejection, existing typed error mapping, and cancellation ownership. It proves SDK behavior against a local fixture only; it does not prove that Symfony, a future Worker, MySQL, a route, an app, or production accepts the request.

### Constraints

- **Exact beta boundary.** The implementation MUST pin `effect` to the exact version `4.0.0-beta.107`, not `^4`, `beta`, `latest`, a snapshot, or a copied source signature. The official npm registry metadata observed on `2026-08-10` reports the `beta` dist-tag as `4.0.0-beta.107` and `latest` as stable `3.22.1`. The capability reference observed upstream `main` at beta.106 on the same date; that older observation is stale for this lane and is not permission to use beta.106.
- **Fresh source/signature gate.** At implementation start, re-fetch the official registry manifest and official package source/types for the pinned beta before editing SDK code. Verify the package name/version, tarball integrity, shasum, registry signatures, and provenance/attestation; inspect the installed source for every v4 API signature used by the implementation. In particular, verify the exact `Effect.tryPromise`/`Effect.promise` `AbortSignal` contract, Schema decoding entrypoint, Effect runtime/fork/interruption APIs, and any Scope/resource API actually used. Do not copy signatures from this spec or from the beta.106 capability report. If the dist-tag, manifest, signature, integrity, provenance, or inspected source differs from the pinned evidence, stop and enter `Drift` before mutation.
- **No hidden Promise cancellation.** The Effect transport MUST pass the signal supplied by the verified v4 async constructor into `fetch`. A Promise wrapper MAY call `Effect.runPromise` only at the existing default public boundary. It MUST NOT turn the Effect client into a Promise or abandon an underlying fetch when a fiber is interrupted.
- **Existing public seam.** Preserve the package export map, `createClient(baseUrl, options?)` and `createEffectClient(baseUrl, options?)` call shapes, `ClientOptions.auth` static/async behavior, namespaces, public `SdkError` classes, Schema-inferred domain values, `ClientContext`, and existing Receipt verbs (`list`, `approve`, `reject`, `reopen`, plus the non-admin Receipt methods). The additive `ConfigurationError`/`SdkErrorType` `"configuration"` safety error is the sole new public error; it is not a public API redesign.
- **Explicit configuration contract.** `apiUrl` remains exported as `string | undefined`; absent `API_URL`/`VITE_API_URL` evaluates to `undefined` without a module-evaluation throw or fallback. `createClient(baseUrl: string | undefined, options?)` and `createEffectClient(baseUrl: string | undefined, options?)` accept an absent base without synchronously throwing, and every verb remains Promise- or Effect-shaped. Missing/invalid base validation runs inside the effectful transport path: Promise verbs reject `ConfigurationError` (`SdkErrorType` `"configuration"`), Effect verbs fail with internal tagged `Configuration`, and `fetch` is never called.
- **Real SDK migration, not a shipped probe.** The tracer is a deterministic test/fixture inside the real SDK package. It is not a new package, public export, app dependency, one-off script shipped in `dist`, or disposable compatibility package. The implementation MUST keep the complete SDK source/build surface compiling; it MUST NOT narrow `tsconfig` or omit non-Receipt domains to make a Receipt test pass.
- **Local-only evidence.** The fixture replaces `globalThis.fetch` in the SDK test process and must not open a socket, contact Symfony, contact a Worker, contact Railway, contact Cloudflare/Alchemy, use credentials, read production data, or publish anything. A fixture URL is an assertion input, not a reachable service.
- **Path and resource isolation.** The future writer may mutate only `mono-web/packages/sdk/**` and the required root `mono-web/bun.lock` recording the exact dependency pin. `packages/sdk/legacy-symfony-openapi.snapshot.json` is read-only contract evidence, not an implementation target. App manifests/lockfiles, root `package.json`, server code, provider files, route manifests, and this spec are forbidden. The root lockfile is a shared resource if another lane must refresh it; schedule that edge rather than allowing concurrent lockfile edits.
- **No external authority.** No credentials, provider commands, deployment, remote state, route action, production data/action, publication, or remote PR is part of this journey. The writer reports any discovered external effect as `Drift` and stops.

### Values

- **Stable seam:** Keep client intent and public domain verbs stable while internals move from v3 to v4.
- **Fail closed:** Missing configuration is an explicit error before transport, never an implicit production destination.
- **Schema at the boundary:** Decode the external representation into current domain values; never cast malformed JSON or invent an empty Page.
- **Ownership and cancellation:** Every asynchronous operation has an owner and termination path; interruption must reach the actual fetch.
- **Evidence over implication:** A passing TypeScript build, a test-only fixture, or a deployment log proves only its named claim.
- **Reversible and local:** The journey uses synthetic data and a disposable fetch fixture; no remote cleanup or production rollback is needed.
- **Honest migration order:** Receipt-first SDK evidence prepares a later seam freeze. It does not claim backend parity, a route cutover, or a Receipt Worker.

## Current behavior and intended behavior

### Current behavior (baseline at `12c1f3e`, observed `2026-08-10`)

| Area | Current contract or defect | Evidence authority |
|---|---|---|
| Package boundary | `packages/sdk/package.json` is `@vektorprogrammet/sdk` `0.2.0`; `"."` maps to `dist/promise` and `"./effect"` maps to `dist/effect-client`. Dependencies declare `effect` `^3.21.0`, `@effect/platform` `^0.96.0`; dev tests use Vitest and declare `@effect/vitest` `^0.29.0`. | `packages/sdk/package.json` |
| Promise seam | `createClient(baseUrl, { auth? })` builds the domain object. Each domain method is wrapped with `Effect.runPromise` and maps `InternalSdkError` to public `SdkError` subclasses. | `packages/sdk/src/promise.ts` |
| Effect seam | `createEffectClient(baseUrl, { auth? })` returns the same domain namespaces with Effect-returning methods and internal tagged errors. | `packages/sdk/src/effect-client.ts` |
| Transport | `transport.ts` uses `Effect.tryPromise` around `fetch`, but calls `fetch(url, init)` without a signal. Status mapping covers 401/403, 404, 409, 422, 429, and other/network failures. JSON responses are decoded through Schema. URL construction/validation is currently synchronous and has no typed configuration error. | `packages/sdk/src/transport.ts`, `src/errors.ts` |
| Collection boundary | `getCollection` casts `hydra:member` to an array and defaults a missing member collection to `[]` and `hydra:totalItems` to `0`. Malformed collection shape can therefore become an apparently valid empty Page. | `packages/sdk/src/transport.ts` |
| Receipt values | `AdminReceipt` requires `id`, `visualId`, `description`, `sum`, ISO-derived `receiptDate`/`submitDate`, status, nullable `refundDate`, and `userName`. Page-compatible values carry `items`, `totalItems`, `page`, and `pageSize`; the declared admin-list return type currently omits the latter two fields even though runtime supplies them. `DateFromIso` constructs `Date` without an explicit invalid-date guard. | `packages/sdk/src/schemas/receipt.ts`, `src/schemas/common.ts`, `src/adapter/dates.ts` |
| Receipt commands | Admin list calls `GET /api/admin/receipts` with `status`, `page`, and `itemsPerPage` query values. `approve` calls `PUT /api/admin/receipts/{id}/status` with `{ status: "refunded" }`; `reject` and `reopen` use the existing status strings. | `packages/sdk/src/domains/admin/receipts.ts` |
| Configuration | `src/config.ts` checks `process.env.API_URL`, `import.meta.env.VITE_API_URL`, then the hard-coded `https://vektorprogrammet-production.up.railway.app`; the exported value is currently typed as `string`. | `packages/sdk/src/config.ts`; ADR 0001 §§2, 4, 14 |
| Existing tests | Transport tests cover successful decode, 401/404/422/network tags, static Bearer auth, and per-request async auth. They do not prove strict Hydra rejection, 204 void behavior, fail-closed configuration, or interruption/abort. | `packages/sdk/src/__tests__/transport.test.ts` |
| Repository drift | Homepage/dashboard manifests and imports still contain stale published SDK/OpenAPI consumers, and the root lockfile contains Effect 3. These downstream artifacts are not compatible evidence for this SDK-only lane. | Scout report; app manifests/imports; root `bun.lock` |

### Intended behavior

After a bounded writer realizes accepted intent:

1. The SDK package manifest and **root `bun.lock`** resolve exactly `effect@4.0.0-beta.107`; the root lock update is required, not optional. `@effect/platform` has no v4 release and is unused, so it is removed. `@effect/vitest` has a beta.107-compatible release with current Vitest `>=4.1` but is unused, so it is removed unless a fresh source check proves it is required. No v3 Effect package is retained to mask incompatibility.
2. Every existing SDK source module, not only Receipt modules, compiles against the verified v4 APIs. The `"."` and `"./effect"` export map stays intact, and public namespaces/domain verbs remain available with their current call/return/error shapes. `admin.receipts.list` receives an additive type correction to the existing runtime Page-compatible `{ items, totalItems, page, pageSize }` shape; runtime and call shape do not change.
3. `apiUrl` remains exported as `string | undefined`; with both supported API URL inputs absent it is exactly `undefined`, and importing the module (including built output) does not throw or select Railway. `createClient(undefined)` and `createEffectClient(undefined)` return clients without synchronously throwing.
4. When a Promise verb runs with an absent or invalid base, its operation rejects `ConfigurationError` with `SdkErrorType` `"configuration"`; when an Effect verb runs with that base, its operation fails with internal tagged `Configuration`. Both failures occur inside the effectful transport path before `fetch`, with zero fixture calls and no Railway URL.
5. The Promise client sends an authenticated list request with the exact URL `https://receipt-fixture.invalid/api/admin/receipts?status=pending&page=1&itemsPerPage=2` (or an equivalent URL with only semantically equivalent encoding/order), `Accept: application/ld+json`, and `Authorization: Bearer trace-token`. The Hydra response decodes into `Page<AdminReceipt>` with one item, numeric `totalItems`, requested page/page size, and JavaScript `Date` values.
6. The Effect client returns an actual Effect value before execution (`Effect.isEffect(...)` is true under the verified v4 source). Running it through the fixture produces the same typed `Page<AdminReceipt>` contract; it is not a Promise hidden behind a type annotation.
7. `admin.receipts.approve(42)` sends the authenticated `PUT /api/admin/receipts/42/status` request with JSON body `{ "status": "refunded" }`. Lowercase `refunded` is the wire representation of the domain model's canonical `Pending → Refunded` transition. A fixture `204` response resolves the Promise client to `undefined`/`void` and does not attempt `response.json()`; the Effect client keeps the corresponding `Effect<void, InternalSdkError>` contract.
8. A malformed Hydra envelope or malformed Receipt member fails at the Schema boundary with the existing typed validation surface. It never becomes an empty Page, a partially populated `AdminReceipt`, or a value passed to a consumer. The Promise surface maps the internal validation tag to `ValidationError`; the Effect surface retains the internal tagged validation error. Unparsable ISO dates are rejected by the tightened date adapter.
9. Existing typed HTTP/network mappings remain observable for the current status/error matrix: 401/403 → `UnauthorizedError`/`Unauthorized`, 404 → `NotFoundError`/`NotFound`, 409 → `ConflictError`/`Conflict`, 422 violations → `ValidationError`/`Validation` with fields, 429 → `RateLimitedError`/`RateLimited`, other HTTP statuses → `NetworkError`/`Network`, and rejected fetch → `NetworkError`/`Network`. Missing/invalid base maps to `ConfigurationError`/`Configuration`. Static and per-request async Bearer auth remain intact.
10. A deliberately slow, abort-aware fixture fetch receives the Effect-provided `AbortSignal`. Starting the Effect request in an owned fiber and interrupting that fiber aborts the signal, rejects/settles the fixture, leaves zero active owned request work, and produces an interruption observation rather than a successful Receipt or a Promise-only wrapper that hides a still-running fetch. No detached child fiber, timer, listener, or completion callback survives the owner.
11. The complete SDK package build and public export checks pass. The implementation cannot pass by compiling only the Receipt tracer or by deleting/omitting unrelated domain source. No app, backend, OpenAPI, route, Cloudflare, Alchemy, publication, or consumer success claim is made.

## Exact maintainer journey

One SDK maintainer starts from a clean worktree at the accepted base and completes this one local journey. The future writer records sanitized command output in the one-to-one PR evidence section; this draft does not create an evidence file.

### 1. Freeze the v4 source boundary before editing

1. Confirm the worktree is a new manual worktree based on `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d`, with no unrelated changes. Record the worktree and branch in the task handoff.
2. With no credentials, production data, provider profile, or remote action, retrieve the official npm metadata for `effect@4.0.0-beta.107` and the current `beta`/`latest` dist-tags. Verify:
   - package name `effect` and version `4.0.0-beta.107`;
   - tarball `https://registry.npmjs.org/effect/-/effect-4.0.0-beta.107.tgz`;
   - registry `dist.integrity` and `dist.shasum` match the fresh response;
   - registry signatures and the SLSA provenance attestation are present and match the fresh response;
   - the official package manifest has `publishConfig.provenance: true` and the expected source repository.
3. Inspect the exact installed beta source/types before writing adapters. At minimum capture the signatures/behavior for `Effect.tryPromise`/`Effect.promise`, `Effect.isEffect`, the selected Schema decoder/transformation API, `Effect.runFork`/`Fiber.interrupt` (or the verified equivalent), and any resource/finalizer primitive. The official beta.107 source currently documents an `AbortSignal` argument for `tryPromise`; this is a source-check target, not a license to skip the fresh check.
4. If the registry metadata or source differs, if beta.107 is unavailable, if the package manager resolves another Effect version, or if the signal/Schema/interruption contract cannot support the required journey, stop before SDK mutation and enter `Drift`. Do not substitute beta.106, stable v3, a guessed signature, a custom Promise cancellation layer, or a disposable probe package.

### 2. Pin and migrate the real SDK boundary

1. Change only the allowed SDK package paths and the required root lockfile. Pin `effect` exactly to `4.0.0-beta.107`; remove unused `@effect/platform` (no v4 release) and unused `@effect/vitest` (a beta.107-compatible release exists for current Vitest `>=4.1`, but the SDK tests do not use it) unless a fresh source check proves an exact compatible package is required. Do not touch app manifests or their pnpm lockfiles. Run ordinary `bun install` to refresh the required root `bun.lock`, inspect the exact beta resolution, then run `bun install --frozen-lockfile` as the reproducibility gate before build or tests.
2. Adapt existing SDK modules to the verified v4 API without changing public names or namespaces. Keep the transport's typed status/error mapping and dynamic auth behavior. Validate an absent/invalid base inside the effectful transport path and map it to internal `Configuration`/public `ConfigurationError`; do not synchronously throw from either client factory. Use the signal-bearing v4 async constructor for every fetch, pass its signal to `fetch`, and preserve interruption rather than converting it into a normal success or silently detached rejection.
3. Replace cast/default Hydra parsing with a strict boundary schema that requires an array `hydra:member`, validates every `AdminReceipt`, and validates any present `hydra:totalItems` as numeric. Preserve the current Page-compatible runtime fields and page parameter behavior, and correct the admin-list declaration to `Page<AdminReceipt>` without changing runtime/call shape. Do not change `packages/sdk/legacy-symfony-openapi.snapshot.json`; it is a read-only Symfony contract reference.
4. Tighten `DateFromIso` and `NullableDateFromIso` so unparsable dates (including `Invalid Date`) reject at the boundary; retain an explicit invalid-date fixture case. Remove the Railway fallback; `apiUrl` remains an exported `string | undefined` and absent env resolves to `undefined` without a module-evaluation throw. Do not add a new public factory or silently change any other public behavior.
5. Keep the tracer in SDK tests (for example, a new `packages/sdk/src/__tests__/receipt-effect-v4-compatibility.test.ts`) and keep it local/deterministic. It must not become a shipped export, a package, or a consumer dependency.

### 3. Run the deterministic Receipt tracer

Use a fixture base URL such as `https://receipt-fixture.invalid` and stub `globalThis.fetch`; do not open a real network socket. The fixture must route requests by method and URL and record `RequestInit` without storing credentials or real data.

1. **Public surface guard.** Construct both client entrypoints with the valid fixture URL and token. Assert the existing top-level and nested namespaces and all existing domain verbs are present. Assert the Promise method returns a Promise-like value and the Effect method returns an actual Effect value. This guard covers the complete SDK surface while the observable journey remains Receipt-first.
2. **Direct `apiUrl` absence.** With `API_URL` and `VITE_API_URL` absent, read the exported `apiUrl` value and assert it is exactly `undefined`. Assert module evaluation does not throw, no `DEFAULT_API_URL`/Railway value exists, and the direct value assertion does not invoke `fetch`. Repeat this assertion against built output in step 9; this is a value/export check, separate from invoking a client verb.
3. **Client-operation configuration failure.** Construct `createClient(undefined)` and `createEffectClient(undefined)` without a synchronous throw. Invoke one existing Receipt verb through each client and assert the Promise-shaped operation rejects `ConfigurationError` with `type === "configuration"` while the Effect-shaped operation fails with internal `_tag === "Configuration"`. Repeat with an invalid explicit URL. Assert zero fixture calls and no request URL equal to Railway.
4. **Authenticated Hydra list.** Return one valid pending admin receipt for the exact list URL. Through the default Promise client, call `admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })` and assert the result is typed/structurally `Page<AdminReceipt>` with `items`, `totalItems`, `page`, and `pageSize`. Assert the URL/query, `Authorization: Bearer trace-token`, response `Accept`, every `AdminReceipt` field, `status === "pending"`, positive `sum`, and `Date` instances/values for the ISO date fields. Repeat the same fixture through the Effect client and assert direct Effect construction plus the same typed result.
5. **Approve to refunded, 204 to void.** Return a response whose status is exactly `204` and whose `json()` method throws if called. Call `admin.receipts.approve(42)` through the Promise client. Assert method, exact path, Bearer auth, JSON body `{ status: "refunded" }`, no response-body parse, and resolved `undefined`. Run the Effect command as a direct Effect as well and assert `void` success. The fixture demonstrates the client command/wire contract only; it does not claim a server-side refund.
6. **Malformed boundary and invalid date.** Return HTTP 200 with a malformed `hydra:member` (wrong type or missing required member), a separate HTTP 200 with a member missing a required `AdminReceipt` field such as `userName`, and a separate member with an unparsable ISO date. Assert both clients fail with typed validation before any Page/AdminReceipt value is observed. A malformed collection MUST NOT default to `[]` or `0`.
7. **Typed failure matrix.** For deterministic fixture responses, exercise 401, 403, 404, 409, 422 with a Symfony-style `violations` body, 429, and another HTTP status (for example 500). Exercise a fetch rejection (`TypeError("Failed to fetch")`) and the absent/invalid-base `Configuration` cases. Assert the existing Promise error classes plus `ConfigurationError`, the corresponding `SdkErrorType` values, and the corresponding Effect internal tags/fields. Assert an async auth function is evaluated per request and its Bearer value is never logged or persisted.
8. **Interruption and release.** Install a slow fixture fetch that records the received signal, increments `activeRequests`, and waits for abort; on abort it decrements `activeRequests`, records the abort, and rejects with an abort error without scheduling completion. Run the Effect list request in one owned fiber, wait until fetch has started, interrupt that fiber using the verified v4 API, and await owner termination. Assert `signal.aborted`, one abort observation, `activeRequests === 0`, no completion/Receipt result, no owned fiber/timer/listener remains, and an interruption cause/outcome rather than a successful value. If the implementation only abandons the Effect while the fixture remains active, this step fails.
9. **Package-wide build/export proof.** The ordinary `bun install` and subsequent `bun install --frozen-lockfile` from step 1 must have completed before these commands:

   ```sh
   bun --cwd=packages/sdk run build
   bun --cwd=packages/sdk run test
   ```

   These commands MUST compile and test every SDK source module, not a Receipt-only compiler or filtered test. Verify the package export map still resolves `"."` and `"./effect"`, declarations include the existing public names, the public surface guard passes, and built output exports `apiUrl === undefined` without module-evaluation throw when both API URL env inputs are absent. Do not claim the stale homepage/dashboard/server builds pass; their manifests/imports are a separate downstream lane.


## Scope and allowed implementation paths

The future bounded writer may mutate only:

- `mono-web/packages/sdk/package.json`;
- `mono-web/packages/sdk/tsconfig.json` only if the verified v4 compiler boundary requires a minimal compatible setting; it MUST NOT be narrowed to omit unrelated SDK modules.
- `mono-web/packages/sdk/src/**`, including existing transport/config/domain/schema/error files and new or updated SDK tests under `src/__tests__/**`;
- root `mono-web/bun.lock` (required) to record the exact `effect@4.0.0-beta.107` resolution and its verified integrity.

The writer MUST NOT edit `mono-web/packages/sdk/legacy-symfony-openapi.snapshot.json`; `dist/**`, caches, logs, and other generated local state are disposable and never evidence or committed source. The writer MUST NOT edit any app/server source, app manifest or pnpm lockfile, root `package.json`, `turbo.json`, workflows, docs, ADRs, domain files, provider/IaC files, route manifests, or this live spec. The root `bun.lock` is a required shared resource for this lane: the single writer owns its refresh, and any other lane touching it is serialized before mutation. No writer resolves that conflict by rebasing or overwriting the other's changes.

## Non-goals

This slice does **not** include:

- homepage, dashboard, server, Symfony, MySQL, Hyperdrive, Worker, gateway, OpenAPI generation, app manifests, app lockfiles, stale `apiClient`/`QueryProvider` import cleanup, or raw-fetch cleanup;
- backend or consumer migration, route cutover, route rollback, frontend build success, SSR success, browser journey success, or a claim that any real API accepts the request;
- Cloudflare, Alchemy, Wrangler, provider accounts, provider commands, remote state, deployment, public routes, DNS, production data, production credentials, or external actions;
- package publication, release, Changesets, version publication, remote PR opening, or public API redesign;
- a new SDK package, compatibility probe package, shipped tracer, new public entrypoint, new transport owner, or a hidden Promise-only wrapper around the Effect path;
- changing Receipt domain laws, implementing a Receipt Worker, selecting persistence, migrating photos, proving temporal/backend conformance, or claiming refund durability;
- broad migration of consumers merely because their current manifests/imports are stale. Those artifacts remain separate downstream risk and cannot satisfy or block this SDK-only contract except as documented below.

## Authority, domain, contract, and interface references

- **Lifecycle authority:** [`docs/agentic-development-lifecycle.md`](../../docs/agentic-development-lifecycle.md) §§2, 4–6, 8–12 owns one-home authority, status/gates, one-journey specs, task capsules, disjoint resources, evidence limits, Drift, and operator boundaries. Its API/SDK evidence row proves only named SDK/transport cases; it does not prove a UI, backend, deployment, or domain journey.
- **Program authority:** [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md) §§1–5, 9–12 keeps `mono-web` canonical, the SDK as the seam, Receipt first, Effect v4 compatibility as a parallel Stage-1 platform lane, Symfony parity as the first production target, and the product lead read-only.
- **Accepted topology authority:** [`docs/decisions/0001-cloudflare-topology-and-migration-architecture.md`](../../docs/decisions/0001-cloudflare-topology-and-migration-architecture.md) §§2, 4, 7, 9, 12, 14–15 requires explicit/fail-closed SDK base configuration, keeps Symfony/MySQL authoritative during parity, separates SDK evidence from backend/preview evidence, and forbids inferring provider/runtime success from this fixture.
- **Domain authority:** [`docs/domain-model.md`](../../docs/domain-model.md) §2.5 Receipt machine and laws `T-REC-1`, `S-REC-1`, `S-REC-2`. The tracer uses a pending receipt and the legal approve command shape (`Pending → Refunded`) as a client-contract fixture. Lowercase wire status `refunded` is the transport representation of canonical `Refunded`; the fixture tests only that wire value. It does not prove the backend transition, photo requirement, submit-date immutability, or visual-ID uniqueness.
- **Effect capability boundary:** [`docs/references/effect-v4-capability-evaluation.md`](../../docs/references/effect-v4-capability-evaluation.md) §§2, 7–11 recommends pinning beta APIs, inspecting official source at implementation start, using Schema as an external boundary, and requiring fiber/Scope ownership and interruption evidence. Its beta.106 observation is superseded for this lane by the fresh beta.107 registry check required above.
- **Current SDK sources:** `packages/sdk/package.json`; `src/index.ts`; `src/promise.ts`; `src/effect-client.ts`; `src/transport.ts`; `src/config.ts`; `src/errors.ts`; `src/adapter/dates.ts`; `src/schemas/common.ts`; `src/schemas/receipt.ts`; `src/domains/receipts.ts`; `src/domains/admin/receipts.ts`; `src/__tests__/transport.test.ts`; and `packages/sdk/legacy-symfony-openapi.snapshot.json` Receipt paths around `/api/admin/receipts` and `/api/admin/receipts/{id}/status`.
- **Official v4 provenance/source inputs:** [npm dist-tags](https://registry.npmjs.org/effect), [exact beta.107 registry manifest](https://registry.npmjs.org/effect/4.0.0-beta.107), [beta.107 package manifest](https://unpkg.com/effect@4.0.0-beta.107/package.json), [official Effect v4 beta notice](https://effect.website/blog/releases/effect/40-beta/), and the exact installed source files/types selected by the implementation. Registry metadata observed for the starting checkpoint reports shasum `6f928025031c3f137c66a8a4f3f11bdc72804c83`, integrity `sha512-OoBAv8eF+yanc+C6xhgEUnWeXUSHA6ynnscYqpkAY9GSnzZWystsIjBowVqCkLpHGlnRtdIqYT3wHwpOY6JDnQ==`, two registry signatures under key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`, and an npm SLSA attestation URL. These values MUST be freshly checked; they are not a substitute for implementation-time verification.

## Dependency and resource graph

```text
accepted ADR 0001 + accepted local-preview authority
  → this spec independently reviewed and product-lead accepted
  → fresh beta.107 registry/signature/source check
  → one SDK writer in an isolated worktree
  → exact `effect@4.0.0-beta.107` + required root lock entry
  → full packages/sdk build and tests
  → deterministic Receipt tracer and interruption evidence
  → stable SDK seam candidate
  → later consumer/Receipt Worker lanes (separately specified)
```

| Graph item | Required shape | Boundary |
|---|---|---|
| Effect package | `effect@4.0.0-beta.107` exact, with fresh registry integrity/signature/provenance evidence | No beta range, stable v3 fallback, snapshot, or copied source. |
| Platform dependency | `@effect/platform` has no v4 release and is unused by the current SDK; remove it. `@effect/vitest` has a beta.107-compatible release for current Vitest `>=4.1` but is unused; remove it unless fresh source proves it required. | No v3 dependency is added to mask v4 breakage. |
| Config | `apiUrl: string | undefined`; absent env is `undefined` with no module throw/fallback. Factories accept `string | undefined`; verb execution validates inside Effect and maps `Configuration` → public `ConfigurationError`/`SdkErrorType` `"configuration"` before fetch. | No Railway fallback, sync throw, hostname inference, provider action, or production access. |
| Transport | Signal-bearing v4 async constructor → `fetch(url, { signal, ... })` → typed status/config mapping → strict Schema decode | No uncancelled Promise, detached fiber, cast/default Hydra envelope, or public transport redesign. |
| Promise surface | Existing `"."` export and `createClient` return shape, plus additive `ConfigurationError` | `Effect.runPromise` only at the existing public boundary; existing public errors and every verb remain Promise-shaped. |
| Effect surface | Existing `"./effect"` export and `createEffectClient` return shape, plus internal `Configuration` | Direct Effect values and internal tagged errors; no Promise hiding or sync factory throw. |
| Fixture | One in-process deterministic fetch fixture and synthetic payloads | No sockets, backend, provider, credentials, production data, or publication. |
| Lockfile | Root `bun.lock` required and refreshed by ordinary `bun install`, then checked by `bun install --frozen-lockfile` | Shared lockfile custody is serialized to this lane's single writer. |

### Exact fixture values

The happy-path list fixture SHOULD use one member with values equivalent to:

```json
{
  "hydra:member": [
    {
      "id": 42,
      "visualId": "receipt-42",
      "description": "Travel to course",
      "sum": 125.5,
      "receiptDate": "2026-08-08",
      "submitDate": "2026-08-09T10:00:00Z",
      "status": "pending",
      "refundDate": null,
      "userName": "Synthetic User"
    }
  ],
  "hydra:totalItems": 1
}
```

The fixture uses the synthetic Bearer value `trace-token` only in memory. It must not write a token or payload into logs/evidence. The approve fixture accepts only the exact path/body and returns a bodyless `204`; its response `json()` throws to catch accidental parsing.

## Verification and evidence plan

Every evidence item names one claim and one boundary. The future writer MUST run all applicable checks after the fresh source gate and record sanitized output in the one-to-one PR/handoff. No command in this draft has been run.

| ID | Evidence/scenario | Required observation | What it proves | What it does not prove |
|---|---|---|---|---|
| E0 | Official metadata/source check | beta dist-tag/version, exact manifest, integrity/shasum/signatures/provenance, and inspected v4 signatures match `4.0.0-beta.107` | The writer used the intended source boundary | Future beta stability, backend behavior, or provider/runtime behavior |
| E1 | Package manifest/lock inspection | Exact Effect pin; no v3 peer selected for SDK; required root lock contains the verified resolution and integrity | Dependency provenance and reproducibility | App lockfile compatibility or monorepo clean build |
| E2 | Full SDK build + declaration/export check | Every SDK source module builds; `"."` and `"./effect"` resolve; current public names remain | Package-wide compilation and public seam preservation | App/SSR/backend build or runtime |
| E3 | Promise authenticated list | Exact fixture URL/query, Bearer header, Hydra decode, `Page<AdminReceipt>`-typed Page-compatible value, AdminReceipt fields, Date values | Promise SDK observable Receipt contract | Symfony/API Platform or user UI success |
| E4 | Effect authenticated list | `Effect.isEffect` before run; same decoded output after run | Direct Effect seam and v4 execution | Promise cancellation or backend success |
| E5 | Promise approve 204 | PUT path/body/auth, no JSON parse, `undefined` result | Existing command/void contract | Refund persistence or transition authorization |
| E6 | Effect approve 204 | Direct Effect<void> and successful 204 interpretation | Effect command contract | Worker/backend transition |
| E7 | Malformed boundary + invalid date | Strict Hydra/member/date rejection before Page/AdminReceipt observation; no empty-page fallback | Boundary validation and schema/date safety | Backend serialization or domain-law conformance |
| E8 | HTTP/network/config matrix | Existing public error classes/types and internal tags/fields for 401/403/404/409/422/429/other/network plus `ConfigurationError`/`Configuration` for missing/invalid base | Error compatibility and fail-closed operation boundary | Unlisted status semantics, retries, or app configuration |
| E9 | Direct `apiUrl` absence + built output | Exported `apiUrl` is exactly `undefined` with absent env; source and built module evaluation do not throw/fallback and do not call fetch | Configuration value/export safety | Client verb execution (covered separately by E8) |
| E10 | Slow interruption | Signal aborted, active count zero, no completion/owned work after owner termination | Underlying fetch cancellation and structured ownership | Process crash safety or remote cancellation |
| E11 | Scope review | Only allowed SDK paths plus the required root lockfile changed | Capsule/resource discipline | Correctness of forbidden paths not touched in another branch |

### Evidence boundary

This evidence proves only the exact v4 package boundary, SDK compilation/export surface, local Promise/Effect Receipt transport behavior, schema/error behavior, fail-closed configuration, and local interruption ownership observed in the deterministic fixture. It does **not** prove:

- Symfony parity, API Platform serialization, backend authorization, Receipt state persistence, `T-REC-1` execution, `S-REC-1` photo/date invariants, `S-REC-2` visual-ID uniqueness, or a future Receipt Worker;
- homepage/dashboard buildability, app manifests/imports, SSR/browser behavior, React Router behavior, stale OpenAPI consumers, or raw-fetch removal;
- Cloudflare/Alchemy/Wrangler resources, provider access, deployment, route ownership, public exposure, production data, or production credentials;
- performance, availability, retries, distributed coordination, durable storage, publication, release readiness, or route rollback.

## Risks, falsifiers, and definition of done

### Known risks and conflicts

| Risk/baseline | Treatment |
|---|---|
| Capability reference records beta.106 while official dist-tag now reports beta.107. | Pin beta.107 and require fresh official metadata/source/signature verification before implementation. Any mismatch enters `Drift`. |
| Current SDK uses v3 `Schema` and Effect APIs, has no fetch signal, and uses permissive Hydra casts/defaults. | Migrate the real source at those boundaries; strict fixture cases and package-wide build are mandatory. Do not copy v3 signatures or wrap an uncancelled Promise. |
| `@effect/platform` has no v4 release and is unused; `@effect/vitest` has a beta.107-compatible release for current Vitest `>=4.1` but is unused. | Remove both; retain either only if fresh source proves it is required and pin the exact compatible release. Never add v3 to force green. |
| Config currently falls back to Railway and exports a `string`. | Remove the fallback; export `apiUrl: string | undefined`; absent env is `undefined` without module throw, and verb execution maps absent/invalid base to `ConfigurationError`/`Configuration` before fetch. |
| `hydra:member` currently defaults to an empty array and `DateFromIso` does not explicitly reject invalid dates. | Require strict collection/member validation and validating date adapters; prove malformed collection, missing field, and invalid-date cases fail before consumer use. |
| `AdminReceipt` currently requires `refundDate`, while the current OpenAPI admin-list schema omits it. | Keep the strict fixture/schema in this SDK contract, record the mismatch as a backend-parity risk, and require the seam-freeze/consumer successor to reconcile it. This fixture-only lane makes no server claim. |
| Existing apps use stale SDK/OpenAPI imports and published SDK versions. | Keep them unchanged; they cannot satisfy or block this SDK-only contract. A later consumer lane owns reconciliation. |
| Root `bun.lock` is required and a possible shared mutable resource. | The single writer owns ordinary refresh plus frozen verification; serialize any sibling lane before lockfile mutation. Never overwrite a sibling lane. |

### Falsifiers

Any of the following fails this slice, even if the happy-path list test passes:

- beta.106, stable v3, a range, snapshot, unverified tarball, mismatched integrity/signature/provenance, or a copied/guessed v4 signature is used;
- the implementation proceeds after an official-source/signature mismatch without entering `Drift`;
- any SDK module is excluded, `tsconfig` is narrowed, or the full SDK build/public export map is broken to make the Receipt tracer pass;
- `createClient`/`createEffectClient`, `"."`/`"./effect"`, namespaces, public error classes (including additive `ConfigurationError`), or Receipt verbs silently disappear or change shape;
- `apiUrl` is anything other than `undefined` when both API URL env inputs are absent, module evaluation throws, or the built-output assertion differs from the source assertion;
- factories synchronously throw for an absent/invalid base, a Promise verb fails to reject `ConfigurationError`/`type === "configuration"`, an Effect verb fails to return an Effect or fails with internal `_tag === "Configuration"`, or any such operation calls `fetch`/Railway;
- missing/invalid configuration normalizes to a production URL, hostname, or any actual external request;
- a list request loses the Bearer header, query values, ISO-to-Date decoding, Page fields, or required `AdminReceipt` fields;
- malformed Hydra/member data or an unparsable date is accepted, defaulted to an empty Page, cast, or exposed before validation;
- 204 command handling calls `response.json()` or resolves to a fabricated body/value instead of `void`;
- any required HTTP/network/config case maps to the wrong existing typed error/tag or loses validation fields;
- the Effect client returns a Promise, or interruption only abandons the Effect while the underlying fixture fetch remains active;
- the abort signal is not passed to fetch, the active request count remains nonzero, a completion callback fires after interruption, or a child/timer/listener survives its owner;
- a real backend/provider/production/credential/publication/route action occurs, or an app/backend/OpenAPI/raw-fetch file changes;
- evidence claims backend, UI, deployment, domain, or production success from the local fixture;
- unrelated paths or another lane's lockfile changes are included.

### Definition of done

Done means all of the following are objectively recorded by the future implementation PR:

1. Fresh official beta.107 metadata, signature, integrity, provenance, and exact source/type checks pass before SDK mutation.
2. `effect@4.0.0-beta.107` is exact in the SDK package and the required root lockfile; no v3 package is retained merely to mask the migration.
3. The full `packages/sdk` build succeeds and its existing `"."`/`"./effect"` exports, public names, namespaces, and domain verbs remain available; built `apiUrl` is `undefined` without absent-env module throw/fallback.
4. The one deterministic tracer passes direct apiUrl absence, client-operation configuration failure, authenticated Hydra list/Page<AdminReceipt>/Date decoding, approve→refunded 204→void, malformed boundary and invalid-date rejection, existing HTTP/network error mapping, and Effect interruption/abort/release scenarios.
5. Evidence records exact fixture URL/query/headers/body/statuses, sanitized output, no external network/provider/production action, and the boundaries/limitations above.
6. The path review shows only `packages/sdk/**` plus the required root `bun.lock` change; no app, backend, OpenAPI, provider, publication, or route mutation occurred.
7. No unresolved Drift linked to this spec, its accepted dependencies, or its shared lockfile remains. The feature lead freezes the spec only after the complete journey works; independent blind-first verification follows before any release gate.
## Rollout and rollback plan
### No-rollout plan

This lane produces local SDK evidence only. It does not publish the package, migrate consumers, change app manifests, freeze the SDK seam, cut over a route, or deploy a backend. A later seam-freeze/consumer successor owns explicit rollout planning, consumer reconciliation, side-by-side evidence, operator authority, and any reversible route decision. Until that successor is accepted, the canonical v3 SDK/Symfony line remains the behavioral reference; this spec cannot be used as rollout approval.

### Rollback and cleanup


- This draft itself performs no external action and needs no remote rollback.
- If the future source check, dependency resolution, package build, tracer, or cancellation proof fails, stop and record the observation in `Drift`; do not substitute another beta or broaden into app/backend work.
- Before leaving the implementation lane, restore test globals/environment, remove fixture listeners/timers, await/interrupt every owned fiber, and confirm no active local request remains. Do not write credentials, raw PII, receipt photos, or raw payloads into evidence.
- If the slice is abandoned before acceptance, discard/revert only the named SDK files and required root lockfile entry in the writer worktree. Preserve the canonical v3 branch and current Symfony route; do not publish or migrate consumers. No provider/data cleanup is permitted because none may exist.
- A rollback to the v3 branch is a compatibility rollback, not evidence that the Railway fallback is acceptable. The fallback remains a known ADR defect and must not be used for a preview or production claim.
- If a later implementation observation disagrees with this intent, link the observation and conflicting artifact, keep the lane in `Drift`, and return to `Specified` for intent change or `Building` for implementation correction under lifecycle authority.

## Dependencies, conflicts, and drift log

### Dependencies and concurrency

- **Required predecessor:** accepted Stage-0 ADR 0001 and the accepted local-preview authority. They provide topology, SDK-seam, explicit-configuration, and operator boundaries; this SDK fixture does not depend on the preview implementation branch or on a provider runtime.
- **Parallel lanes:** clean-checkout bootstrap, local-preview implementation/documentation, and team-to-department domain evidence may proceed in separate worktrees when their mutable paths remain disjoint. This lane owns SDK paths; it does not own app/server/domain/preview paths.
- **Successors:** SDK seam freeze, consumer reconciliation, and Receipt Worker work wait for this compatibility evidence plus their own accepted specs and gates. This lane does not wait for a backend implementation and cannot claim one.
- **Shared resource:** root `bun.lock` is required by this lane; the clean-bootstrap lane does not reserve it, but any later sibling touching it is serialized before mutation. Treat the lockfile as owned by this capsule while its ordinary refresh and frozen verification run. No concurrent writer may edit or overwrite it.
- **No operator authorization:** no credential, provider, remote, deployment, publication, data, route, or public action is needed or permitted.

### Drift / unresolved source questions

| ID | Observation/question | State and return path |
|---|---|---|
| `D-0003-1` | Capability reference evaluated upstream beta.106, while the official npm dist-tag now reports beta.107. | Open until the future writer re-fetches beta.107 metadata/source/signatures at implementation start. A changed dist-tag or manifest returns to `Specified`/`Drift`; beta.106 is not an allowed fallback. |
| `D-0003-2` | The exact v4 Schema decoder/transformation signatures and exact package-wide compatibility of all current v3 SDK modules must be checked against beta.107 source/types. | Open boundary question until fresh source inspection and full SDK build; a mismatch enters `Drift` and blocks the lane rather than inviting a probe package. |
| `D-0003-3` | Exact v4 cancellation observation must prove that the signal supplied to the async constructor reaches the underlying fetch and that owner interruption terminates all local work. | Open boundary question until E10. If the fixture remains active after interruption, enter `Drift` and return to `Specified` for a design correction or reject v4 for this SDK lane. |
| `D-0003-4` | `@effect/platform` has no v4 release and is unused; `@effect/vitest` has a beta.107-compatible release with current Vitest `>=4.1` but is unused. | Remove both unless fresh source proves one is required and records an exact compatible pin. Any contrary package/source fact enters `Drift`; never install v3 to force green. |
| `D-0003-5` | Removing the Railway fallback and making absent `apiUrl` explicit will expose stale app assumptions. | Deliberate downstream risk. Apps remain outside this spec; consumer lane must adapt explicitly before any seam freeze or preview. |
| `D-0003-6` | Under Bun `1.3.13`, literal `bun --cwd packages/sdk run build/test` prints usage and exits `0` without running the package scripts. | Resolved command-shape correction: verification uses `bun --cwd=packages/sdk run build` and `bun --cwd=packages/sdk run test`; this changes syntax only, not implementation, status, or intent. |

Current entry: Status is `accepted` after independent review and product-lead acceptance on `2026-08-10`; implementation has not started. An observed Bun `1.3.13` command-shape Drift is resolved by using `bun --cwd=packages/sdk run build` and `bun --cwd=packages/sdk run test`; no implementation, status, or intent change follows.
Any new disagreement among this spec, the lifecycle, charter, ADR, domain model, SDK source, official beta source, or runtime observation enters `Drift` with owner, evidence, and proposed return. The writer does not resolve authority conflicts by editing the easiest file.

## Lifecycle gates

- **Specified:** gate satisfied; this complete draft exists at the stable live-spec path with resolvable authority, dependency, contract, evidence, falsifier, and capsule sections.
- **Ready:** gate passed after independent review and explicit product-lead acceptance on `2026-08-10`; status is `accepted`. Implementation has not started.
- **Building:** only in an isolated worktree under the task capsule, with the accepted paths and boundaries above. The product lead remains read-only to production code.
- **Experienceable:** after the complete deterministic tracer, full SDK build/export proof, sanitized evidence, and one-to-one PR exist; the feature lead freezes the accepted spec as the one-to-one PR opens. A remote PR is not opened without operator authority.
- **Conforming:** a blind-first verifier receives the frozen spec, implementation, and evidence before author rationale; the author does not self-verify.
- **Release-ready / Operating:** not entered. Publication, consumer migration, route cutover, backend replacement, provider effects, and production use require later accepted specs and operator authority.

## Task capsule — future bounded writer

| Field | Capsule content |
|---|---|
| Spec ID/path | `0003`; `mono-web/design-specs/0003-effect-v4-receipt-sdk-compatibility.md` |
| Role/objective | Single writer `EffectSdkImplementer`; migrate the real SDK to exact Effect beta.107 and produce the one local Receipt tracer plus full SDK build/export, strict boundary, typed-error/configuration, fail-closed, and interruption evidence. |
| Base/worktree | Start from accepted 0003 spec branch tip `7354b3c5027631a005c0e2551460c6ce3d6af689`, whose code baseline is `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d`; use the pre-defined manual worktree `/tmp/mono-web-effect-v4-receipt-sdk-impl-20260810` on branch `mono-web-effect-v4-receipt-sdk-impl-20260810` unchanged; record the checkpoint and worktree in the handoff before mutation. |
| Allowed mutations | `mono-web/packages/sdk/package.json`; `mono-web/packages/sdk/tsconfig.json` only if the verified v4 compiler boundary requires a minimal compatible setting and it MUST NOT be narrowed; `mono-web/packages/sdk/src/**`, including existing transport/config/domain/schema/error files and new or updated SDK tests under `src/__tests__/**`; required root `mono-web/bun.lock`. `mono-web/packages/sdk/legacy-symfony-openapi.snapshot.json` remains forbidden; generated `dist`/cache/log state is disposable. |
| Root-lock custody | `EffectSdkImplementer` is the sole owner of root `bun.lock` for this capsule. Obtain the scheduler handoff before ordinary `bun install`; no sibling writer may mutate the lockfile concurrently. |
| Forbidden actions | Every app/server/domain/provider/OpenAPI/route/workflow/root-manifest path; app lockfiles; Cloudflare/Alchemy/Wrangler/provider commands; credentials, production data, remote access, deployment, publication, route cutover, consumer migration, raw-fetch cleanup, public API redesign, shipped probe package, or Promise-only cancellation workaround. |
| Dependencies/conflicts | Accepted ADR 0001 and local-preview authority; fresh official beta.107 source/signature check; required lockfile custody; SDK evidence precedes seam freeze, consumer lane, and Receipt Worker lane. Current stale app manifests/imports are separate downstream risk. |
| Context/law/interface refs | Lifecycle §§2, 4–6, 8–12; charter §§1–5 and 9–12; ADR §§2, 4, 7, 9, 12, 14–15; domain model §2.5 (`T-REC-1`, `S-REC-1`, `S-REC-2`); capability reference §§2, 7–11; current SDK sources and Receipt OpenAPI paths. |
| Exact skills | Effect v4 source/signature verification; bounded SDK/Schema/transport work; structured cancellation/resource ownership; writing and evidence discipline. Do not use a provider/deployment skill. |
| Sensitive-data policy | Synthetic fixture only; no credentials, PII, receipt photos, production payloads, provider access, or external network. Keep `trace-token` in memory and redact all evidence. |
| Verification commands/scenarios | Fresh npm metadata/source/signature/provenance check; ordinary `bun install` then `bun install --frozen-lockfile`; full `packages/sdk` build and test; public export/apiUrl guards; client configuration failure; authenticated Hydra list; approve→refunded 204→void; malformed Hydra/member and invalid date; 401/403/404/409/422/429/other/network/config mapping; owned-fiber interruption with aborted signal and zero active work; scope review. |
| Exit criteria | E0–E11 are recorded; full SDK package build/tests and public export checks pass; required root lockfile is exact; worktree is clean; no unresolved Drift linked to this spec/dependencies/lockfile remains; feature lead accepts the handoff for independent blind-first verification. |
| Evidence destination | Sanitized **Evidence** section of the future one-to-one PR. Without remote/PR authority, retain only the sanitized evidence in the branch-tip task handoff; add no repository evidence file. |
| Drift path | Stop on any falsifier or source mismatch; notify product lead; link this spec, lifecycle, charter, ADR, domain law, capability reference, and observation. Return to `Specified` for intent change or `Building` for implementation-only correction. |
| Cleanup | Restore test globals/environment; remove fixture listeners/timers; await/interrupt owned fibers; confirm zero active work; discard generated dist/cache/log state; leave no credentials or raw payloads. No remote cleanup is permitted. |
| Operator authorization | None is needed or permitted. Any external effect requires stopping and a separately recorded lifecycle-scoped operator authorization; the writer has no standing authority. |
