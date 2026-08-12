# Live design spec 0019 — application status typed decode

> **Summary:** One SDK consumer journey sends malformed application list and detail responses through both public SDK surfaces. An unknown integer `applicationStatus` fails as the existing public `ValidationError` with `type: "validation"` on the Promise surface and as the existing Effect `Validation` with `_tag: "Validation"` on the Effect surface. Accepted status values and result representations stay unchanged. The existing 0018 route shows `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`, zero applicant rows, and no raw value or payload. This is a local SDK contract slice. It does not change the dashboard, backend, transport, public exports, dependencies, lock, provider state, or remote data.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0019` |
| Title | `Application status typed decode` |
| Status | `accepted` — product-lead accepted the intent and the implementation on `2026-08-12` after independent review, canonical runtime, and integration mapping PASS. |
| Lifecycle state | `Building` — implementation and complete local evidence are accepted at canonical `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; no frozen/open one-to-one PR exists, so `Experienceable`, `Conforming`, `Release-ready`, and `Operating` are not entered. No provider, remote, runtime, or operator authority is granted. |
| Owner | SDK application-status successor lane |
| Intended lane | One public SDK malformed-application decode journey, with a bounded return observation in the existing 0018 route |
| Created | `2026-08-12` |
| Base checkpoint | `52338a4802dca9a53558c0236ea8161674d8ce8c` |
| Base parent | `a256c982ef95b91c881ee07896527f8956a5f5fb` |
| Base worktree | `/tmp/mono-web-stage1-conforming-20260810` |
| Base branch | `integration/stage1-conforming-20260810` |
| Journey count | One felt SDK consumer journey; list and detail, Promise and Effect, are observations in that journey rather than separate product features |
| Independent specification review | `PASS` — `ApplicationStatusSpecReview0019`; reviewed semantic HEAD `5e611db3025265aeae5e2349182a9f1b6b93cf51`; reviewed spec SHA-256 `279db4983f8db6ca64e81bd1d1de956e92718e3448f9586d5643cea86e5c6139`. |
| Technical feasibility review | `PASS` — `ApplicationStatusEffectFeasibility0019`; reviewed semantic HEAD `5e611db3025265aeae5e2349182a9f1b6b93cf51`; reviewed spec SHA-256 `279db4983f8db6ca64e81bd1d1de956e92718e3448f9586d5643cea86e5c6139`. |
| Source candidate graph | `07e66d3d1a39e357c0b69692908f47f1cde115c8` (parent `3ac8520041aebc7b92e3599762d94d975ca082de`) → `964f1b663f88d55c76a1fe7848e6960d4ddb1b89` (parent `07e66d3d1a39e357c0b69692908f47f1cde115c8`) → `d6c6edc2720b39ff3f2348bad16c3646568ef3cc` (parent `964f1b663f88d55c76a1fe7848e6960d4ddb1b89`). |
| Canonical integration graph | `9cb199ca8f320095a9449a348a3b4bf006d588cd` (parent `3ac8520041aebc7b92e3599762d94d975ca082de`) → `f2fdf4afce57cdad3c43e8564f9be67f032c6ab3` (parent `9cb199ca8f320095a9449a348a3b4bf006d588cd`) → `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f` (parent `f2fdf4afce57cdad3c43e8564f9be67f032c6ab3`). |
| Owned implementation paths | Exactly `packages/sdk/src/adapter/status.ts`, `packages/sdk/src/schemas/application.ts`, `packages/sdk/src/__tests__/adapter.test.ts`, and `packages/sdk/src/__tests__/receipt-effect-v4-compatibility.test.ts`; all four canonical blobs match the source candidate. |
| Product-lead intent acceptance | `ACCEPT` — intent accepted on `2026-08-12`; the product lead remains read-only to implementation and grants no provider, remote, runtime, or operator authority. |
| Code review | `PASS` — `agent://ApplicationStatusCodeReview0019` at source candidate `d6c6edc2720b39ff3f2348bad16c3646568ef3cc`; zero findings. |
| Runtime evidence | `PASS` — `agent://ApplicationStatusRuntimeVerify0019` at exact canonical head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; exact Bun `1.3.10`, focused SDK `47/47`, `tsc -b`, typed Promise/Effect boundaries, seven valid statuses, and the existing 0018 return branch. |
| Integration mapping | `PASS` — `agent://ApplicationStatusIntegration0019`; source graph maps `07e→964→d6c` to canonical `9cb→f2fd→25e`, with four-path SHA-256 parity and zero conflicts. |
| Product-lead implementation acceptance | `ACCEPT` — canonical implementation at `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f` accepted on `2026-08-12` after code review, exact canonical runtime, and integration mapping PASS. Acceptance is local evidence disposition only; it grants no PR, provider, remote, runtime, production, release, or operator authority. |
| Implementation | Complete at source candidate `d6c6edc2720b39ff3f2348bad16c3646568ef3cc` and canonical head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; only the four owned SDK paths changed in that capsule. |
| Canonical evidence | `PASS` — `/tmp/mono-web-application-status-runtime-gate-0019-canonical-25e-20260812/`; `gate-summary.json` SHA-256 `a7ca59c0323ac1eb016550f37dd2bd6ad8a49431e13868b7bd083f4894834aab`, `typed-channels.json` `02b48d25b013e407c0ad63681cf2e4eda350ed0166732663b80542a934f3d5eb`, `dashboard-return.json` `ac30491d688544bbd22fcd81cf890afea3fb9182b8ecadb56269fe56b3594487`, and `stub-evidence.json` `b7b96dfa0024f4835691832eb3f0beafb6839b3a874318e6696062af0a97ef8b`. |
| Prior candidate runtime evidence | Historical runtime directories `/tmp/mono-web-application-status-runtime-gate-0019-20260812/`, `/tmp/mono-web-application-status-runtime-gate-0019-final-20260812/`, and `/tmp/mono-web-application-status-runtime-gate-0019-d6c-20260812/` are superseded by the exact canonical `25e` gate and are not current authority. |
| Evidence result | Red malformed-status baseline is retained as historical evidence; final canonical green is authoritative. The canonical gate records Promise list/get `ValidationError` with `type: "validation"`, Effect list/get `Validation` with `dies: false`, seven statuses, exact refined 0018 alert, zero rows, no raw value/payload, no external requests, and cleanup. |
| Drift predecessor | `D-0018-SDK-1` is `Closed` through the accepted 0019 return path at canonical `25e`; owner and return work are complete. No open 0019 or linked 0018 Drift remains. |
| Generated output | `packages/sdk/dist/**` was disposable ignored output and was removed after the canonical rerun; no generated output is committed. |
| Current claim | Accepted implementation and complete local evidence at lifecycle `Building` only. No frozen/open one-to-one PR, `Experienceable`, `Conforming`, release, deployment, provider, remote, production, data, route cutover, or operator authority is claimed. |

This revision records accepted implementation and local evidence for the four-path SDK capsule. It does not amend 0010 or 0018. Their route and SDK intent remain read-only authorities; the 0018 dependency closure is recorded here and in the subsequent 0018 lifecycle revision.

## 1. Authority and decision boundary

Each fact has one normative home. This spec routes facts to their authorities. A source path or hash records identity. It does not copy authority or grant permission to change that path.

### 1.1 Authority table

The source checkpoint for every `mono-web` path in this table is `52338a4802dca9a53558c0236ea8161674d8ce8c`. Each digest is the whole-file SHA-256 at authoring time. The two outer documents and the local Effect source are outside this checkout. Their digests record the inspected references. They do not become repository authority.

