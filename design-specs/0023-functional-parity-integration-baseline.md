# Design spec 0023 — functional parity integration baseline

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0023` |
| Goal | Goal-1 functional parity integration prerequisite |
| Status | **Accepted** — frozen by the product lead on `2026-08-16`; accepted successor disposition; no implementation claim |
| Owner | Mono-web integration baseline lane |
| Current spec worktree | `/tmp/mono-web-parity-baseline-spec-0023` |
| Current spec branch | `spec/0023-functional-parity-integration-baseline` |
| Current spec base | `462691d4c31ed601fba01f8b5f21abb92a547ff9` |
| Mutable paths for this repair | `design-specs/0001-cloudflare-local-preview-spine.md`, `design-specs/0023-functional-parity-integration-baseline.md`, and outer `docs/product-lead-charter.md` only |
| Maintainer journey count | One integration maintainer journey |
| Future implementation | One bounded implementation capsule; one candidate baseline |
| Provider authority | None granted |
| Production authority | None granted |
| Acceptance authority | Product lead under [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md); accepted and frozen on `2026-08-16` |

This document freezes the first bounded integration problem. It does not implement the integration.
It does not claim functional parity, release readiness, deployment, provider access, data access, or production proof.
It grants no credential, route-cutover, database, DNS, Cloudflare, or external-effect authority.
This spec is the single active dependency-pin authority for the local checkpoint. It supersedes 0001 dependency-pin wording only; 0001 remains authoritative for local Worker behavior, HTTP behavior, compatibility date, egress controls, and stop behavior.

The future writer must start from the exact base head in this table. The writer must incorporate only the accepted local Wrangler delta and the accepted Foldkit/SDK delta named below.
The writer must review semantic conflicts against the frozen contracts before the candidate can pass.
A source commit, passing test, plan, request, browser result, or clean build proves only its named claim.

## Frozen problem

The repository has three accepted lines that were developed from one common ancestor but are not mutually ancestral:

1. The p20 preview delivery line is the integration base.
2. The local Wrangler checkpoint is an accepted independent line.
3. The Foldkit interview journey and its SDK seam are an accepted independent line.

Goal-1 creates one clean parity-candidate baseline from those lines. It does not merge or reinterpret product behavior.
It preserves one authority for each concern and rejects duplicate derivations.

The candidate is a source integration prerequisite. It is not a parity result.
The candidate does not prove that the legacy application, Symfony, the SDK, Foldkit, Cloudflare, or production have equivalent behavior.
The candidate does not authorize a provider call or a production action.

### Exact input heads and ancestry

| Input | Exact object | Parent or ancestry fact | Accepted meaning |
|---|---|---|---|
| Integration base | `462691d4c31ed601fba01f8b5f21abb92a547ff9` | `32e35c87f06d9b5189b5af33b0161640d8f46cad` is its parent | p20 preview delivery base, including the bootable Symfony container checkpoint |
| Common ancestor | `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` | Common ancestor of the three input lines | Ancestry reference only; it is not the integration base |
| Accepted local Wrangler head | `af069395e5c591c142530749ea3337476a55ac61` | Direct parent is `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` | Local `wrangler@4.120.0` raw Worker checkpoint |
| Accepted Foldkit final head | `ac316022d0c92615645986e8fe9a4c521f22b186` | Contains stage-1 SDK head `89f85239b825e3d938748d770f2fa76192d8cc2c` | Final accepted Foldkit interview implementation and SDK consumer |
| Accepted stage-1 SDK head | `89f85239b825e3d938748d770f2fa76192d8cc2c` | Direct parent is `8b2773d6cf3fb8017342ef273abb3878bf9cbe61` | Fail-closed SDK stage-1 correction included by the Foldkit final line |
| Accepted SDK start | `0b30d0ccfc994cb26900181635113fc79544bc7e` | Direct parent is the accepted SDK seam contract commit `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2` | First implementation commit in the accepted SDK/Foldkit closure |

The input heads are immutable evidence. The future writer must not move, rewrite, or replace them.
The future writer must record the result of these checks before applying a delta:

```sh
git rev-parse 462691d4c31ed601fba01f8b5f21abb92a547ff9
git rev-parse af069395e5c591c142530749ea3337476a55ac61
git rev-parse ac316022d0c92615645986e8fe9a4c521f22b186
git rev-parse 89f85239b825e3d938748d770f2fa76192d8cc2c
git merge-base 462691d4c31ed601fba01f8b5f21abb92a547ff9 af069395e5c591c142530749ea3337476a55ac61 ac316022d0c92615645986e8fe9a4c521f22b186
git merge-base --is-ancestor 462691d4c31ed601fba01f8b5f21abb92a547ff9 af069395e5c591c142530749ea3337476a55ac61
git merge-base --is-ancestor af069395e5c591c142530749ea3337476a55ac61 462691d4c31ed601fba01f8b5f21abb92a547ff9
git merge-base --is-ancestor 462691d4c31ed601fba01f8b5f21abb92a547ff9 ac316022d0c92615645986e8fe9a4c521f22b186
git merge-base --is-ancestor ac316022d0c92615645986e8fe9a4c521f22b186 462691d4c31ed601fba01f8b5f21abb92a547ff9
git merge-base --is-ancestor af069395e5c591c142530749ea3337476a55ac61 ac316022d0c92615645986e8fe9a4c521f22b186
git merge-base --is-ancestor ac316022d0c92615645986e8fe9a4c521f22b186 af069395e5c591c142530749ea3337476a55ac61
```

All six pairwise ancestry checks must report that no input head is an ancestor of another input head.
The common ancestor must resolve to `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d`.
A different object, branch tip, or merge base is `Drift` and blocks integration.

### Accepted delta closure

The future writer must apply these exact accepted closures. A diff from an arbitrary current branch is not an accepted input.

| Closure | Exact range | Paths owned by the closure |
|---|---|---|
| Wrangler closure | `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d..af069395e5c591c142530749ea3337476a55ac61` | `.gitignore`, `bun.lock`, `package.json`, `infra/preview.worker.ts` |
| Foldkit/SDK closure | `0b30d0ccfc994cb26900181635113fc79544bc7e^..ac316022d0c92615645986e8fe9a4c521f22b186`, plus the accepted final-tree safety and dashboard-graph carry-forwards; exclude the p20 host-test delta | The 37 paths in the dispatch capsule below |
The Foldkit/SDK dispatch list contains exactly 37 paths, including the shared root `bun.lock`. Combined with the four Wrangler paths, the capsule contains 40 unique paths: 39 non-lock paths and the shared `bun.lock`. The candidate changed set must remain a subset of these 40 paths; `.gitignore` is an expected no-op, so its absence from the changed set is required. Four of the 37 Foldkit/SDK paths are retained dashboard graph carry-forwards.

The Foldkit/SDK closure includes stage-1 SDK commits through `89f8523` and every accepted Foldkit commit through `ac31602`.
The accepted final tree carries the sanitized `apps/dashboard/app/mock/api/data-profile.ts` from its accepted ancestry.
The accepted final-tree dashboard graph carry-forward is pinned byte-for-byte to `ac316022d0c92615645986e8fe9a4c521f22b186` for exactly these four paths:

```text
apps/dashboard/app/root.tsx
apps/dashboard/app/entry.server.tsx
apps/dashboard/app/lib/host.ts
apps/dashboard/app/mock/api/public.ts
```

The data-profile safety path and four graph-wiring paths differ from base `462691d`; they are required to express the accepted Foldkit tree and frozen p20 production-host boundary, not to add a product journey.
The dashboard journey uses the React Router served app and the base-owned Vite configuration. No dashboard Worker is in this closure, and no dashboard Worker cutover is permitted.
The `ac316022d0c92615645986e8fe9a4c521f22b186` delta for `apps/homepage/test/host.test.ts` is intentionally not applied. The p20 base file remains restored and byte-for-byte authoritative because that delta asserts an obsolete Alchemy declaration and deletes p20 assertions.
The closure excludes unrelated changes that are reachable from a different branch or that are not in this exact range.
The base already owns the p20 preview delivery files. The future writer must not replace those files with a branch snapshot.

### Accepted successor disposition

The product lead accepted and froze this successor disposition on `2026-08-16` under the project [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md) authority.
This spec is the accepted successor disposition for [`0001`](./0001-cloudflare-local-preview-spine.md) only for its dependency pin: it revises local `wrangler@4.120.0` to the root `wrangler@4.120.1`.
It does not revise the 0001 Worker, HTTP, egress, loopback, Node-hosted, or stop behavior.
The disposition is conditional on every 0001 behavior gate passing under root Wrangler `4.120.1`.
If any 0001 behavior gate fails, the candidate enters `Drift` and integration stops; no parity, release, deployment, provider, data, or production claim is permitted.

## Authority routes

| Concern | Sole authority | Required route | Forbidden substitute |
|---|---|---|---|
| Program order and lifecycle | [`docs/agentic-development-lifecycle.md`](../../docs/agentic-development-lifecycle.md) and [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md), where available in the accepted source line | Return intent or implementation Drift through the lifecycle | A green job, branch name, or commit message as lifecycle status |
| Integration base and p20 delivery | Base `462691d4c31ed601fba01f8b5f21abb92a547ff9` and frozen [`0020`](./0020-pr-preview-delivery.md) | Preserve the exact p20 identity, trusted workflow, resource graph, route contract, seed law, and cleanup law | A branch snapshot, a local Alchemy state, a synthetic dashboard, or a new preview route |
| Local runtime checkpoint | Frozen [`0001`](./0001-cloudflare-local-preview-spine.md) and accepted head `af069395e5c591c142530749ea3337476a55ac61` | Preserve the exact loopback Worker, script, egress controls, health body, 404/405 rules, and stop proof | A cloud Worker, Alchemy, a second Worker, a frontend dev server, or a provider call |
| Foldkit product architecture | Frozen Foldkit journey and architecture files at accepted source commit `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2`: [`0021`](./0021-foldkit-control-panel-interview-scheduling.md) and [`docs/decisions/0003-foldkit-dashboard-replacement.md`](../../docs/decisions/0003-foldkit-dashboard-replacement.md) | Preserve the one interview journey, Foldkit Model/update/Command/runtime boundary, route owner, synthetic fixture, and rollback boundary | A second dashboard route owner, React state, a browser-only success branch, or a route cutover |
| SDK contract | Frozen [`0022`](./0022-dashboard-interview-capability-sdk-seam.md) at accepted source commit `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2` | Preserve the exact Cycle, branded IDs, capability boundary, Effect and Promise surfaces, typed failures, and fresh-read rule | A second SDK implementation, aliases, overloaded methods, caller-supplied grants, or raw browser transport |
| Domain law | `docs/domain-model.md` and the accepted 0021/0022 contracts | Preserve explicit `(DepartmentId, SemesterId)` Cycle, default-deny scope, pending-only acceptance, and terminal-state rejection | A legacy defect, inferred context, optimistic state, or fixture shortcut |
| Dependency and lock custody | The accepted path closure plus the frozen specs that own each version | Resolve shared manifests once and record every conflict | A hand-edited lock, incidental upgrade, duplicate package, or branch-wide lock replacement |
| Dashboard dependency graph | Accepted final Foldkit tree at `ac316022d0c92615645986e8fe9a4c521f22b186` and the product-lead disposition in this spec | Use the accepted RR8/React 19.2/Vite 8/Cloudflare Vite plugin graph | Base RR7/React 19.1/Vite 6 graph, incidental dependency upgrade, or second package graph |
| Runtime observation | The named local command, trusted contract test, SDK test, and focused browser test | Record only the result that each observation can establish | A plan as deployment evidence, a screenshot as data proof, or a passing unit test as parity proof |
| External effects | Operator authority record | Stop before any provider, credential, data, DNS, deployment, or production action | This spec, a test, or a future writer's assumption |

The accepted Foldkit and SDK specification files are read-only contract inputs.
They are not permission to add their documentation, decisions, evidence, or generated output to the candidate.
If a referenced accepted file is not present in the base tree, read it from the pinned source object and do not copy or edit it during this integration.

## Required baseline shape

The candidate has one source of truth for each accepted behavior.

### p20 trusted preview preservation

The base p20 line remains authoritative for the non-production preview contract:

- Repository `vektorprogrammet/mono-web`, pull request `21`, target `p20`, app `vektor`, and stage `p20` remain explicit.
- The canonical hostname remains `https://p20.vektor.phibkro.org`.
- The exact container identity remains `vektor-p20-container`.
- GitHub Actions remains the event and runner authority.
- Base-trusted tooling remains the only credentialed mutation path.
- Alchemy v2 and its remote CI-portable state remain the resource declaration and lifecycle authority.
- The Worker → container-backed Durable Object → Cloudflare Container → Symfony path remains intact.
- Container-local MariaDB remains the preview-session relational authority.
- The accepted synthetic seed, route contract, ownership manifest, attempt ledger, close cleanup, cancellation recovery, and orphan predicate remain intact.
- `vektorprogrammet.no` remains forbidden as a target, egress destination, credentialed endpoint, rendered value, or evidence value.

