# Live design spec 0001 — Cloudflare local preview spine

> **Summary:** One local maintainer journey proving exact Wrangler local execution of one raw Worker and its HTTP/stop contract. This is the credential-free first preview checkpoint, not a cloud preview, product feature, domain assertion, or provider authorization.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0001` |
| Status | `accepted` — product-lead accepted after independent review on `2026-08-10` |
| Owner | Product lead |
| Intended implementation lane | Stage-1 Preview platform — Wrangler local runtime spine |
| Created | `2026-08-10` |
| Journey count | One maintainer journey; one future implementation PR |

## Goal, constraints, and values

### Goal

Give a maintainer a repeatable, clean-checkout proof that the root `mono-web` project can install the exact Wrangler dependency, run one raw Worker in Cloudflare's local workerd runtime, serve a deterministic health endpoint on loopback, and cleanly stop it. The proof must make provider or production runtime access fail rather than silently broaden the slice.

### Constraints

- Local runtime only. The journey uses no Cloudflare credentials, account, profile, zone, domain, remote state, provider call, bootstrap, deploy, public route, DNS, or public exposure.
- The only runtime resource is one raw Worker from `infra/preview.worker.ts`, served at `127.0.0.1:8787`; it has no bindings and no other resources.
- Use exact root dependency version `wrangler@4.120.0` (Node `>=22`). Do not add Alchemy or Effect dependencies in this slice.
- Locked installation may access npm to acquire dependencies. Wrangler metrics default on, and its error-report setting is otherwise undefined and can prompt to send non-user errors. Cloudflare's local `cf.json` fetch is otherwise enabled, so `preview:dev` MUST set `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, and `CLOUDFLARE_CF_FETCH_ENABLED=false` before starting the runtime; evidence must record all four controls. Fallback `Request.cf` data is acceptable because this Worker does not inspect `Request.cf`. After installation, the Worker runtime must not access a provider or production. Do not claim total network silence unless the run is explicitly sandboxed.
- Website.Vite, both frontends, the SDK, the Symfony backend, production data, and all cloud-only resources are outside this slice.
- The product lead remains read-only to production code. A bounded writer works only after acceptance, in an isolated worktree/capsule, and does not change this spec silently.

### Values

- **Local-first and least authority:** prove the smallest useful graph without credentials or remote effects.
- **One journey, one contract:** make the maintainer's observable path and its failure cases unambiguous.
- **Evidence over implication:** a process log does not stand in for HTTP, cleanup, or provider/production access-boundary evidence.
- **Reversible and disposable:** local state and the supervised process can be discarded without remote cleanup or production impact.
- **Honest boundaries:** do not turn a raw Worker smoke path into domain, SDK, frontend, parity, or deployment success.

## Current behavior and intended behavior

### Current behavior (baseline, as of `2026-08-10`)

- `mono-web` has no Alchemy configuration, no `alchemy.run.ts`, no `infra/preview.worker.ts`, and no `preview:plan` or `preview:dev` scripts.
- The root package has no exact `wrangler@4.120.0` dependency. The existing lockfile carries Effect 3 for the SDK lane; that lane remains unchanged by this spec.
- `.gitignore` does not ignore `.wrangler/`.
- The current React Router generated/runtime bundles are Node-oriented, and current application source contains stale SDK imports. The current apps are **not claimed buildable** by this spec.
- No current behavior above is repaired, migrated, or reclassified here. The frontend/SDK clean-build and compatibility work is a separate lane.

### Intended behavior

After a bounded writer realizes this accepted intent:

1. The root `preview:dev` script expands exactly to `WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false wrangler dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787`.
2. Locked dependencies install with `bun install --frozen-lockfile`.
3. `preview:dev` starts local Miniflare/workerd for exactly one raw Worker at `127.0.0.1:8787`.
4. The Worker serves only the contract below; it performs no SDK/backend call and has no bindings.
5. Stopping the supervised process closes the loopback port and leaves only disposable, ignored `.wrangler/` state.
6. This slice contains no Alchemy declaration, Alchemy state, `preview:plan`, or cloud-preview claim.