| Concern | Exact path and relevant section | Frozen revision or SHA-256 | Use and boundary |
|---|---|---|---|
| Lifecycle process | `/srv/share/projects/vektorprogrammet/docs/agentic-development-lifecycle.md` §§2, 4–6, 8–10, 12 | `sha256:a13956a1a2b6cbf09a58c460071827728f16ae7febe961275c905747ed29f809` | Owns one-home authority, lifecycle states, live-spec body, capsules, evidence limits, Drift, roles, and operator boundaries. |
| Product direction | `/srv/share/projects/vektorprogrammet/docs/product-lead-charter.md` §§1–5, 6–12 | `sha256:d731fb63212ca1412cbd5edc928f4f16fa01efe1c509e1dbb199f601d455ca85` | Owns the canonical line, SDK seam, program order, product-lead boundary, and external-effect authority. |
| Consumed SDK cutover intent | `design-specs/0010-dashboard-bun-sdk-resolution.md` §§1.2–1.3, 2, 5, 10–11 | `sha256:9c8921f8cbe427a683eec621771b2e7918f1f7853e7c0526640274771f97f69d` | Read-only consumed predecessor. Its SDK-change non-goal was valid for 0010. This successor does not reopen the umbrella or change its accepted intent. |
| 0018 consumer intent and Drift | `design-specs/0018-dashboard-applicant-assignment-sdk-seam.md` Metadata, §§3, 4, 6, 8, 9, 10, 11 | `sha256:28eb520d125ede622011d684795357e73d0ecbd5d6fe128e78d1755a064c05ee` | Historical predecessor snapshot at the pre-closure revision. It records the original `D-0018-SDK-1` observation and return edge; the accepted 0019 return and subsequent 0018 closure revision supersede that open state. |
| Status adapter source | `packages/sdk/src/adapter/status.ts:5-13,23-39` | `sha256:f840518282ccfd5c97d5d9e620c05ff78b92fcaf9c611e54ca6b7ad59cdba279` | Current application and interview status lookup authority. This slice observes and repairs only application-status behavior. |
| Application schemas | `packages/sdk/src/schemas/application.ts:9-18,21-32,37-58,61-87,90-138` | `sha256:2647d04675cbe334f94aa8453f9c9ea4bd196f599a4d3d5cdecee194335cbaad` | Current `Application`, `ApplicationDetail`, raw response, and decode representation authority. Only the application-status input boundary changed in the completed capsule. |
| Application domain | `packages/sdk/src/domains/admin/applications.ts:16-42` | `sha256:e7c4ae0cdba5bfe4724d4c47cc61a8284bb61bad0c853385a957a21a4d95b544` | Owns the public list and detail operation paths. It is read-only. |
| Public Promise channel | `packages/sdk/src/promise.ts:25-55,64-90,92-124` | `sha256:78f8ec5a2613e74486498b248da68eefc1ff73a92aca902edf40fc35bf44c9ae` | Existing Promise exports and typed error projection. No Promise implementation, export, or API change is allowed. |
| Public Promise errors | `packages/sdk/src/errors.ts:21-83,86-156` | `sha256:aedae4aa50bd9232142f94ead5fb262e98cd9a85349526da39bc6084653c0342` | Existing `ValidationError` with `type: "validation"`, internal `Validation`, and the existing internal-to-public projection. No new error class is allowed. |
| Decode and transport boundary | `packages/sdk/src/transport.ts:193-224` | `sha256:f0c906095e55717ff19ecf8b882b76ee8724a470b1ce9929f580c617a83e8f84` | Existing schema-error projection and list result shape. It is read-only. HTTP, network, configuration, and void behavior stay unchanged. |
| Public Effect channel | `packages/sdk/src/effect-client.ts:23-44,52-87` | `sha256:2534b970afe8a276d76eb2aa62ee79f8bf67e2d998ebf3634cca73523a785dba` | Existing Effect surface and `InternalSdkError` return channel. It is read-only. |
| Adapter unit tests | `packages/sdk/src/__tests__/adapter.test.ts:11-51` | `sha256:c1a70f49d1ef948e941071ecf8027ca9b50a1059e11045634f80732686f6e0f4` | Existing accepted application and interview status cases. The completed tests change only the application-status contract; interview cases stay unchanged. |
| Existing schema compatibility test | `packages/sdk/src/__tests__/schemas.test.ts:78-104` | `sha256:ee413b062371afeb2a1730e430211f5ca8287342262555b1714907ab8366fa72` | Read-only compatibility constraint: `ApplicationFromRaw` decodes raw status `1` to `received`, keeps a non-empty `statusLabel`, and encodes back with numeric `applicationStatus`. The canonical run passed this test unchanged. |
| Public compatibility tests | `packages/sdk/src/__tests__/receipt-effect-v4-compatibility.test.ts:1-274` | `sha256:868004e4b084aaaea8f66ff4e04df6828f9f2bf51949fac618c9c576050abcfa` | Existing Promise and Effect public-shape, malformed-decode, and typed-error evidence pattern. The completed application cases use this public boundary. |
| SDK package authority | `packages/sdk/package.json:1-29` | `sha256:8da9642fba796b4786597a63fef8d1e34b763fb3b8e006de7fd321be2e74482e` | Exact package version, Effect beta.107 edge, public `.` and `./effect` exports, build, test, and ignored `dist` derivation. Read-only. |
| SDK build authority | `packages/sdk/tsconfig.json:1-12` | `sha256:789bcb414c5cfa41de1435e9e46e8571c777484055c8f450927e314b83a5dc80` | Existing declaration and `dist` output boundary. Read-only. |
| Root package authority | `package.json:1-37` | `sha256:a0d0d7ffb7f477cc824ca92b88018cd1ca21a097e26647b53069642ea33f3029` | Workspace and Bun authority. Read-only. |
| Root lock authority | `bun.lock` | `sha256:90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a` | Shared dependency state. No lock or dependency change is permitted. |
| Generated-output ignore | `.gitignore:6-10` | `sha256:626c96922e813d8a373bec3b70adbba72d1bc08f639950623ed624a0cce24801` | Confirms `dist` and build outputs are ignored. Read-only. |
| SDK release derivation | `.github/workflows/release-sdk.yml:25-30` | `sha256:95d33aa8754529e5291793575276ef9f5686a766467b1053010281744423c7c5` | Confirms release derivation builds the SDK before publication. It grants no release or workflow authority here. |
| Effect v4 getter reference | `/srv/share/projects/effect/packages/effect/src/SchemaGetter.ts:484-523` | `sha256:a2f2c85c41eceb1e8092ca15fd6ded1ac90c23a4c44be610200d3feefe1d6682` | Official beta.107 implementation reference for the current pure/infallible getter observation. It is not copied semantic authority. |
| Effect v4 literal reference | `/srv/share/projects/effect/packages/effect/src/Schema.ts:4921-4956` | `sha256:0afa940204ac7602fdd103a9612bd55d005ad042d375412189b4b13341a941bb` | Official beta.107 implementation reference for finite literal validation. It does not dictate a mechanism in this spec. |
| 0018 route return | `apps/dashboard/app/routes/dashboard.sokere._index.tsx:70-143` | `sha256:fe91d4b8e7682dbabbc27f4a428640aa6d0600aeba83aa19850e1514f3b26da8` | Read-only consumer trace. It catches list failures, maps safe errors, and returns no applicant rows on failure. |
| 0018 safe error projection | `apps/dashboard/app/lib/applicant-view.ts:41-110` | `sha256:a6790082e4266422114db31967a3964afae921952cba42a1695400713db6d9c6` | Read-only safe text projection. It keeps the route message stable and does not expose raw error payloads. |
| 0018 browser branch | `apps/dashboard/e2e/applicant-assignment.spec.ts:286-328` | `sha256:746d3c445f8f36972c70361e39b584a1879d56e2e0aa2786e2741aafb93f282d` | Read-only return observation. The unknown-status control expects `Kunne ikke laste søkere` and zero applicant rows. |
| 0018 synthetic fault | `apps/dashboard/e2e/fixtures/applicant-api.ts:311-328` | `sha256:754030da3bd0457cd160f2c5cee53d6d68d89c15a1df90bd6f3a9ce71a120394` | Read-only fixture. It supplies synthetic `applicationStatus: 999` for the return run. |
| Scout report | `agent://SdkStatusDriftScout0019` | Read-only agent report; no file digest | Bounded source investigation. It identifies the list/detail call sites, existing typed channels, smallest owned path set, and the separate `parseInterviewStatus` observation. |