A local test or Foldkit fixture cannot replace any p20 resource, workflow, seed, route, or cleanup contract.
The candidate must not add a second p20 stage, resource graph, lifecycle ledger, or trusted workflow.

### Local Wrangler preservation

The accepted local checkpoint remains one raw Worker from `infra/preview.worker.ts` at `127.0.0.1:8787`.
The accepted root script must preserve the exact local controls and Node-hosted Wrangler invocation:

```sh
WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_LOG_PATH=.wrangler/logs node node_modules/wrangler/bin/wrangler.js dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787 --compatibility-date 2026-08-08
```

The accepted health response remains exactly:

```json
{ "service": "mono-web", "purpose": "cloudflare-local-preview-spine", "status": "ok" }
```

The candidate must preserve `GET /health` with `200`, `Cache-Control: no-store`, and JSON content type; unknown routes with `404`; non-`GET /health` requests with `405` and `Allow: GET`; and a closed port after supervised stop.
The local Worker has no binding and no provider, SDK, Symfony, frontend, database, or production call.

#### Resolved shared manifest disposition

The base dashboard manifest is React Router 7 with React 19.1 and Vite 6.
The accepted Foldkit final manifest is React Router 8.3 with React 19.2.7 and Vite 8.0.7.
The accepted final manifest also owns `@cloudflare/vite-plugin: ^1.13.12`, `foldkit: 0.143.0`, `@foldkit/ui: 0.143.0`, `effect: 4.0.0-beta.107`, and `@effect/platform-browser: 4.0.0-beta.107`.
The product-lead disposition is frozen for this integration:

1. Preserve the accepted `ac316022d0c92615645986e8fe9a4c521f22b186` dashboard dependency set, including React Router 8, React 19.2.7, Vite 8, the Cloudflare Vite plugin, Foldkit, and the exact Effect dependencies.
2. Preserve root Wrangler `4.120.1`, which the base, 0011, and p20 delivery line own.
3. Reconcile `bun.lock` once from the resolved manifests. Do not add an incidental upgrade, a second lock project, or a second package graph.
4. Preserve the local Wrangler script, Worker, compatibility date, four runtime egress controls, loopback bind, HTTP contract, and stop contract from 0001 and `af069395`.
5. Rerun the 0001 local behavior journey under the resolved root Wrangler `4.120.1`. Record this as new local behavior evidence; do not claim that the raw `af069395` `wrangler@4.120.0` installation remains unchanged.

This disposition resolves the version conflict. A downgrade to `4.120.0`, a retention of the base RR7/React 19.1/Vite 6 dashboard graph, or a second Wrangler installation is a falsifier.

### Accepted dashboard fixture sanitization

Rule 11 of frozen [`0020`](./0020-pr-preview-delivery.md) forbids `vektorprogrammet.no` as a preview target, DNS or route target, deployment target, credentialed endpoint, or outbound runtime destination.
Frozen observation `O-0020-13` identifies the committed production-host references in dashboard fallback and fixture profile sources.
The accepted `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2` source values are authoritative for this safety correction.
The candidate must carry these values into `apps/dashboard/app/routes/dashboard.tsx` and `apps/dashboard/app/mock/api/data-profile.ts`:

```text
dashboard fallback:
  name = Fixture Operator
  email = operator@fixture.example.invalid
  avatar = https://assets.example.invalid/fixture/avatar.svg

fixture profile:
  firstName = Fixture
  lastName = Operator
  vektorEmail = operator@fixture.example.invalid
  email = operator@example.invalid
  phone = 00000000
  study = FIXTURE
  department = Example
  accountNumber = 0000 00 00000
  profileImage = https://assets.example.invalid/fixture/profile.svg
```

The writer must compare both paths with the pinned accepted source, scan them for `vektorprogrammet.no` and real-person values, and retain only the synthetic values above.
This is a source-safety correction required by the frozen p20 boundary. It is not a new product journey or a production-data transformation.

### Foldkit and SDK behavior preservation

The candidate must preserve the exact accepted behavior from the pinned 0021 and 0022 contracts and the final source head:

- Foldkit uses a pure `Model`, pure `update`, Effect-backed `Command` values, Foldkit runtime embedding, Effect Schema boundaries, `AsyncData`, `FieldValidation`, and `HtmlBuilder`.
- The dashboard route is `/dashboard/foldkit`. The candidate response route is `/interview-response/:capability` with the redacted post-navigation route `/interview-response/redacted`.
- The selected Cycle is explicit: `dep-trd-1` and `sem-2026-høst`, displayed as `Trondheim` and `Høst 2026`.
- The assigned fixture is `Applicant One`, `app-001`, and `interview-001`, with `interviewer-trondheim@example.invalid`, `2026-09-14T15:00:00+02:00`, `Rom 2`, and `Gløshaugen`.
- The accepted SDK names remain `admin.interviews.listAssigned`, `admin.interviews.readAssigned`, `admin.interviews.scheduleForCycle`, `interviewResponses.read`, and `interviewResponses.accept`.
- Every admin operation names the Cycle. Actor identity and department grants remain server or fixture authority, never caller input.
- `ResponseCapability` remains opaque, single-purpose, expiring, Cycle-bound, hidden from UI and evidence, and valid for exactly one pending-to-accepted transition.
- A successful schedule or acceptance is followed by a fresh read. The application never fabricates the accepted state.
- The application does not call PHP endpoints, a provider, a database, or a direct fixture origin. The accepted browser bridge is the only browser adapter, and focused evidence must show bridge traffic and zero direct fixture requests.
- Unauthorized, unknown, malformed, wrong-Cycle, expired, reused, cancelled, conducted, and non-pending operations fail without cross-tenant or capability disclosure.
- The synthetic fixture resets between scenarios. It has no provider, production data, credential, or non-loopback dependency.