## Exact maintainer journey

One maintainer starts from a clean `mono-web` checkout and completes this one journey:

1. Enter a clean checkout of `mono-web`; do not provide credentials, provider profile/account/zone/domain values, or production data.
2. Install the locked dependencies:

   ```sh
   bun install --frozen-lockfile
   ```

3. Start the local runtime in a supervised process and retain its process name/PID and output. `preview:dev` MUST expand exactly to:

   ```sh
   WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false wrangler dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787
   ```

   The equivalent journey command is:

   ```sh
   bun run preview:dev
   ```

   No `--no-interactive` flag is required by this spec. Wait until the local workerd endpoint is reachable at `127.0.0.1:8787`. The transcript must identify local execution, record metrics and error reports disabled, the invalid loopback API base, and Cloudflare `cf.json` fetch disabled. Fallback `Request.cf` data is acceptable because this Worker does not inspect `Request.cf`; provider or production runtime access remains forbidden. If Wrangler unexpectedly needs a provider API, the start failure is `Drift`; do not add credentials or a workaround.
4. Request health and observe the complete response:

   ```sh
   curl --silent --show-error -i http://127.0.0.1:8787/health
   ```

   Verify the status, headers, and exact JSON value in [Observable contract](#observable-contract).
5. Request an unknown route:

   ```sh
   curl --silent --show-error -i http://127.0.0.1:8787/unknown-route
   ```

   Verify `404`.
6. Verify the method boundary:

   ```sh
   curl --silent --show-error -i -X POST http://127.0.0.1:8787/health
   ```

   Verify `405` and `Allow: GET`. Any non-GET method on `/health` is rejected.
7. Stop the supervised `preview:dev` process. Do not invoke remote cleanup or any provider action.
8. Confirm that the port is closed:

   ```sh
   curl --silent --show-error --connect-timeout 2 http://127.0.0.1:8787/health
   ```

   This request must fail to connect (non-zero exit); a successful connection is a falsifier.

## Scope and allowed implementation paths

The future bounded writer may change **only** these implementation paths:

- root `package.json`
- root `bun.lock`
- root `.gitignore`
- new `infra/preview.worker.ts`

Every other repository path is forbidden, including this spec, all other source/config/manifest/lock/workflow/README/ADR/charter/lifecycle/status/handoff/domain files, `packages/sdk`, `apps/homepage`, `apps/dashboard`, and `apps/server`. The writer may generate `.wrangler/` local runtime state; it is disposable, not an additional source path, and must be ignored by the named `.gitignore` change. `alchemy.run.ts`, Alchemy state, and any Alchemy or Effect dependency are outside this slice.

## Non-goals

This slice does **not** include:

- Cloudflare credentials, login, account/profile/zone/domain configuration, provider calls, provider bootstrap, remote state, deploy, public route, DNS, or any standing provider authority;
- `.alchemy/`, `.alchemy.remote`, `Cloudflare.state`, Alchemy declarations, `alchemy.run.ts`, `preview:plan`, `alchemy plan`, `alchemy dev`, `alchemy apply`, or any Alchemy/Effect dependency;
- production data, production API access, SDK calls, backend calls, or runtime external service calls;
- domain assertions, domain-law implementation, domain conformance, product success, or parity success;
- release, route cutover, custom domains, workers.dev exposure, or any public/nonlocal bind;
- bindings or resources beyond the one local Worker represented by logical slice label `PreviewSpine`;
- `Cloudflare.Website.Vite`, frontend builds, React Router compatibility, or repair of current frontend/SDK drift;
- a cloud preview, staging environment, remote observation, or production runtime claim.

## Authority, domain, contract, and interface references

- **Accepted topology authority:** [`docs/decisions/0001-cloudflare-topology-and-migration-architecture.md` §11](../../docs/decisions/0001-cloudflare-topology-and-migration-architecture.md#11-preview-spine-acceptance) accepts this Wrangler-first local checkpoint and the separately specified Alchemy cloud checkpoint. It grants no provider access.
- **Lifecycle authority:** [`docs/agentic-development-lifecycle.md` §§4–6](../../docs/agentic-development-lifecycle.md#5-live-design-spec-contract) owns this live-spec body, acceptance gates, bounded capsules, evidence limits, drift, and operator boundaries. Its §9 evidence matrix distinguishes local/runtime evidence from domain and deployment evidence.
- **Program authority:** [`docs/product-lead-charter.md` §4, preview order](../../docs/product-lead-charter.md#4-target-and-transition-shape) names Wrangler local runtime as preview checkpoint 1 and Alchemy non-production cloud deployment as checkpoint 2 under operator authority.
- **Cloudflare local runtime references:** [Local development](https://developers.cloudflare.com/workers/local-development/) documents Wrangler, Miniflare/workerd, and `--local` disabling remote bindings; [Wrangler `dev`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#dev) documents `wrangler dev [<SCRIPT>] [OPTIONS]`; [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) documents `WRANGLER_SEND_METRICS`, `WRANGLER_SEND_ERROR_REPORTS`, `CLOUDFLARE_API_BASE_URL`, and `CLOUDFLARE_CF_FETCH_ENABLED`.
- **Deferred cloud references:** [Alchemy CLI](https://alchemy.run/cli/) and [Alchemy local development](https://alchemy.run/environments/local-development/) describe the later cloud declaration/deployment slice only; they do not make Alchemy part of this local journey.
- **Domain authority:** [`docs/domain-model.md`](../../docs/domain-model.md) remains unchanged. **No domain laws are exercised by this journey.** The health JSON is a synthetic operational fixture, not a domain projection or domain claim.
- **Interface authority for this slice:** the HTTP contract in this spec is the sole intended interface. Existing SDK/API contracts are not invoked; no SDK or backend compatibility is inferred.

## Dependency and resource graph

```text
accepted ADR 0001 §11
  → this spec independently reviewed and accepted by the product lead
  → one bounded writer in an isolated worktree/capsule
  → root wrangler@4.120.0
  → preview:dev
  → one raw Worker from infra/preview.worker.ts
  → 127.0.0.1:8787
```

| Graph item | Required shape | Boundary |
|---|---|---|
| Package version | `wrangler@4.120.0` | Exact lockfile entry; no Alchemy or Effect dependency. |
| Script | `preview:dev` → `WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false wrangler dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787` | No `preview:plan`; no Alchemy CLI invocation. |
| State | `.wrangler/` disposable local state | Ignored; no Alchemy state, remote state, or bootstrap. |
| Resource | One raw Worker (logical slice label `PreviewSpine`) | No bindings and no additional resources. |
| Listener | `127.0.0.1:8787` | Loopback only; never a nonlocal bind or public route. |

## Observable contract

The local Worker MUST satisfy all of the following:

| Request | Required observation |
|---|---|
| `GET /health` | `200`; `Content-Type: application/json; charset=UTF-8` or a semantically equivalent JSON content type; `Cache-Control: no-store`; JSON value exactly `{ "service": "mono-web", "purpose": "cloudflare-local-preview-spine", "status": "ok" }`. |
| `GET /unknown-route` (or any unknown route) | `404`; it must not be accepted as a health or success path. |
| Any non-`GET` `/health` request, including `POST` | `405` with `Allow: GET`; it must not execute the health success path. |

The health body has exactly the three named string fields and values. It has no timestamp, random value, stage value, extra key, envelope, production identifier, or domain value. Header names are case-insensitive for verification; `Cache-Control` must be `no-store`.

## Baseline risks and conflicts

| Risk/baseline | Treatment in this spec |
|---|---|
| No Wrangler/Worker files exist. | The four named implementation paths are the complete creation/change boundary. |
| `.wrangler/` is currently not ignored. | The writer must add the ignore rule and prove generated state is ignored; failure is a falsifier. |
| The root has no exact Wrangler dependency. | Add only `wrangler@4.120.0`; do not add Alchemy or Effect or migrate the SDK. |
| Current RR generated bundles are Node-oriented. | Treat as a separate compatibility lane; do not include Website.Vite or frontend build work. |
| Current app source has stale SDK imports. | Treat as related baseline drift; do not touch or claim it fixed. |
| Current apps may fail a clean build. | This raw Worker spine does not depend on frontend buildability and makes no build claim. |

## Verification and evidence plan

This experiment is proven by the live smoke journey, not by a required unit test. The future writer MUST run, from the accepted clean checkout and after updating the lockfile:

1. `bun install --frozen-lockfile`.
2. `bun run preview:dev` under a supervised process; its expansion must set `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, and `CLOUDFLARE_CF_FETCH_ENABLED=false` before exact `wrangler@4.120.0`.
3. The exact `GET /health`, unknown-route `GET`, non-`GET /health`, stop, and post-stop connection checks in [Exact maintainer journey](#exact-maintainer-journey).

The evidence record must include:

- the dependency-install result, with npm registry traffic identified as installation traffic outside the runtime provider/production boundary;
- the `preview:dev` transcript identifying `wrangler@4.120.0`, local Miniflare/workerd execution, metrics and error reports disabled, the invalid loopback Cloudflare API base, and Cloudflare `cf.json` fetch disabled; fallback `Request.cf` data is acceptable because this Worker does not inspect it;
- no login, credential, provider, production, bootstrap, binding, or public-route effect during runtime; an unexpected provider-API requirement fails startup and enters `Drift`;
- complete status/header/body observations for each HTTP request;
- supervised process stop evidence and a failed connection to `127.0.0.1:8787` after stop;
- an ignore check showing generated `.wrangler/` state is ignored;
- a path-scope review showing only the four allowed implementation paths changed.

The evidence destination is the sanitized evidence section of the one-to-one PR for this spec; until an authorized PR exists, retain the transcript in the task handoff and do not add an evidence file to the repository. Do not open a remote PR without operator authority.

### Evidence boundary

This evidence proves only the local Wrangler runtime path, the one-Worker local graph, the loopback HTTP contract, all four startup controls, and process cleanup for the observed run. It does **not** prove domain laws, domain behavior, SDK/backend integration, frontend buildability, React Router compatibility, cloud deployment, Cloudflare API behavior, provider authorization, public routing/DNS, production data isolation beyond the observed no-access boundary, performance, availability, staging, production, or release readiness.

### Resolved design Drift

On `2026-08-10`, the platform probe falsified the earlier credential-free Alchemy local-preview shape. Exact `alchemy@2.0.0-beta.70` with matching minimum `effect`, `@effect/platform-node`, and `@effect/platform-bun` versions at `4.0.0-beta.102` installs, but with provider environment absent `alchemy plan --stage local` fails on missing `CLOUDFLARE_ACCOUNT_ID`, and `alchemy dev --stage local` fails on the same requirement before `workerd` or a listener starts. A synthetic account ID only advances the failure to missing `CLOUDFLARE_API_TOKEN` or Cloudflare key plus email; synthetic values are not a workaround. A `bwrap --unshare-net` rerun with `ALCHEMY_TELEMETRY_DISABLED=1` proves no external path in that sandboxed run but still starts no Worker. Ordinary Alchemy telemetry targets `https://otel.alchemy.run/v1/{traces,metrics,logs}`; observed opt-outs are `ALCHEMY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `NO_TRACK`, and `$HOME/.alchemy/telemetry-disabled`.

This is resolved design Drift, not an open caveat: spec `0001` now uses Wrangler for the first local checkpoint and contains no Alchemy or Effect dependency, state, declaration, or plan evidence. The observation creates the next separately accepted Alchemy non-production cloud-preview slice, which requires operator authority before any plan/apply/provider effect. The ordinary local install may access npm; no claim of total network silence is made for the runtime unless explicitly sandboxed.

## Falsifiers and definition of done

Any of these observations falsifies this slice, even if the health request passes:

- credential/profile read, login, or a provider prompt during the runtime;
- any of `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, or `CLOUDFLARE_CF_FETCH_ENABLED=false` is absent, or the evidence does not record all four controls;
- a Cloudflare API call, provider bootstrap, remote binding, production API/data access, or other provider/production runtime effect;
- any Alchemy/Effect dependency, `alchemy.run.ts`, Alchemy state, `preview:plan`, or Alchemy CLI invocation enters this slice;
- `.wrangler/` is not ignored or a non-disposable state is created;
- a nonlocal bind, public route, workers.dev exposure, DNS action, or other public exposure;
- wrong health status, content type, cache header, JSON value, or dynamic body field;
- an unknown route is accepted, or a non-`GET` `/health` request is accepted instead of `405` with `Allow: GET`;
- the port remains open after the supervised process stops;
- any unrelated path changes.

Done means all of the following are observed and recorded: the exact four-path implementation boundary; locked install; exact `wrangler@4.120.0`; `preview:dev` with all four controls and `--local`; local workerd; one raw Worker on loopback with no bindings; fallback `Request.cf` data accepted because the Worker does not inspect it; every HTTP contract case; no runtime credentials/provider/production/public effect; ignored disposable `.wrangler/` state; stopped process; closed port; resolved design Drift; and no open implementation Drift. No unit test is required for this experiment.

## Rollback and cleanup

- Stop the supervised local process before leaving the lane.
- Do not perform remote cleanup: no remote state or provider resource is allowed to exist.
- Treat `.wrangler/` as ignored, disposable local runtime state. Remove or discard it using the local process/worktree cleanup procedure; never commit it.
- If the slice is abandoned, revert only the named implementation files and the named dependency entries in `package.json`/`bun.lock` (and the named `.gitignore` entry). Do not revert or edit unrelated work, this spec, or authority documents.
- Record any failed or partial local run as evidence/Drift rather than presenting cleanup as proof of success.

## Conflicts and drift log

- The current SDK/frontend build drift is a related baseline, not a dependency for this raw Worker spine. It does not block local health proof unless the writer attempts to broaden scope.
- Any attempt to include `Cloudflare.Website.Vite`, a frontend, an SDK/backend call, current-build repair, or an Alchemy/Effect dependency creates a new journey and requires a new spec or explicit product-lead-reviewed revision; it must not be folded into `0001`.
- The 2026-08-10 Alchemy credential/telemetry observation is resolved design Drift recorded in [Resolved design Drift](#resolved-design-drift): it changed checkpoint 1 to Wrangler and created the next cloud-preview slice. It is not a caveat that `alchemy plan` or `alchemy dev` may work locally.
- Any new conflict between this spec, the accepted ADR, lifecycle, charter, implementation, or runtime observation enters `Drift` with the conflicting artifacts, observation, owner, evidence, and proposed return (`Specified` if intent changes; `Building` if implementation alone changes). Product lead disposes of Drift; the writer never resolves it by broadening scope.
- Current entry: resolved design Drift is recorded above; status remains `draft` pending independent review and product-lead acceptance.

## Lifecycle gates

- **Specified:** this complete draft exists at the stable live-spec path with resolvable authority, dependency, contract, evidence, falsifier, and capsule sections.
- **Ready:** only after independent review and explicit product-lead acceptance; status then becomes `accepted`.
- **Building:** only in an isolated worktree under the task capsule, with the accepted paths and boundaries above. The product lead remains read-only to production code.
- **Experienceable:** after the complete smoke journey has objective evidence and the feature lead freezes the accepted spec as the one-to-one PR opens. A remote PR is not opened without operator authority.
- **Conforming:** a blind-first verifier receives the frozen spec, implementation, and evidence before author rationale; the author does not self-verify.
- **Release-ready / Operating:** not entered. This slice has no provider, deployment, or public effect; package-install traffic is bounded as above; local process evidence is local-runtime only, not cloud/public-runtime evidence.

## Task capsule skeleton — future bounded writer

| Field | Capsule content |
|---|---|
| Spec ID/path | `0001`; `mono-web/design-specs/0001-cloudflare-local-preview-spine.md` |
| Role/objective | Engineer; realize this one Wrangler local Worker smoke journey and produce objective HTTP, cleanup, telemetry/error-report-disabled, and no-provider/production-runtime evidence. |
| Base/worktree | Start from the accepted clean `mono-web` checkout at the scheduler's recorded base checkpoint; use one isolated writer worktree dedicated to this spec. Record the checkpoint and worktree in the handoff before mutation. |
| Mutable authority | Only root `package.json`, root `bun.lock`, root `.gitignore`, and new `infra/preview.worker.ts`; generated `.wrangler/` is disposable local state. |
| Forbidden actions | Every other path/resource; credentials, login, profile/account/zone/domain; Cloudflare/provider calls or bootstrap; remote state/bindings; Alchemy/Effect dependencies; `alchemy.run.ts`; `preview:plan`; Alchemy CLI; Hyperdrive; additional resources; SDK/backend/data calls; Website.Vite/frontends; deploy/apply/release; route/DNS/public exposure; production data; domain-law claims; remote PR without authority. |
| Dependencies/conflicts | Accepted ADR 0001 §11 → accepted Wrangler spec → this capsule. The resolved Alchemy credential/telemetry Drift is recorded in this spec and creates the next cloud-preview slice. Related SDK/frontend drift is separate. |
| Context/law/interface refs | Lifecycle §§4–6 and §9; ADR §11; charter §4 preview order; Cloudflare local-development and Wrangler system-environment-variables docs; `docs/domain-model.md` unchanged and no laws exercised; this spec's HTTP contract. |
| Exact skill | Wrangler/Cloudflare local-runtime guidance; no Alchemy/Effect dependency or provider-IaC skill is part of this capsule. |
| Sensitive-data policy | No credentials, secrets, PII, production data, or provider/production access. Set the four runtime controls (`WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, `CLOUDFLARE_CF_FETCH_ENABLED=false`); fallback `Request.cf` data is acceptable because the Worker does not inspect it; use local state and synthetic health output only; stop on any prompt or unexpected provider requirement. |
| Acceptance commands/scenarios | `bun install --frozen-lockfile`; supervised `bun run preview:dev` with the exact prefixed Wrangler command; the exact health, unknown-route, non-GET, stop, and post-stop `curl` commands above; an ignore check for `.wrangler/`. |
| Exit evidence | Sanitized install transcript with npm traffic boundary; `preview:dev` transcript showing exact Wrangler version, local workerd, all four controls, disabled `cf.json` fetch, acceptable fallback `Request.cf` data, and no provider/production runtime effect; all HTTP status/header/body captures; supervised stop and failed port connection; ignored-state proof; four-path scope review; resolved design Drift and no open implementation Drift. |
| Evidence destination | One-to-one PR evidence section when operator-authorized; otherwise the task handoff only, with no repository evidence file. |
| Drift path | Stop on falsifier; notify product lead; link this spec, ADR §11, lifecycle, and observation. Return to `Specified` for intent revision or `Building` for an implementation correction. |
| Cleanup | Stop process, discard ignored `.wrangler/` local state, leave no provider/production effect, and report residual risk. |
| Operator authorization | None is needed or permitted for this local-only slice. Any discovered external effect requires stopping and a separately recorded lifecycle-scoped authorization; credentials remain operator-controlled. |