The official Effect files are implementation references only. Product meaning, public error identity, output representation, and lifecycle intent come from this spec, the accepted predecessor authorities, and the existing SDK public contract.

### 1.2 Authority conflicts

The consumed 0010 intent says that its umbrella cutover does not change the SDK. The 0018 intent says that its dashboard route does not change the SDK. Both remain correct. This successor is a new, narrow SDK scope created because 0018 recorded `D-0018-SDK-1` after `CAPSULE-0010` was consumed. No conflict is resolved by editing 0010 or 0018.

If the source, package, official Effect reference, public test behavior, dashboard return observation, lifecycle, charter, or accepted predecessor disagrees, the future writer stops and records `Drift`. The writer does not edit the easiest authority. Product-lead disposition returns intent changes to `Specified` and implementation-only corrections to `Building`.

## 2. Goal, one journey, values, and constraints

### 2.1 Goal

Give one SDK consumer one deterministic local journey in which an external application list and detail response contain an unknown integer `applicationStatus`. The public Promise surface rejects the list and detail operations with the existing `ValidationError` and `type: "validation"`. The public Effect surface fails the list and detail operations with the existing `Validation` and `_tag: "Validation"`. No ordinary `Error` or defect escapes either public typed channel.

The same journey proves that every accepted application status keeps its existing wire integer, domain string, result shape, and display meaning. It then reruns the existing 0018 unknown-status browser branch. The dashboard still shows `Kunne ikke laste søkere`, zero applicant rows, and no raw status value or response payload.

This spec proves only the application-status decode boundary. It does not prove the backend, API Platform, OpenAPI, provider, database, production route, or whole SDK.

### 2.2 One felt consumer journey

The felt journey is a maintainer consuming the same application data through the SDK while an external service returns malformed status data. Promise and Effect calls are two public representations of the same consumer boundary. List and detail are the two application read shapes. They are not separate product journeys.

1. The maintainer starts with an explicit synthetic API base and no external network capability.
2. The synthetic list response contains a valid application shape with `applicationStatus: 999`, an unknown integer outside the accepted set.
3. The maintainer calls `client.admin.applications.list()` on the public Promise surface.
4. The operation rejects with the existing `ValidationError`. The rejected value has `type: "validation"`. It is not an ordinary `Error` escape.
5. The synthetic detail response for the same application contains `applicationStatus: 999`.
6. The maintainer calls `client.admin.applications.get(101)` on the public Promise surface.
7. The operation rejects with the same public typed validation contract.
8. The maintainer repeats list and detail through `createEffectClient`.
9. Each Effect fails with `_tag: "Validation"`, not a defect or ordinary thrown error.
10. The maintainer sends each accepted integer `-1, 0, 1, 2, 3, 4, 5` through list and detail fixtures. Each result keeps its existing status string and fields.
11. The maintainer reruns the existing 0018 loopback branch with the synthetic unknown-status control. The route shows `Kunne ikke laste søkere`, renders zero applicant rows, and does not show `999` or the raw response.
12. The maintainer records sanitized evidence, removes generated SDK output, and leaves the worktree clean.

The unknown list and detail observations are required branches in this one journey. They do not authorize a detail-page change, a new dashboard flow, or a second implementation PR.

### 2.3 Values

1. **Public typed failure.** Malformed external data is a validation result at the SDK boundary. It is never an ordinary thrown defect.
2. **Compatibility.** Accepted application status integers and their string representations remain unchanged.
3. **One boundary owner.** The SDK remains the sole owner of application wire decoding. Consumers do not cast or repair status data.
4. **No invented error surface.** The journey uses the existing `ValidationError` and `Validation` channels. It adds no error class, export, tag, or public method.
5. **Fail closed.** An unknown status produces no partial application, empty-success substitute, default status, or raw value in the dashboard route.
6. **List/detail parity.** The list item and detail value apply the same status contract.
7. **Small successor.** The slice closes only `D-0018-SDK-1`. It does not make a global SDK-totality claim.
8. **Evidence limits.** Synthetic inputs prove only the named local SDK boundary and the existing 0018 return branch.
9. **Reversible local work.** Only in-memory synthetic input and ignored generated output existed during verification. No remote cleanup exists.
10. **Honest lifecycle.** This accepted spec records implementation and complete local evidence at `Building`. It does not claim a PR, conformance, rollout, or operation.

### 2.4 Constraints

- The current base is exactly `52338a4802dca9a53558c0236ea8161674d8ce8c`.
- The completed implementation owned exactly four source or test paths listed in §7. No other tracked path changed.
- The completed implementation changed only application-status behavior. It did not change `parseInterviewStatus`, interview schemas, interview results, or any other status parser.
- The accepted status set is exactly the seven current raw integers `-1, 0, 1, 2, 3, 4, 5` and the seven current string values listed in §3.
- The Promise and Effect public method names, namespaces, arguments, result representations, URL paths, HTTP mapping, and exports remain unchanged.
- The existing `ValidationError`, `.type`, internal `Validation`, and `_tag` are the only typed error identities used by this slice.
- The list operation uses the existing collection response shape. The detail operation uses the existing single-application response shape.
- The 0018 route, route helper, browser test, and synthetic fixture remained read-only. The canonical runtime reran their existing unknown-status branch without editing them.
- The run used only fixed synthetic records and mocked or loopback fetch boundaries. It did not use provider, backend, production, remote, credentials, PII, or data access.
- No package manifest, dependency, lock, OpenAPI document, transport, error, Promise, Effect client, public export, or generated artifact was committed.
- The focused SDK checks and existing 0018 return branch passed. No full dashboard, backend, provider, remote, or release claim follows.
- Any disagreement with an authority enters `Drift`. A later writer stops and reports it.

### 2.5 Explicit non-goals

This slice does not:

- change the 0010 or 0018 intent, status, evidence, source, route, fixture, or specification;
- implement or change the dashboard route, dashboard view projection, dashboard browser test, or dashboard fixture;
- change `parseInterviewStatus`, interview status schemas, interview domain behavior, interview transport, or a global SDK-totality policy;
- change transport, HTTP status mapping, network mapping, configuration mapping, error classes, internal tags, Promise projection, Effect client, public exports, method names, or package API;
- alter `Application`, `ApplicationDetail`, `ApplicationStatus`, status labels, list pagination, detail fields, or accepted result representations;
- alter OpenAPI, Symfony, API Platform, server controllers, serializers, authorization, persistence, migrations, database state, Worker code, or domain laws;
- add retries, fallback status values, aliases, compatibility shims, generic decoder infrastructure, a new error class, or a new public constructor;
- change `package.json`, `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `bun.lock`, workflow files, or dependency resolution;
- commit `packages/sdk/dist/**`, `*.tsbuildinfo`, test output, logs, browser output, or any evidence file;
- access provider, cloud, remote, production, credentials, operational data, real PII, or external network;
- claim SDK-wide totality, backend parity, deployment success, production safety, release readiness, route cutover, or rollback authority.

## 3. Current semantic contract

### 3.1 Accepted application status values

The current wire and domain values are fixed. The completed implementation preserves both sides of this table.

| Raw `applicationStatus` integer | Existing `Application.status` value | Existing label meaning |
|---:|---|---|
| `-1` | `cancelled` | `Avbrutt` |
| `0` | `not_received` | `Ikke mottatt` |
| `1` | `received` | `Mottatt` |
| `2` | `invited` | `Invitert` |
| `3` | `accepted` | `Akseptert` |
| `4` | `completed` | `Fullført` |
| `5` | `assigned` | `Tildelt skole` |

These values are semantic and byte compatible with the current SDK contract. The completed implementation did not reorder, rename, remove, add, or normalize them.

### 3.2 Unknown status contract

An external integer outside the accepted set is invalid application data. The list and detail operations must reject it before returning an `Application` or `ApplicationDetail` value.

| Public operation | Malformed input | Required result | Forbidden result |
|---|---|---|---|
| Promise `admin.applications.list()` | Any collection member has unknown integer `applicationStatus`, including synthetic `999` | Reject existing public `ValidationError` with `type: "validation"` | Ordinary `Error`, defect, partial item, default status, empty-success result, or raw payload |
| Promise `admin.applications.get(101)` | Detail has unknown integer `applicationStatus`, including synthetic `999` | Reject existing public `ValidationError` with `type: "validation"` | Ordinary `Error`, defect, partial detail, default status, or raw payload |
| Effect `admin.applications.list()` | Same malformed collection member | Fail with existing internal `Validation` and `_tag: "Validation"` | Defect, ordinary thrown error, partial item, or successful empty collection |
| Effect `admin.applications.get(101)` | Same malformed detail | Fail with existing internal `Validation` and `_tag: "Validation"` | Defect, ordinary thrown error, partial detail, or successful value |

The Promise result is still the existing page-compatible object for valid input. The detail result is still the existing `ApplicationDetail` value for valid input. The Effect result types remain the existing values with the existing `InternalSdkError` channel.

### 3.3 List and detail representations

The list input remains a Hydra collection with `hydra:member` and the existing optional `hydra:totalItems`. The detail input remains the current single application object. Every other accepted field keeps its current type and meaning.

For a valid record, the public result retains the existing fields:

- `id`;
- `userName`;
- `userEmail`;
- `status` as one of the seven existing string values;
- `interviewStatus`;
- `interviewer`;
- `interviewScheduled`; and
- `previousParticipation`.

A malformed status never returns a record with missing, `undefined`, default, or raw `applicationStatus` output. It returns the typed validation result instead.

### 3.4 Error and transport boundary

The typed error contract applies to decode failure only. Existing HTTP, network, configuration, conflict, not-found, rate-limit, and void behavior remains unchanged. This slice does not reinterpret status codes or change error messages outside the existing validation channel.

The public Promise surface exposes the existing `ValidationError`. Its `type` is exactly `"validation"`. The public Effect surface exposes the existing `Validation` tag through `InternalSdkError`; its `_tag` is exactly `"Validation"`. The retained evidence records classification and tag without retaining raw decoder text or payload values.

The route boundary remains downstream and read-only. The route maps the typed failure to safe Norwegian text. It does not display the unknown integer, the raw body, a stack trace, or the decoder payload.

## 4. Pre-implementation observation and resolved defect

The following observations are grounded in the exact pre-implementation base and the named scout report. They are historical baseline facts. The canonical implementation and evidence below resolve the application-status defect without broadening the capsule.

| ID | Historical observation | Evidence and boundary |
|---|---|---|
| `O-0019-1` | At the pre-implementation base, `APPLICATION_STATUS_MAP` contained exactly `-1, 0, 1, 2, 3, 4, 5`. `parseApplicationStatus` returned the mapped string for known values and threw ordinary `Error` for an unknown number such as `99`. | `packages/sdk/src/adapter/status.ts:5-13,23-34`; `adapter.test.ts:11-30`. This is the red source observation. |
| `O-0019-2` | Both `ApplicationFromRaw` and `ApplicationDetailFromRaw` called `parseApplicationStatus` while producing the status field. | `packages/sdk/src/schemas/application.ts:64-87,115-138`. This is the pre-implementation source observation. |
| `O-0019-3` | The existing transport mapped schema failures to internal `Validation`, and the existing Promise wrapper mapped only `InternalSdkError` through `toSdkError`. | `transport.ts:193-224`; `promise.ts:66-76`; `errors.ts:98-104,139-156`. This read-only boundary remains unchanged. |
| `O-0019-4` | The official Effect v4 reference described `SchemaGetter.transform` as a pure, infallible transformation. The red baseline recorded the ordinary throw as an Effect `Die` defect; the canonical green run records typed `Validation` failure with `dies: false`. | `/srv/share/projects/effect/packages/effect/src/SchemaGetter.ts:484-523`; red/green evidence in `/tmp/mono-web-application-status-evidence-0019-20260812/` and canonical gate evidence. |
| `O-0019-5` | The 0018 synthetic fixture changes the first applicant's `applicationStatus` to `999`. The canonical rerun displays the exact refined alert `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`, keeps zero applicant rows, and hides the raw value and payload. | `apps/dashboard/e2e/fixtures/applicant-api.ts:311-328`; `apps/dashboard/e2e/applicant-assignment.spec.ts:299-308`; `apps/dashboard/app/lib/applicant-view.ts:50-110`; canonical `dashboard-return.json`. The route and fixture remain read-only. |
| `O-0019-6` | The SDK package exposes Promise `.` and Effect `./effect`, builds with `tsc -b`, and emits ignored `dist`. | `packages/sdk/package.json:5-19`; `packages/sdk/tsconfig.json:1-12`; `.gitignore:6-10`; release workflow `:25-30`; canonical runtime gate. No package or export change occurred. |
| `O-0019-7` | `parseInterviewStatus` also throws an ordinary `Error` for an unknown number. | `packages/sdk/src/adapter/status.ts:15-21,27-40`; `adapter.test.ts:33-50`. This remains a separate potential successor and does not support a global SDK-totality claim. |

Before repair, the 0018 route failed closed while the malformed SDK value could escape as an ordinary error. The accepted 0019 implementation repairs that SDK typed-channel contract without changing the route mechanism or safe result.

## 5. Synthetic input and output boundaries

### 5.1 Synthetic records

The focused SDK evidence used synthetic records only. The records were held in memory or returned by a mocked local fetch. No request reached an external network.

| Fixture | Required value |
|---|---|
| Fixture ID | `application-status-typed-decode-0019` |
| Base URL | `https://application-status-fixture.invalid` passed to a mocked `fetch`; no external request is permitted |
| List member A | `id: 101`; accepted application fields; `applicationStatus: 999` for the malformed branch |
| List member B | `id: 102`; accepted application fields; `applicationStatus: 1` for a valid comparison |
| Detail record | `id: 101`; the same accepted fields; `applicationStatus: 999` for the malformed branch |
| Accepted status pass | One synthetic record per raw value `-1, 0, 1, 2, 3, 4, 5` |
| Auth | No credential. The mocked fetch records no auth value. |

The raw `999` value was a test input. It does not appear in the route DOM, sanitized evidence, committed output, logs, or retained error text. Focused tests asserted it in memory before sanitization.

### 5.2 Input boundary

| Operation | Input shape | Unknown-status location |
|---|---|---|
| `admin.applications.list()` | `200` Hydra object with `hydra:member` array and `hydra:totalItems` | Any member's `applicationStatus`, including member `101` |
| `admin.applications.get(101)` | `200` raw application object | The detail object's `applicationStatus` |

The fixture must use the existing URL path and request shape. It must not create a new endpoint or bypass the application domain method.

### 5.3 Output boundary

| Operation | Valid output | Unknown-status output |
|---|---|---|
| Promise list | Existing `{ items, totalItems, page, pageSize }` with `Application` items | Rejected `ValidationError`, `type: "validation"` |
| Promise detail | Existing `ApplicationDetail` representation | Rejected `ValidationError`, `type: "validation"` |
| Effect list | Existing Effect value with the same page-compatible result | Failed `Validation` with `_tag: "Validation"` |
| Effect detail | Existing Effect value with the same `ApplicationDetail` representation | Failed `Validation` with `_tag: "Validation"` |

No accepted output field changes. No new output wrapper is permitted. No caller catches the malformed result into `[]`, `null`, a default status, or an invented detail.

### 5.4 0018 return boundary

The canonical runtime reran, without edits, the existing 0018 browser branch:

- control: `applications-list` with malformed selector `unknown-application-status`;
- synthetic input: fixture status `999`;
- route: `/dashboard/sokere?status=new`;
- pre-fix visible alert: `Kunne ikke laste søkere.`;
- post-repair visible alert: `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`;
- existing assertion: the stable `Kunne ikke laste søkere` prefix remains present;
- applicant rows: `0`;
- raw status value: absent from visible UI and sanitized evidence;
- raw payload or stack trace: absent from visible UI and sanitized evidence;
- route, fixture, route helper, existing labels, and existing interaction: unchanged. The sentence refinement is existing `ValidationError` projection behavior, not route-intent Drift.

This rerun proves that the successor preserves the existing 0018 fail-closed user observation while exercising the typed-error projection. It is preservation evidence, not proof of the Promise or Effect typed identities; `E-0019-5` and `E-0019-6` record those identities. It does not prove a dashboard implementation change.

## 6. Ownership and semantic limits

### 6.1 Implementation ownership

The completed implementation owned only the four paths in §7. It changed application-status lookup and the two application raw-status boundaries, then updated the two named tests. It did not own the transport or public projection that carries the typed result.

The acceptance test is behavior-first. It does not require a specific schema constructor, helper name, exception class inside the decoder, code layout, or private implementation algorithm. The mechanism is accepted because the public and adapter observations in §3 and §9 pass.

### 6.2 Read-only public and consumer boundaries

The following remain read-only:

- `packages/sdk/src/errors.ts`, `transport.ts`, `promise.ts`, and `effect-client.ts`;
- `packages/sdk/src/__tests__/schemas.test.ts:78-104`, an existing read-only compatibility test for `ApplicationFromRaw` decode, `statusLabel`, and numeric encode round-trip;
- all public export files and package entrypoints;
- `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, root `package.json`, and `bun.lock`;
- `apps/dashboard/app/routes/dashboard.sokere._index.tsx`;
- `apps/dashboard/app/lib/applicant-view.ts`;
- `apps/dashboard/e2e/applicant-assignment.spec.ts` and its fixture;
- `design-specs/0010-dashboard-bun-sdk-resolution.md` and `design-specs/0018-dashboard-applicant-assignment-sdk-seam.md`.

A later implementation cannot edit a read-only path to make a focused check pass. It records `Drift` and returns to the owning lane.

### 6.3 Adjacent parser boundary

`parseInterviewStatus` remains an observed ordinary-error escape in the same adapter file. It is explicitly out of scope. The completed implementation left its behavior, tests, schemas, and callers unchanged. 0019 makes no claim that every SDK adapter or every `SchemaGetter` path is total. A future interview-status successor needs its own Need, accepted spec, owner, evidence, and Drift path.

## 7. Scope and exact paths

### 7.1 Completed mutable paths

The implementation changed exactly these paths:

1. `packages/sdk/src/adapter/status.ts` — application-status behavior only. `parseInterviewStatus` remains read-only within this path.
2. `packages/sdk/src/schemas/application.ts` — application list and detail status input behavior only. Other application fields and result representations stayed unchanged.
3. `packages/sdk/src/__tests__/adapter.test.ts` — application-status adapter contract and existing accepted cases. Interview-status tests stayed unchanged.
4. `packages/sdk/src/__tests__/receipt-effect-v4-compatibility.test.ts` — public Promise and Effect application list/detail red-green contract and valid-value compatibility cases.

No fifth tracked path changed. This docs revision changes only `design-specs/0019-application-status-typed-decode.md`.

### 7.2 Forbidden paths and effects

The implementation did not change:

- `design-specs/0010-dashboard-bun-sdk-resolution.md`, `design-specs/0018-dashboard-applicant-assignment-sdk-seam.md`, or any other design spec, lifecycle, charter, status, handoff, domain, or authority file;
- `apps/dashboard/**`, including the 0018 route, helper, fixture, Playwright test, labels, and route behavior;
- interview parser or schema behavior, including `parseInterviewStatus` and interview status tests;
- `packages/sdk/src/transport.ts`, `errors.ts`, `promise.ts`, `effect-client.ts`, public export files, or unrelated SDK schemas/domains;
- `packages/sdk/src/__tests__/schemas.test.ts:78-104`; this existing compatibility test is read-only and is not a fifth owned path;
- `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, root `package.json`, `bun.lock`, `.github/workflows/**`, `.githooks/**`, or dependency metadata;
- `packages/sdk/openapi.json`, backend, Symfony, API Platform, server, Worker, database, migration, persistence, or domain paths;
- `packages/sdk/dist/**` as a committed path. Ignored output can exist only during a local build and must be removed;
- provider, cloud, remote, production, credential, PII, data, deployment, release, route-cutover, or publication resources.

No dependency or lock change is authorized. No provider or remote command is authorized. No data cleanup is authorized because no data is created.

## 8. Dependencies, conflicts, and Drift closure

### 8.1 Dependency graph

```text
lifecycle + product-lead charter
  → consumed 0010 SDK/workspace authority
  → 0018 dashboard consumer authority
  → historical open D-0018-SDK-1 unknown application-status escape (superseded)
  → 0019 accepted typed-decode intent
  → four-path SDK implementation and focused red-green evidence
  → existing 0018 unknown-status branch rerun
  → independent review and product-lead implementation acceptance
  → D-0018-SDK-1 closed
  → later SDK or dashboard work may consume the closed edge
```

0019 is the accepted successor of the historical open Drift. Its four-path implementation, typed evidence, canonical 0018 rerun, independent review, and product-lead implementation acceptance complete the return. The 0018 implementation remains read-only and keeps its safe route result.

### 8.2 Dependency and conflict table

| Item | State | Required treatment |
|---|---|---|
| Lifecycle and charter | Active outer authorities | Follow their one-home, gate, capsule, evidence, Drift, and operator rules. |
| 0010 consumed cutover | Accepted and consumed | Preserve its no-SDK-change intent for 0010. Do not reopen or edit it. |
| 0018 dashboard seam | Accepted predecessor with local evidence | Preserve route behavior and its no-SDK-edit boundary. The canonical 25e rerun records the refined alert and zero-row return. |
| `D-0018-SDK-1` | **Closed dependency Drift** | The accepted 0019 return completed the four-path implementation, red/green typed evidence, valid-value evidence, canonical 0018 rerun, independent review, integration mapping, and product-lead disposition. |
| Application status source and schemas | Exact source and canonical graphs recorded | The implementation changed only the four-path application-status capsule. The source candidate and canonical blobs have four-path SHA-256 parity. |
| Existing typed channels | Read-only transport, error, Promise, and Effect sources | Consume existing public error identities. No channel, mapping, export, or alias was added. |
| Official Effect v4 source | Local implementation reference | The exact installed beta.107 source was inspected. It was not copied into repository semantics and the dependency did not change. |
| Package and lock | Shared immutable resources | Base hashes were rechecked. No dependency or lock entry changed. |
| Dashboard return evidence | Read-only 0018 fixture and test | The canonical runtime reused the synthetic `999` branch. No dashboard file changed and no UI implementation claim is made. |
| `parseInterviewStatus` | Separate observed potential successor, not active Drift | Leave untouched. A future spec owns it. No global-totality claim is valid. |
| Provider, remote, data, credentials | Forbidden | No such effect occurred. |

### 8.3 Explicit closure edge for `D-0018-SDK-1`

The historical open row below is retained only as superseded baseline history:

| Drift ID | Historical observation | Completed owner and return | Lifecycle effect |
|---|---|---|---|
| `D-0018-SDK-1` | At the pre-implementation base, the application status lookup threw an ordinary `Error` for unknown integer `applicationStatus`. Both list and detail decoding used that path. The 0018 route observed a safe list error with zero applicant rows. | Owner: 0019 SDK successor lane. Return completed by source `07e66d3d1a39e357c0b69692908f47f1cde115c8` → `964f1b663f88d55c76a1fe7848e6960d4ddb1b89` → `d6c6edc2720b39ff3f2348bad16c3646568ef3cc`, canonical `9cb199ca8f320095a9449a348a3b4bf006d588cd` → `f2fdf4afce57cdad3c43e8564f9be67f032c6ab3` → `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`, `agent://ApplicationStatusCodeReview0019`, `agent://ApplicationStatusRuntimeVerify0019`, `agent://ApplicationStatusIntegration0019`, and product-lead `ACCEPT` on `2026-08-12`. | **Closed.** The linked dependency is resolved for this slice. The lanes remain `Building` because no frozen/open one-to-one PR exists; no higher lifecycle state is claimed. |

Closure is now a recorded fact. The canonical handoff names the implementation graph, red baseline, passing typed evidence, valid-value compatibility evidence, 0018 rerun, independent review, integration mapping, product-lead disposition, and cleanup.

If a later authority changes, a new Drift entry is required. The lifecycle return is `Specified` for intent change and `Building` for implementation-only correction. This closed row is not reopened by the historical baseline.


## 9. Verification and local evidence plan

Every evidence item names one claim and one limit. The following table records the completed local and synthetic evidence; it does not grant a PR or higher lifecycle state.

| ID | Completed artifact or scenario | Claim verified | Limit |
|---|---|---|---|
| `E-0019-0` | Canonical graph, base, branch, worktree, four-path, source-parity, and clean-state review in `gate-summary.json` | Canonical head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f` has parent `f2fdf4afce57cdad3c43e8564f9be67f032c6ab3`; exactly four implementation paths changed; tracked status and diff check are clean | Does not prove behavior or unrelated repository history |
| `E-0019-1` | Historical red Promise list check from base `3ac8520041aebc7b92e3599762d94d975ca082de`, sanitized evidence `evidence.json` SHA-256 `a2a999711dab626159b7376e3e6734adaee004fcdd2f7fa2261922e6b76fe20e` | Malformed list status produced the ordinary `Error` escape instead of public `ValidationError` | Baseline only; not an accepted result |
| `E-0019-2` | Historical red Promise detail check in the same sanitized evidence | Malformed detail status produced the ordinary `Error` escape instead of public `ValidationError` | Baseline only; not an accepted result |
| `E-0019-3` | Historical red Effect list/detail checks in the same sanitized evidence | Malformed list/detail status produced Effect `Die` defects instead of typed `Validation` failure | Baseline only; raw error text is omitted |
| `E-0019-4` | Canonical adapter and seven-status compatibility checks | Known `-1, 0, 1, 2, 3, 4, 5` mappings remain unchanged and unknown input returns a non-throwing absence; interview status remains outside scope | It proves only the application-status adapter |
| `E-0019-5` | Canonical green Promise list/detail checks in `typed-channels.json` SHA-256 `02b48d25b013e407c0ad63681cf2e4eda350ed0166732663b80542a934f3d5eb` | Both operations reject existing `ValidationError` with `type: "validation"` and `ordinaryError: false` | It proves only the tested list/detail input shapes |
| `E-0019-6` | Canonical green Effect list/detail checks in the same typed artifact | Both operations fail with `_tag: "Validation"`, `fails: true`, `dies: false`, and no ordinary error | It proves only the tested Effect client methods |
| `E-0019-7` | Canonical valid-status and read-only schema compatibility checks | Seven statuses, non-empty `statusLabel`, decoded `received`, numeric encoded `applicationStatus`, and existing result representations remain compatible | It does not prove arbitrary external data or backend parity |
| `E-0019-8` | Canonical 0018 return in `dashboard-return.json` SHA-256 `ac30491d688544bbd22fcd81cf890afea3fb9182b8ecadb56269fe56b3594487` | Existing journey exits `0`, passes `1` and skips `1`, shows `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`, renders zero Applicant One rows, hides raw unknown/payload, and makes zero product requests | Preservation evidence only; it does not prove a dashboard implementation change |
| `E-0019-9` | Canonical focused SDK run and build | Exact Bun `1.3.10`, three focused files, `47/47` tests, and `tsc -b` exit `0`; no dependency or lock mutation | It is not a full repository or full dashboard check |
| `E-0019-10` | Canonical stub and cleanup artifacts: `stub-evidence.json` SHA-256 `b7b96dfa0024f4835691832eb3f0beafb6839b3a874318e6696062af0a97ef8b` and gate summary SHA-256 `a7ca59c0323ac1eb016550f37dd2bd6ad8a49431e13868b7bd083f4894834aab` | Loopback-only requests, no raw unknown/token/payload, overlay/dist/dashboard outputs removed, ignored state unchanged, ports/processes closed, and worktree clean | Cleanup does not prove unrecorded behavior |
| `E-0019-11` | Final canonical changed-path, Drift, review, and product-lead disposition | The capsule is complete, `D-0018-SDK-1` is closed, and no forbidden path changed | It does not establish `Experienceable` or `Conforming` |

### 9.1 Red-green order

The source evidence recorded the public malformed-status assertion before repair. The red result showed the ordinary escape for list and detail on both public surfaces. The record kept classifications only and omitted raw exception text and payload.

The canonical green result showed:

- Promise list rejects `ValidationError` with `type: "validation"`;
- Promise detail rejects `ValidationError` with `type: "validation"`;
- Effect list fails with `_tag: "Validation"`;
- Effect detail fails with `_tag: "Validation"`;
- no ordinary `Error` or defect escapes those four operations;
- all seven accepted values remain unchanged; and
- application-status adapter lookup is total for unknown input.

The checks exercised public methods. A private helper assertion was not accepted as evidence.

### 9.2 Exact focused checks

The canonical run used the existing package commands in the SDK scope:

```text
bun --cwd=packages/sdk run test -- src/__tests__/adapter.test.ts src/__tests__/schemas.test.ts src/__tests__/receipt-effect-v4-compatibility.test.ts
bun --cwd=packages/sdk run build
```

The source red check ran before repair. The canonical final check passed with three files, `47/47` tests, and `tsc -b` exit `0`. The read-only `schemas.test.ts:78-104` compatibility assertions passed unchanged. The build created ignored `packages/sdk/dist/**` from the repaired source.

The canonical runtime reran the existing 0018 unknown-status branch using its fixed loopback fixture while rebuilt `packages/sdk/dist/**` was present. The 0018 fixture and test were not changed. The route preserved the `Kunne ikke laste søkere` prefix, showed the exact refined alert in §5.4, rendered zero applicant rows, and exposed no raw value or payload.

The canonical cleanup removed `packages/sdk/dist/**`, generated output, temporary logs, dependency overlays, and dashboard outputs after the rerun. Final tracked and ignored state was clean, ports were closed, and owned processes were absent.

The pre-implementation authoring revision ran none of these commands. That historical note is superseded by the completed evidence recorded in §9.3 and the canonical gate artifacts.

### 9.3 Sanitized evidence schema

The pre-implementation template below names the required classifications and stable labels and is retained as the historical schema. The canonical run recorded those classifications across `gate-summary.json`, `typed-channels.json`, `dashboard-return.json`, and `stub-evidence.json`, which use their own key layouts. No retained artifact keeps raw bodies, decoder messages, status `999`, names, email addresses, tokens, cookies, credentials, or stack traces.


```json
{
  "seed": "application-status-typed-decode-0019",
  "base": "52338a4802dca9a53558c0236ea8161674d8ce8c",
  "canonicalHead": "25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f",
  "canonicalParent": "f2fdf4afce57cdad3c43e8564f9be67f032c6ab3",
  "cases": [
    {
      "surface": "promise",
      "operation": "admin.applications.list",
      "inputClass": "unknown-application-status-integer",
      "outcome": "reject",
      "errorClass": "ValidationError",
      "errorType": "validation",
      "ordinaryError": false,
      "defect": false
    },
    {
      "surface": "promise",
      "operation": "admin.applications.get",
      "inputClass": "unknown-application-status-integer",
      "outcome": "reject",
      "errorClass": "ValidationError",
      "errorType": "validation",
      "ordinaryError": false,
      "defect": false
    },
    {
      "surface": "effect",
      "operation": "admin.applications.list",
      "inputClass": "unknown-application-status-integer",
      "outcome": "fail",
      "errorTag": "Validation",
      "ordinaryError": false,
      "defect": false
    },
    {
      "surface": "effect",
      "operation": "admin.applications.get",
      "inputClass": "unknown-application-status-integer",
      "outcome": "fail",
      "errorTag": "Validation",
      "ordinaryError": false,
      "defect": false
    }
  ],
  "validStatusCases": [
    "cancelled",
    "not_received",
    "received",
    "invited",
    "accepted",
    "completed",
    "assigned"
  ],
  "adapterUnknownCase": {
    "inputClass": "unknown-application-status-integer",
    "outcome": "non-throwing-absence"
  },
  "schemaCompatibility": {
    "applicationFromRawValidDecode": true,
    "applicationFromRawStatusLabel": true,
    "applicationFromRawNumericEncodeSyncRoundTrip": true
  },
  "dashboardReturn": {
    "alert": "Kunne ikke laste søkere. Kontroller dataene og prøv igjen.",
    "path": "/dashboard/sokere?status=new",
    "alertPrefix": "Kunne ikke laste søkere",
    "applicationRows": 0,
    "rawStatusVisible": false,
    "rawPayloadVisible": false
  },
  "requestBoundary": {
    "externalNetwork": false,
    "syntheticInput": true,
    "unexpectedHosts": []
  },
  "cleanup": {
    "sdkDistPresent": false,
    "rawPayloadRetained": false,
    "worktreeClean": true
  }
}
```

A red baseline artifact uses the same case labels with `errorClass: "ordinary-Error"` or `errorTag: "defect"` as observed. It must never include the raw exception message. The green artifact replaces those classifications with the typed results shown above.

### 9.4 Evidence destination and retention

Canonical sanitized evidence is retained at:

```text
/tmp/mono-web-application-status-runtime-gate-0019-canonical-25e-20260812/
```

The source red baseline remains historical and sanitized at `/tmp/mono-web-application-status-evidence-0019-20260812/evidence.json`. The canonical artifacts are the current local evidence authority. No repository evidence file or PR evidence attachment exists. Keep only the sanitized JSON, command statuses, commit identities, artifact hashes, and named review/runtime references.

## 10. Counterexamples and falsifiers

Any item below fails this slice even if the valid-status cases pass:

1. Promise list rejects an ordinary `Error`, a defect, an untyped value, or a public error with a type other than `"validation"` for unknown `applicationStatus`.
2. Promise detail has the same ordinary or untyped escape.
3. Effect list or detail fails as a defect or ordinary thrown error instead of `_tag: "Validation"`.
4. The unknown status returns a partial `Application`, `ApplicationDetail`, empty collection, default status, raw integer, or successful `undefined` result.
5. Any accepted raw integer maps to a different string, label, field, collection shape, detail shape, or encoded representation.
6. List and detail use different unknown-status outcomes.
7. The public result requires a new error class, new export, new tag, new method, new wrapper, or changed namespace.
8. The malformed input becomes a visible raw value, raw body, decoder payload, stack trace, or token in the 0018 route or retained evidence.
9. The 0018 rerun loses the `Kunne ikke laste søkere` prefix, renders applicant rows, exposes a raw value or payload, or changes route/UI intent beyond the expected alert sentence refinement from the ordinary fallback to the existing `ValidationError` projection. The sentence refinement is not a falsifier.
10. The implementation changes `parseInterviewStatus`, interview schemas, interview tests, or claims global SDK totality.
11. The implementation edits transport, errors, Promise, Effect client, public exports, package metadata, OpenAPI, backend, dashboard, root lock, or any forbidden path.
12. A dependency or lock entry changes, or committed `dist`/test/browser output appears.
13. The red run does not demonstrate the current ordinary escape before the repair, or the green run checks only a private helper.
14. The focused checks contact a non-loopback or external host, load credentials, or retain raw fixture data.
15. The 0018 browser branch is skipped, modified, or replaced by a new dashboard test.
16. Evidence claims backend behavior, API parity, provider success, deployment, production data, route cutover, release, or `Conforming`.
17. The writer closes `D-0018-SDK-1` before the typed Promise/Effect evidence, valid-value evidence, 0018 rerun, independent review, and product-lead disposition.
18. A source, package, lifecycle, charter, predecessor, or runtime conflict is resolved by editing the easiest file instead of entering `Drift`.

## 11. Definition of done

The 0019 implementation and closure handoff are complete for this bounded slice. The following conditions are objectively recorded:

1. The accepted spec and independent reviews preceded implementation. Product-lead intent acceptance and implementation acceptance are recorded on `2026-08-12`.
2. The writer started from base `52338a4802dca9a53558c0236ea8161674d8ce8c` in the named worktree. The final implementation changed only the four owned SDK source/test paths.
3. The package, tsconfig, root lock, source authority, and read-only path hashes were rechecked. No dependency or lock entry changed.
4. The red run recorded the ordinary Promise `Error` escape and Effect `Die` defect for malformed list and detail status.
5. The application-status adapter lookup is total for unknown input. The seven accepted raw integers return the seven existing status strings.
6. Promise `admin.applications.list()` and `admin.applications.get(101)` reject the existing `ValidationError` with `type: "validation"` for unknown `applicationStatus`.
7. Effect `admin.applications.list()` and `admin.applications.get(101)` fail with the existing `Validation` and `_tag: "Validation"` for the same input.
8. No ordinary `Error` or defect escapes any of the four malformed public operations. No partial value, default, empty-success fallback, or raw payload is returned.
9. Valid list and detail outputs preserve every accepted application field, status string, result wrapper, and semantic representation. HTTP, network, configuration, and unrelated SDK mappings remain unchanged.
10. The read-only `packages/sdk/src/__tests__/schemas.test.ts:78-104` passes unchanged: raw status `1` decodes to `received`, `statusLabel` remains non-empty, and numeric `applicationStatus` survives encode.
11. `parseInterviewStatus` and all interview behavior remain unchanged. No global SDK-totality claim appears in code, evidence, or handoff.
12. The existing 0018 unknown-status branch ran without dashboard edits against rebuilt ignored `packages/sdk/dist/**`. It preserved the `Kunne ikke laste søkere` prefix, zero applicant rows, no raw value, no raw payload, and the exact refined alert.
13. Focused SDK tests and `bun --cwd=packages/sdk run build` passed. The 0018 rerun completed before generated output and temporary state were removed.
14. Sanitized evidence records the four typed outcomes, valid cases, adapter totality, schema compatibility, 0018 return, no external network, and cleanup. It contains no raw value, payload, token, credential, PII, or stack trace.
15. The final implementation worktree is clean. `git diff --check` passed. No forbidden path changed.
16. The handoff names the source and canonical graphs, parents, changed paths, test/build results, 0018 rerun, evidence destination and hashes, independent reviews, integration mapping, and product-lead disposition.
17. `D-0018-SDK-1` is closed after the preceding conditions and accepted evidence disposition. No open linked Drift remains.

These conditions prove only this application-status SDK slice. They do not establish a full SDK, dashboard, backend, provider, production, or release gate.

## 12. No rollout, rollback, and cleanup

### 12.1 No rollout

This spec has no rollout, deployment, publication, route cutover, production traffic, or operating phase. It changes a local SDK contract only. A later accepted backend, consumer, or release spec owns any rollout and operator authority.

### 12.2 Rollback

- If a future implementation fails a focused check, revert only the four owned source/test paths in that implementation branch.
- Do not revert or edit 0010, 0018, dashboard files, transport, errors, public exports, package metadata, root lock, backend, or provider state.
- If the typed result, valid representation, or 0018 return differs from this spec, stop and record `Drift`. Do not broaden the capsule.
- If an external, credential, provider, remote, production, or data effect appears, stop before the effect and notify the product lead and operator. This spec grants no authority.
- No remote rollback exists. The only mutable local state is in-memory synthetic fetch state and ignored generated output.

### 12.3 Cleanup

Canonical cleanup completed after the 0018 rerun:

1. Mocked `fetch` and process environment were restored.
2. `packages/sdk/dist/**`, TypeScript build info, test/browser output, temporary logs, dependency overlays, and raw fixture records were removed.
3. No credential, token, cookie, PII, raw payload, unknown raw value, or stack trace remains in the evidence destination.
4. No process, listener, timer, or loopback fixture remains active; ports `5174` and `8789` are closed.
5. `bun.lock` and all forbidden paths remain unchanged.
6. Only sanitized evidence, command statuses, commit identities, and review references were retained.
7. The canonical worktree is clean.

## 13. Lifecycle gates and Drift

| Lifecycle row | Current state and required evidence |
|---|---|
| `Need` | Historical predecessor need: 0018 recorded the application-status boundary issue after the consumed 0010 capsule could not own an SDK repair. The accepted 0019 successor satisfies this need for the named slice. |
| `Specified` | Completed pre-implementation state. The one journey, semantic contract, authorities/hashes, scope, evidence, falsifiers, DoD, rollback, cleanup, and Drift closure edge were recorded before implementation. |
| `Ready` | Historical and superseded. Intent acceptance, dependencies, conflicts, exact base, and the capsule were recorded before implementation. |
| `Building` | **Current.** The four-path implementation and complete local evidence are accepted at canonical `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; source/canonical graphs, PASS reviews, cleanup, and `D-0018-SDK-1` closure are recorded. No frozen/open one-to-one PR exists. |
| `Experienceable` | Not entered. It requires a frozen accepted spec and an open one-to-one PR with objective evidence. |
| `Conforming` | Not entered and not claimed. The linked Drift is closed, but the required PR gate and blind-first frozen-spec verification are absent. |
| `Release-ready` / `Operating` | Not entered and not implied. This slice has no rollout, production, provider, route, or operator action. |
| `Drift` | `D-0018-SDK-1` is **Closed** through the accepted 0019 return. Any new authority or runtime disagreement adds a new Drift entry and blocks the affected lane. |

The lifecycle return rules are exact:

- change to product or observable intent returns to `Specified`;
- implementation-only correction returns to `Building` after the accepted intent remains stable;
- a predecessor regression pauses this successor until the predecessor returns to its named checkpoint;
- a runtime or source disagreement never becomes a silent note or a hidden exception.

## 14. Completed bounded implementation capsule

The following capsule is consumed by the accepted source and canonical implementation evidence. It grants no PR, provider, remote, production, or operator authority.

| Capsule field | Current handoff |
|---|---|
| Spec ID/path | `0019`; `design-specs/0019-application-status-typed-decode.md` |
| Role/objective | `ApplicationStatusTypedDecodeImplementer`; completed the application-status typed-channel repair through the four owned paths and produced red/green SDK and 0018 return evidence. |
| Source/canonical provenance | Source `07e66d3d1a39e357c0b69692908f47f1cde115c8` → `964f1b663f88d55c76a1fe7848e6960d4ddb1b89` → `d6c6edc2720b39ff3f2348bad16c3646568ef3cc`; canonical `9cb199ca8f320095a9449a348a3b4bf006d588cd` → `f2fdf4afce57cdad3c43e8564f9be67f032c6ab3` → `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`. |
| Base/worktree | Base `52338a4802dca9a53558c0236ea8161674d8ce8c`; source worktree `/tmp/mono-web-application-status-impl-0019-20260812`; source branch `impl/0019-application-status-typed-decode`; canonical worktree `/tmp/mono-web-stage1-conforming-20260810`; canonical branch `integration/stage1-conforming-20260810`. |
| Changed paths | Exactly `packages/sdk/src/adapter/status.ts`, `packages/sdk/src/schemas/application.ts`, `packages/sdk/src/__tests__/adapter.test.ts`, and `packages/sdk/src/__tests__/receipt-effect-v4-compatibility.test.ts`; canonical blobs match the source candidate. |
| Forbidden mutations | 0010/0018 intent and docs during implementation; dashboard and its fixture/e2e paths; interview parser/schema/tests; read-only `packages/sdk/src/__tests__/schemas.test.ts:78-104`; transport/errors/promise/effect-client/public exports; package manifests; OpenAPI/backend; root lock; workflow; committed `dist`; provider/remote/data/credentials. |
| Dependencies/conflicts | Lifecycle and charter; consumed 0010; historical 0018 `D-0018-SDK-1`; exact base source hashes; official local Effect beta.107 reference; no shared lock or generated artifact ownership. The dependency is now closed by the accepted return. |
| Context/law/interface refs | This spec §§3–10; lifecycle §§2, 4–6, 8–10, 12; charter §§1–5, 6–12; 0010 and 0018 read-only authorities; existing `Application`/`ApplicationDetail`, Promise `ValidationError`, and Effect `Validation` channels. No domain law was added. |
| Sensitive-data policy | Synthetic IDs and fixed status integers only. Raw `999` and response bodies stayed in memory for assertions. Retained evidence contains no credentials, tokens, cookies, PII, production rows, or external service content. |
| Verification result | Red Promise ordinary `Error` and Effect `Die` baseline; green Promise `ValidationError`/`type: validation`; green Effect `_tag: Validation` with `dies: false`; seven valid statuses; unchanged schema compatibility; canonical 0018 return; focused SDK `47/47`; build PASS; no-network and cleanup PASS. |
| Evidence destination | Canonical sanitized artifacts `/tmp/mono-web-application-status-runtime-gate-0019-canonical-25e-20260812/` with hashes in Metadata and §9; source red evidence `/tmp/mono-web-application-status-evidence-0019-20260812/evidence.json` is historical and sanitized. No repository evidence file. |
| Drift path | `D-0018-SDK-1` is Closed through the canonical return, independent review, integration mapping, and product-lead acceptance. Any new falsifier or source mismatch requires a new Drift entry and return to `Specified` or `Building`; this capsule does not reopen the closed row. |
| Cleanup | Completed after the 0018 rerun: ignored `dist`, build info, test/browser output, logs, overlays, raw inputs, and temporary processes removed; forbidden paths and lock unchanged; worktree clean. |
| Operator authorization | None was needed or permitted. Any external effect requires a separate lifecycle-scoped operator record. This capsule grants no provider, remote, credential, data, deployment, release, or rollback authority. |

### 14.1 Completed return handoff

The completed handoff contains:

1. the exact source and canonical graphs, parents, branch, worktree, implementation commit, and final clean status;
2. the four-path diff and proof that 0010, 0018, dashboard, package, lock, transport, error, public export, backend, and provider paths stayed unchanged;
3. the red ordinary-escape classifications for list and detail on both public surfaces;
4. the green Promise and Effect typed outcomes, adapter totality, seven valid-value compatibility observations, and unchanged read-only `schemas.test.ts:78-104` assertions;
5. the exact refined 0018 alert, zero-row result, and no-raw-value/payload observation;
6. the sanitized evidence destinations, artifact hashes, cleanup result, and no-network result;
7. the focused test/build statuses and generated-output removal;
8. independent review, integration mapping, and product-lead implementation acceptance closing `D-0018-SDK-1`;
9. explicit statements that no interview parser/schema, global SDK-totality, transport, package, lock, backend, provider, remote, data, deployment, release, or `Conforming` claim is made.

## 15. Authoring boundary

This docs-only commit changes only `design-specs/0019-application-status-typed-decode.md`. It records the accepted implementation, canonical evidence, cleanup, and `D-0018-SDK-1` closure disposition without changing SDK code or running commands. It does not amend 0018, create or authorize a PR, or grant provider, remote, credential, data, deployment, release, route, production, rollback, `Experienceable`, or `Conforming` authority.