The candidate must not add a second interview model, second route owner, second SDK seam, second capability store, or browser-only success path.
The existing legacy interview methods remain only where the accepted source contract already requires them; they must not become aliases for the new Cycle-explicit methods.

## Source ownership and conflict rules

The future writer must resolve conflicts in this order:

1. Preserve the exact base p20 contract and root Wrangler `4.120.1` authority.
2. Preserve the accepted Foldkit dashboard dependency set and its proven runtime assumptions.
3. Preserve the exact local Wrangler HTTP and process contract, then rerun it under root Wrangler `4.120.1`.
4. Preserve the exact accepted Foldkit and SDK observable behavior.
5. Preserve existing domain authority, route ownership, and the `O-0020-13` production-host boundary.
6. Change only the shared manifest or lock representation needed to express these accepted contracts.
7. If a new conflict remains, stop in `Drift`; do not invent a compatibility layer.

### Ownership map

| Path or path set | Owner in this baseline | Integration rule |
|---|---|---|
| `infra/preview.worker.ts` | Local Wrangler | One raw health Worker only; do not route p20, Symfony, dashboard, or SDK traffic through it. |
| Root `package.json` | Base/p20 manifest authority with local-script addition | Retain root Wrangler `4.120.1`; add the accepted local script without a second Wrangler installation or unrelated dependency change. |
| Root `bun.lock` | Shared resolved-lock custody | Resolve the accepted dashboard graph and root Wrangler once; regenerate only from the resolved manifests; record no incidental upgrade. |
| Root `.gitignore` | Existing repository rules | `.wrangler/` is already ignored at base and is an expected no-op; retain every existing rule and add no credential exception. |
| `infra/preview/**`, `infra/alchemy/**`, `.github/workflows/preview-*.yml`, `apps/server/infra/preview/**` | Base p20 delivery | Do not replace, delete, duplicate, or redirect trusted preview resources. These paths are not in the future delta capsule. |
| `apps/dashboard/package.json` | Accepted Foldkit dependency authority | Preserve ac316's React Router 8.3, React 19.2.7, Vite 8.0.7, Cloudflare Vite plugin, Foldkit, and exact Effect dependency set; do not retain base RR7/React 19.1/Vite 6. |
| `apps/dashboard/{app/root.tsx,app/entry.server.tsx,app/lib/host.ts,app/mock/api/public.ts}` | Accepted ac316 final-tree dashboard graph wiring | Pin each path byte-for-byte to the ac316 tree; preserve the RR8/React 19.2/Vite 8 graph and accepted host behavior; use the React Router served app with the base-owned Vite configuration; do not add or cut over a dashboard Worker. |
| `apps/dashboard/app/mock/api/data-profile.ts` | p20 host-safety and accepted fixture authority | Carry the exact synthetic profile values from the accepted e05cefc source; remove production host, personal, and real-person values. |
| `apps/dashboard/app/routes/dashboard.tsx` | Accepted dashboard shell and p20 host-safety authority | Carry the exact synthetic fallback user from e05cefc and the accepted ac316 dashboard shell; do not reintroduce production metadata. |
| `apps/dashboard/app/routes/{dashboard.linjer._index.tsx,dashboard.sponsorer._index.tsx,dashboard.team._index.tsx}` | Accepted legacy route-compatibility changes | Preserve the ac316 route ownership corrections; do not add a second route owner or claim route cutover. |
| `apps/dashboard/app/lib/api.server.ts` | SDK client composition | Keep server-side client construction on the accepted SDK seam; do not add browser transport or a second client. |
| `apps/dashboard/app/foldkit/interview/**` | Foldkit runtime | Keep one Model/update/Command/view/runtime implementation, including `elements.d.ts`. |
| `apps/dashboard/app/lib/interview-bridge.server.ts` | SDK-backed server bridge | Keep authentication, capability cookie, safe errors, fixture controls, and server-side SDK ownership in this bridge. |
| `apps/dashboard/app/routes/{__foldkit.interview.ts,dashboard.foldkit.tsx,interview-response.$capability.tsx,interview-response.redacted.tsx}` | Foldkit route owner | Keep one route owner and redacted capability URL behavior. Do not claim route cutover. |
| `apps/dashboard/e2e/{fixtures/interview-api.ts,foldkit-interview.spec.ts}` | Focused Foldkit evidence | Keep deterministic reset, sanitized evidence, rejection cases, and privacy assertions. Do not add provider or production fixtures. |
| `apps/dashboard/playwright.config.ts` | Focused Foldkit browser harness | Preserve loopback origins, fixture readiness, Node-hosted Playwright, fixed viewport, and graceful process cleanup. |
| `packages/sdk/src/{domains/admin/interviews.ts,domains/interview-responses.ts,schemas/interview.ts,effect-client.ts,promise.ts,index.ts}` | SDK seam | Keep one Effect domain and one Promise facade over the shared transport. No aliases, overloads, or browser transport implementation. |
| `packages/sdk/src/__tests__/transport.test.ts` | SDK contract tests | Preserve typed status, Cycle, ID, capability, and fresh-read behavior. |
| `apps/homepage/test/host.test.ts` | Base p20/homepage host authority | Restore and retain the base file byte-for-byte. Do not apply the ac316 delta: it asserts an obsolete Alchemy declaration and deletes p20 assertions. Any difference from base is `Drift`. |

Any changed path outside the exact capsule is a falsifier.
A change that appears mechanical but changes an owner, route, method name, status mapping, dependency version, host grammar, or egress boundary is semantic and requires review.

### Duplicate derivation law

The candidate fails if any accepted fact has two active derivations.
This includes:

- two `preview:dev` scripts, two `infra/preview.worker.ts` files, or two local health contracts;
- two p20 lifecycle authorities, two ownership manifests, two stage ledgers, or two teardown selectors;
- two Foldkit route owners for `/dashboard/foldkit` or the candidate response route;
- two SDK implementations of a Cycle operation or response capability;
- a direct browser fixture/API call beside the accepted bridge;
- an optimistic accepted state beside the fresh SDK read;
- a second dependency or lock project that silently resolves Wrangler, Effect, Foldkit, or SDK versions;
- committed generated output or evidence that becomes a competing source.

A duplicate is a failure even when both derivations return the same value.

## One maintainer journey

The future implementation writer runs this one journey from a clean, isolated integration worktree.
The current spec writer does not run this validation journey.

### Entry and provenance

1. Create `/tmp/mono-web-parity-integration-0023` on branch `impl/0023-functional-parity-integration-baseline` from exact base `462691d4c31ed601fba01f8b5f21abb92a547ff9`.
2. Confirm that `git status --porcelain=v1 --untracked-files=all` is empty before any source change. Confirm that the index and worktree have no diff. Do not inherit `.serena/`, `.env`, `.dev.vars`, generated output, ignored state, credentials, or user files from another worktree.
3. Record the five source heads, common ancestor, accepted ranges, path lists, and patch digests. Store this manifest outside Git or in the one-to-one review record. Never commit raw logs or generated evidence.
4. Confirm that no provider credentials, profiles, account identifiers, production data, or raw backups exist in the project root. Filename preflight must not open a matching file.
5. Read the frozen contracts at 0001, 0020, the accepted 0021/0022 source object, ADR 0003, and the current domain authority. Do not edit any of them.

### Integration and locked install

6. Apply only the Wrangler closure, Foldkit/SDK closure, and four accepted ac316 dashboard graph-wiring carry-forwards in the dispatch capsule. Do not apply the ac316 `apps/homepage/test/host.test.ts` delta; retain the base p20 file byte-for-byte.
7. Resolve shared manifests with the frozen disposition: use the ac316 dashboard RR8/React 19.2/Vite 8/Cloudflare Vite plugin set, retain root Wrangler `4.120.1`, and preserve the local script and Worker behavior.
8. Run `bun install --frozen-lockfile` from the candidate root. A stale lock, an undeclared workspace edge, or an incidental dependency upgrade fails the journey.
9. Compare `apps/dashboard/app/routes/dashboard.tsx` and `apps/dashboard/app/mock/api/data-profile.ts` with the accepted e05cefc source. Require the exact synthetic fallback/profile values and no `vektorprogrammet.no` or real-person values. Compare all four graph-wiring paths byte-for-byte with ac316, retain the base-owned Vite configuration, and keep `apps/homepage/test/host.test.ts` byte-for-byte equal to base. Then search for duplicate derivations and confirm one local Worker, one p20 trusted lifecycle, one Foldkit route owner, one SDK capability domain, and one source of each required fixture value.

### Runtime and contract gates

10. Before starting the local runtime, prove that `127.0.0.1:8787` is closed. Start `bun run preview:dev` under supervision with no provider credentials.
11. Request `GET /health`, an unknown route, and `POST /health`. Record complete status, headers, and body. Require the exact local Wrangler observations in this spec.
12. Stop the supervised Worker and prove that `127.0.0.1:8787` is closed. Any provider request, non-loopback bind, missing egress control, global Wrangler log, or failed stop is `Drift`.
13. Run the p20 trusted preview contract tests:

    ```sh
    bun test infra/preview/trusted/trusted.test.mjs
    ```

    The tests must continue to cover exact p20 identity, allow-listed resource ownership, forbidden production host rejection, lifecycle transitions, attempt cap, tombstone retention, and shell-safe trusted command construction.
    These tests are credential-free contract tests. They do not authorize `plan`, `apply`, `deploy`, `destroy`, or any provider command.

14. Run the root TypeScript gates from the candidate root:

    ```sh
    bun run check-types
    bun turbo build
    ```

    The root gates must discover the accepted workspace graph. A package that passes only through an incidental hoist, a missing workspace task, or a generated file is a failure.

15. Run the SDK tests through the package-owned command:

    ```sh
    bun run --cwd packages/sdk test
    ```

    The result must cover the exact Effect and Promise interview methods, Cycle and identifier decoding, typed failures, capability boundary, and transport behavior named by 0022.

16. Run the focused Foldkit Playwright journey through the accepted Node-hosted CLI:

    ```sh
    FOLDKIT_INTERVIEW_E2E=1 bun run --cwd apps/dashboard test:e2e -- e2e/foldkit-interview.spec.ts --project=chromium --retries=0
    ```

    The focused run must use the synthetic fixture on `127.0.0.1`, reset between scenarios, and leave no direct fixture-origin browser requests.
    It must pass the leader schedule → candidate accept → interviewer fresh-read journey and the named unauthorized, missing/unknown Cycle, invalid schedule, wrong-Cycle, missing/terminal, malformed/expired/reused capability, and stale-view rejection cases.
    It must show sanitized evidence with `created -> pending` and `pending -> accepted`, no capability value, no session material, and no production value.

### Exit and clean status

17. Stop all supervised local processes. Close ports `8787`, `5173`, and `8790`.
18. Remove only disposable integration output: `.wrangler/`, `.turbo/`, dashboard build output, Playwright results, screenshots, videos, trace files, fixture logs, temporary manifests, and temporary lock or install state. Do not use account-wide cleanup. Do not delete a tracked file or another worktree's file.
19. Re-run duplicate-derivation and path-scope checks. The changed path set must be a subset of the dispatch capsule set. Record every accepted capsule path that remains unchanged and the reason for the no-op, including base-preserved `.gitignore`. Confirm `apps/homepage/test/host.test.ts` remains byte-for-byte equal to base and that the ac316 delta is not applied.
20. Confirm `git status --porcelain=v1 --untracked-files=all` is empty after the future implementation commit. Confirm no staged, unstaged, ignored credential, generated, evidence, or lock residue remains.
21. Report the exact integration commit, branch, worktree, base, source heads, source manifest digest, test commands, evidence identifiers, conflict dispositions, and clean-status result.

The journey ends at a clean local candidate baseline. It does not continue to a provider plan, provider apply, cloud preview, route cutover, production deployment, production database, or parity verdict.

## Deterministic acceptance criteria

The future implementation can pass this spec only when every predicate is true:

1. The integration worktree starts clean from exact base `462691d4c31ed601fba01f8b5f21abb92a547ff9`, with no inherited dirty files.
2. The source manifest records exact heads `462691d`, `af0693`, `ac3160`, and `89f8523`, common ancestor `12c1f3`, parent identities, accepted ranges, path lists, and recomputable patch digests.
3. The future changed path set is a subset of the four Wrangler paths and the 37 Foldkit/SDK paths in the dispatch capsule. The record lists accepted paths that remain unchanged and explains each no-op, including `.gitignore`. `apps/homepage/test/host.test.ts` remains byte-for-byte equal to base because the ac316 delta is excluded. This spec, other design specs, decisions, docs, application paths outside the capsule, lockfiles outside the capsule, evidence, and provider state remain unchanged.
4. The base p20 trusted graph, identity, route contract, seed rules, lifecycle, cleanup, and forbidden production-host boundary remain unchanged and pass `infra/preview/trusted/trusted.test.mjs`.
5. The local Wrangler checkpoint remains one Node-hosted raw Worker with the exact script controls, compatibility date, health body, `404`, `405`, loopback-only binding, and clean stop under resolved root Wrangler `4.120.1`. Every 0001 behavior gate passes under this resolved root pin; any failure is `Drift`.
6. The resolved manifests preserve ac316's dashboard RR8/React 19.2.7/Vite 8/Cloudflare Vite plugin set and root Wrangler `4.120.1`; the lock has one deterministic graph with no incidental upgrade. The four dashboard graph-wiring paths are byte-for-byte equal to the ac316 final tree, the dashboard uses the base-owned Vite configuration, and no dashboard Worker cutover occurs.
7. The Foldkit application retains the exact accepted Model/update/Command/runtime/view boundaries, fixture values, route ownership, privacy boundary, and fresh-read behavior. `dashboard.tsx` and `data-profile.ts` retain the exact e05cefc synthetic values and no production-host or real-person value.
8. The SDK exposes one exact Effect and Promise seam with the 0022 names, explicit Cycle, branded identifiers, typed errors, opaque response capability, and pending-only atomic acceptance.
9. The local fixture is synthetic, resettable, loopback-only, and free of provider, production, credential, database, and remote API requirements.
10. `bun install --frozen-lockfile`, `bun run check-types`, `bun turbo build`, `bun test infra/preview/trusted/trusted.test.mjs`, `bun run --cwd packages/sdk test`, and the focused Foldkit Playwright command pass without retry masking or skipped required tests.
11. The browser evidence shows bridge requests and zero direct fixture-origin requests. It contains no capability, cookie, header, raw payload, secret, PII, production host, or raw backup value.
12. No duplicate derivation exists for a Worker, p20 lifecycle, route owner, SDK domain, capability store, fixture, dependency graph, or evidence source.
13. The future implementation commit leaves a clean worktree and no disposable state, generated output, evidence file, credential file, or temporary lock residue.
14. Independent review receives the frozen spec, source manifest, candidate diff, command output, sanitized browser evidence, conflict disposition, and clean-status result before author rationale.
15. The final status remains an integration prerequisite only. No result is labeled parity, conforming, release-ready, deployed, provider-authorized, data-authorized, or production-proven.

## Falsifiers and Drift route

Any one of these observations fails the candidate and enters `Drift`:

1. The worktree has a dirty or inherited path before integration.
2. Any source head, parent, common ancestor, accepted range, or patch digest differs from this spec.
3. A branch snapshot, unreviewed commit, merge result, or generated file enters the candidate.
4. A path outside the dispatch capsule changes, or a named path changes for an unrelated purpose.
5. The p20 app, target, stage, hostname, container identity, trusted workflow, ownership manifest, seed rule, route contract, attempt law, or cleanup selector changes.
6. A p20 test fails, a trusted command reaches a provider, or a provider credential is introduced for a contract test.
7. The local Worker has a second implementation, wrong health JSON, extra response key, wrong status/header, non-loopback bind, missing egress control, Bun-hosted CLI, global log, provider request, or failed stop.
8. The root manifest changes from Wrangler `4.120.1`, adds a second Wrangler project, retains the base RR7/React 19.1/Vite 6 dashboard graph, adds Alchemy or Effect to the local spine, creates a second lock graph, omits the resolved ac316 dashboard dependencies, or changes any of the four graph-wiring paths from the ac316 final tree; a dashboard Worker is added or cut over; or `apps/homepage/test/host.test.ts` changes from the base p20 file.
9. The Foldkit view, model, update, or command performs a second effect path, uses React state or hooks, infers a Cycle, or fabricates accepted state. The dashboard fallback or fixture profile retains a production host, real-person value, or value different from the accepted e05cefc synthetic source.
10. A dashboard route or candidate response route has two owners, a legacy route is cut over without authority, or an application path calls the fixture origin directly.
11. The SDK omits Cycle from an admin operation, accepts actor or grant input, creates aliases or overloads, exposes a capability, returns a fabricated entity, or lets a non-pending/expired/wrong-Cycle capability mutate state.
12. A valid empty list and a failed list have the same observation, or a transport/authorization error renders as a successful empty table.
13. The fixture uses production data, production identifiers, credentials, a provider, a remote API, a remote database, or a non-loopback destination.
14. Browser output, logs, traces, screenshots, fixtures, requests, evidence, or errors contain a capability, session cookie, credential, raw payload, PII, production host, raw backup, or provider account identifier.
15. The local runtime, p20 contract tests, root TypeScript gates, SDK tests, or focused Foldkit Playwright run fails, is skipped, is retried to hide failure, or runs against a different source head.
16. The final worktree has staged, unstaged, ignored credential, generated, evidence, temporary, or lock residue.
17. Any implementation or evidence text claims parity, deployment, release readiness, provider authorization, data access, production behavior, or production equivalence from this integration prerequisite.

When a falsifier occurs, stop the affected command and record a sanitized Drift row with source head, path, command, observation, expected value, and owning authority.
Do not repair the authority by editing the easiest file.
Return intent conflicts to the product/lifecycle authority, domain conflicts to the domain authority, route conflicts to the architecture authority, SDK conflicts to the SDK authority, and provider questions to an operator-scoped future spec.

## Content provenance and ancestry evidence

The future review record must include these content-provenance fields:

| Evidence field | Required value |
|---|---|
| Repository | `vektorprogrammet/mono-web` |
| Base | `462691d4c31ed601fba01f8b5f21abb92a547ff9` |
| Common ancestor | `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d` |
| Wrangler input | `af069395e5c591c142530749ea3337476a55ac61` |
| Foldkit input | `ac316022d0c92615645986e8fe9a4c521f22b186` |
| Stage-1 SDK input | `89f85239b825e3d938748d770f2fa76192d8cc2c` |
| Frozen 0021/0022 source | `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2` |
| Dashboard dependency disposition | `ac316022d0c92615645986e8fe9a4c521f22b186` wins over base RR7/React 19.1/Vite 6; root Wrangler remains `4.120.1`. |
| Dashboard safety paths | `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2:apps/dashboard/app/routes/dashboard.tsx` and `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2:apps/dashboard/app/mock/api/data-profile.ts`; exact synthetic fallback/profile values and no production host or real-person value. |
| Local Wrangler evidence | `af069395e5c591c142530749ea3337476a55ac61` behavior rerun under root Wrangler `4.120.1`; new loopback-only 0001 evidence, with no claim that `4.120.0` remains installed. |
| Wrangler range | `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d..af069395e5c591c142530749ea3337476a55ac61` |
| Foldkit/SDK range | `0b30d0ccfc994cb26900181635113fc79544bc7e^..ac316022d0c92615645986e8fe9a4c521f22b186` |
| Candidate base relation | Candidate is based on `462691d`; no input head is rewritten |
| Dashboard graph wiring | `ac316022d0c92615645986e8fe9a4c521f22b186` exact final-tree bytes for `apps/dashboard/app/root.tsx`, `apps/dashboard/app/entry.server.tsx`, `apps/dashboard/app/lib/host.ts`, and `apps/dashboard/app/mock/api/public.ts`; dashboard serves through React Router and the base-owned Vite configuration, with no dashboard Worker cutover |
| Homepage host-test disposition | Base `462691d4c31ed601fba01f8b5f21abb92a547ff9` bytes for `apps/homepage/test/host.test.ts`; the ac316 Alchemy assertion delta is intentionally excluded because it deletes p20 assertions |
| Evidence content | Metadata, hashes, statuses, bounded synthetic IDs, and sanitized observations only |

The source manifest must prove content ancestry, not only cite short hashes.
It must include full object IDs, parent IDs, commit subjects, `git diff --name-status` output for both accepted ranges, and SHA-256 digests of the exact binary patches or canonical path manifests.
It must identify all shared paths and the authority that resolved each conflict.
It must contain no raw source rows, credentials, provider account data, cookies, capability values, or production payloads.

The evidence record must distinguish these claims:

- A commit proves that a source tree contains the committed bytes.
- A patch digest proves which accepted bytes were selected for review.
- A local Wrangler run proves one local Worker request and stop sequence.
- A p20 trusted contract test proves selected p20 identity and lifecycle invariants.
- A TypeScript gate proves the named workspace compilation gate.
- An SDK test proves the named SDK contract test observations.
- A Playwright run proves the named synthetic Foldkit browser journey.
- A clean status proves no tracked or untracked residue at the recorded exit point.

No evidence item proves parity, deployment, provider behavior, production data correctness, release readiness, or production behavior.

## Cleanup

Cleanup is local and path-scoped.

- Stop the local Wrangler process and all dashboard/fixture processes.
- Confirm that ports `8787`, `5173`, and `8790` are closed.
- Remove `.wrangler/`, `.turbo/`, dashboard build output, Playwright results, screenshots, videos, traces, fixture logs, temporary manifests, and temporary install state.
- Remove only temporary files created by this candidate. Do not delete another worktree's files, a tracked source file, an accepted input head, or a user-owned credential file.
- Do not invoke Alchemy, Cloudflare, GitHub deployment, DNS, database, provider cleanup, or account-wide cleanup.
- Inspect path scope and status after cleanup.
- Leave the candidate worktree clean after the future implementation commit.

A cleanup failure is a falsifier. It does not become acceptable because the runtime request passed.

## Rollback

Rollback has no provider or production step.

1. If an ancestry or semantic conflict appears, stop before further source changes and preserve only the sanitized source manifest and Drift record.
2. If the candidate commit is not accepted, remove the isolated integration worktree or revert the one candidate commit. Keep the three accepted input heads unchanged.
3. Restore the candidate to exact base `462691d4c31ed601fba01f8b5f21abb92a547ff9` before a new reviewed capsule starts.
4. Stop and clean local processes and disposable state. Do not reset a p20 remote ledger, delete a provider resource, alter production, or change the accepted source branches.
5. If the intent or authority changes, return this spec to review and create a new capsule. Do not patch the conflict into an implementation-only exception.

Rollback proves only local source and process reversibility.
It does not prove deployment rollback, database rollback, provider teardown, route rollback, or production recovery.

## Dispatchable implementation capsule

This capsule is not active authority until an implementation writer receives this frozen spec and a reviewed dispatch.
The capsule names the only source paths that the future writer can change.

### Writer identity and entry gate

| Field | Required value |
|---|---|
| Worktree | `/tmp/mono-web-parity-integration-0023` |
| Branch | `impl/0023-functional-parity-integration-baseline` |
| Base | `462691d4c31ed601fba01f8b5f21abb92a547ff9` |
| Start status | `git status --porcelain=v1 --untracked-files=all` returns no lines |
| Provider mode | No provider, credential, remote database, DNS, deployment, or production action |
| Commit scope | Exactly the paths below; no existing spec/decision/doc/evidence change |
| Exit | One candidate commit, exact source manifest, sanitized test evidence, and clean status |

### Allowed paths

The Wrangler closure owns exactly:

```text
.gitignore
bun.lock
package.json
infra/preview.worker.ts
```

The Foldkit/SDK closure owns exactly:

```text
apps/dashboard/app/foldkit/interview/browser-client.ts
apps/dashboard/app/foldkit/interview/command.ts
apps/dashboard/app/foldkit/interview/elements.d.ts
apps/dashboard/app/foldkit/interview/elements.ts
apps/dashboard/app/foldkit/interview/main.ts
apps/dashboard/app/foldkit/interview/message.ts
apps/dashboard/app/foldkit/interview/model.ts
apps/dashboard/app/foldkit/interview/styles.css
apps/dashboard/app/foldkit/interview/update.ts
apps/dashboard/app/foldkit/interview/view.ts
apps/dashboard/app/lib/api.server.ts
apps/dashboard/app/lib/interview-bridge.server.ts
apps/dashboard/app/routes/__foldkit.interview.ts
apps/dashboard/app/routes/dashboard.foldkit.tsx
apps/dashboard/app/routes/dashboard.linjer._index.tsx
apps/dashboard/app/routes/dashboard.sponsorer._index.tsx
apps/dashboard/app/routes/dashboard.team._index.tsx
apps/dashboard/app/routes/dashboard.tsx
apps/dashboard/app/mock/api/data-profile.ts
apps/dashboard/app/routes/interview-response.$capability.tsx
apps/dashboard/app/routes/interview-response.redacted.tsx
apps/dashboard/e2e/fixtures/interview-api.ts
apps/dashboard/e2e/foldkit-interview.spec.ts
apps/dashboard/package.json
apps/dashboard/playwright.config.ts
apps/dashboard/app/root.tsx
apps/dashboard/app/entry.server.tsx
apps/dashboard/app/lib/host.ts
apps/dashboard/app/mock/api/public.ts
bun.lock
packages/sdk/src/__tests__/transport.test.ts
packages/sdk/src/domains/admin/interviews.ts
packages/sdk/src/domains/interview-responses.ts
packages/sdk/src/effect-client.ts
packages/sdk/src/index.ts
packages/sdk/src/promise.ts
packages/sdk/src/schemas/interview.ts
```

The intersection of the closure ranges is `bun.lock` only.
`apps/dashboard/app/mock/api/data-profile.ts` is an accepted final-tree safety carry-forward from the pinned Foldkit ancestry and is required because base `462691d` retains forbidden production-shaped values.
`package.json` is Wrangler-only in the accepted ranges but remains shared with the base Vite authority and therefore uses the resolved root Wrangler `4.120.1`.
`.gitignore` remains base-preserved. `apps/homepage/test/host.test.ts` is not in this capsule: restore and retain the base file byte-for-byte, and do not apply the ac316 delta that asserts an obsolete Alchemy declaration and deletes p20 assertions.
No other path is an implicit allowance.

### Required writer sequence

1. Verify the exact worktree, branch, base, clean status, input objects, ancestry, and accepted ranges.
2. Produce the source manifest and conflict inventory before editing.
3. Apply only the two accepted closures. Preserve p20 files and frozen specs.
4. Resolve shared manifests, root Wrangler authority, host assertions, exact ac316 dashboard graph wiring, and the e05cefc dashboard sanitization through the authority routes in this spec.
5. Run the one maintainer journey and capture sanitized output.
6. Remove disposable state and verify exact path scope.
7. Commit with a message that names this bounded integration baseline. Do not amend an input commit.
8. Report exact HEAD, path list, test commands, evidence IDs, conflict dispositions, and clean status.

The writer must stop rather than add a shim, alias, compatibility layer, second route, second Worker, second SDK path, unreviewed dependency, provider command, or production exception.

## Review and status boundary

Independent review must inspect the frozen source heads, ancestry manifest, shared-path conflict table, candidate diff, local runtime record, p20 trusted test output, root TypeScript gate output, SDK test output, focused Foldkit Playwright evidence, privacy scan, cleanup record, rollback record, and final clean status.

This spec reaches its own review boundary when the document is committed in the dedicated specification worktree.
The future implementation can reach only a clean integration prerequisite state.
It cannot advance this contract to parity, Conforming, Release-ready, Deployed, Operating, or Production-proven.
Any such status requires a later accepted spec and separate authority.

## Source index

- [`design-specs/0001-cloudflare-local-preview-spine.md`](./0001-cloudflare-local-preview-spine.md)
- [`design-specs/0020-pr-preview-delivery.md`](./0020-pr-preview-delivery.md)
- Accepted Foldkit journey: `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2:design-specs/0021-foldkit-control-panel-interview-scheduling.md`
- Accepted SDK seam: `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2:design-specs/0022-dashboard-interview-capability-sdk-seam.md`
- Accepted dashboard architecture: `e05cefc8e23c46d95c6f6a3323ca47e5b43e51a2:docs/decisions/0003-foldkit-dashboard-replacement.md`
- Domain authority: `docs/domain-model.md` in the accepted source line
- Product-lead acceptance authority: [`docs/product-lead-charter.md`](../../docs/product-lead-charter.md), accepted and frozen on `2026-08-16`
- p20 host-safety authority: [`0020`](./0020-pr-preview-delivery.md) rule 11 and observation `O-0020-13`
- Accepted local Wrangler head: `af069395e5c591c142530749ea3337476a55ac61`
- Accepted Foldkit final head: `ac316022d0c92615645986e8fe9a4c521f22b186`
- Accepted stage-1 SDK head: `89f85239b825e3d938748d770f2fa76192d8cc2c`
- Integration base: `462691d4c31ed601fba01f8b5f21abb92a547ff9`
- Common ancestor: `12c1f3ea6ab1b29d760ed60853c90e46e1aa466d`

## Frozen review statement

This document freezes one dispatchable Goal-1 integration prerequisite.
It requires a clean worktree from `462691d`, exact accepted Wrangler and Foldkit/SDK input heads, ancestry and content provenance, semantic conflict review against the frozen p20, local Wrangler, Foldkit, and SDK contracts, one maintainer journey, deterministic falsifiers, bounded cleanup, local rollback, and a clean future exit.
It preserves p20 trusted delivery, the local Wrangler checkpoint, and exact accepted Foldkit/SDK behavior.
It rejects duplicate derivations and every provider or production effect.
It makes no parity, release, deployment, provider, data, or production claim.
