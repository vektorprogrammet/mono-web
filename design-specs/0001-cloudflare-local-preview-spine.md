# Live design spec 0001 — Cloudflare local preview spine

> **Summary:** One local maintainer journey proving exact Wrangler local execution of one raw Worker and its HTTP/stop contract. This is the credential-free first preview checkpoint, not a cloud preview, product feature, domain assertion, or provider authorization.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0001` |
| Status | `accepted` — product lead accepted after independent review on `2026-08-10` |
| Owner | Product lead |
| Intended implementation lane | Stage-1 Preview platform — Wrangler local runtime spine |
| Created | `2026-08-10` |
| Journey count | One maintainer journey; one future implementation PR |
Accepted mono-web integration spec [`0023`](./0023-functional-parity-integration-baseline.md) supersedes this spec's dependency-pin clauses only and is the single active dependency-pin authority.
This spec remains authoritative for the one raw Worker, HTTP contract, egress controls, Node-hosted execution, compatibility date, and supervised-stop behavior.
Any dependency-pin conflict with 0023 is `Drift`; do not copy the active version into this behavior contract.


## Goal, constraints, and values

### Goal

Give a maintainer a repeatable, clean-checkout proof that the root `mono-web` project can install the active Wrangler dependency pin from accepted mono-web spec `0023`, run one raw Worker in Cloudflare's local workerd runtime, serve a deterministic health endpoint on loopback, and cleanly stop it. The proof must make provider or production runtime access fail rather than silently broaden the slice.

### Constraints

- Local runtime only. The journey uses no Cloudflare credentials, account, profile, zone, domain, remote state, provider call, bootstrap, deploy, public route, DNS, or public exposure.
- The only runtime resource is one raw Worker from `infra/preview.worker.ts`, served at `127.0.0.1:8787`; it has no bindings and no other resources.
- Use the active dependency pin from accepted mono-web spec `0023`. Wrangler CLI itself requires Node `>=22`; the root `package.json` MUST declare `engines.node` `>=22`. Preserve the existing root Bun `packageManager` declaration. Bun remains the package manager, install command, and script runner, but MUST NOT host the Wrangler CLI. Do not add Alchemy or Effect dependencies in this slice.
- Locked installation may access npm to acquire dependencies. Before starting the runtime, preflight Node `>=22` and verify the root `package.json` engine. The four egress controls are `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, and `CLOUDFLARE_CF_FETCH_ENABLED=false`; `WRANGLER_LOG_PATH=.wrangler/logs` is a local-state/log control, not a fifth egress control. `preview:dev` MUST invoke Wrangler through Node with the pinned compatibility date. Fallback `Request.cf` data is acceptable because this Worker does not inspect `Request.cf`. After installation, the Worker runtime must not access a provider or production. Do not claim total network silence unless the run is explicitly sandboxed.
- Credential-free preflight: before the runtime starts, verify that the project root has no `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file. A match is `Drift`; never load or inspect its contents. A clean checkout must show no matches.
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
- The root package has no dependency pin in this baseline; accepted mono-web spec `0023` owns the active pin. The root package still requires `engines.node` `>=22`. The existing lockfile carries Effect 3 for the SDK lane; that lane remains unchanged by this spec.
- `.gitignore` does not ignore `.wrangler/`.
- The current React Router generated/runtime bundles are Node-oriented, and current application source contains stale SDK imports. The current apps are **not claimed buildable** by this spec.
- No current behavior above is repaired, migrated, or reclassified here. The frontend/SDK clean-build and compatibility work is a separate lane.

### Intended behavior

After a bounded writer realizes this accepted intent:

1. The root `preview:dev` script expands exactly to `WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_LOG_PATH=.wrangler/logs node node_modules/wrangler/bin/wrangler.js dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787 --compatibility-date 2026-08-08`.
2. The maintainer preflights Node `>=22`; root `package.json` declares `engines.node` `>=22`; Bun remains the package manager, installer, and script runner, while the Wrangler CLI executes through Node.
3. Locked dependencies install with `bun install --frozen-lockfile`.
4. `preview:dev` starts local Miniflare/workerd for exactly one raw Worker at `127.0.0.1:8787`, with logs under disposable `.wrangler/logs`.
5. The Worker serves only the contract below; it performs no SDK/backend call and has no bindings.
6. Stopping the supervised process closes the loopback port and leaves only disposable, ignored `.wrangler/` state.
7. This slice contains no Alchemy declaration, Alchemy state, `preview:plan`, or cloud-preview claim.

## Exact maintainer journey

One maintainer starts from a clean `mono-web` checkout and completes this one journey:

1. Enter a clean checkout of `mono-web`; do not provide credentials, provider profile/account/zone/domain values, or production data.
2. Before installing, verify that the project root has no `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file by running the filename-only preflight below; record no matches, and never load or inspect file contents. Then run `node --version` and require Node `>=22`; verify root `package.json` declares `engines.node` `>=22`. Bun remains the package manager, install command, and script runner; the Wrangler CLI must execute through Node. Then install the locked dependencies:
   The preflight must not open a matching path:

   ```sh
   for candidate in .env .env.* .dev.vars .dev.vars.*; do
     if [ -e "$candidate" ] || [ -L "$candidate" ]; then
       printf 'Drift: project-root credential file exists: %s\n' "$candidate" >&2
       exit 1
     fi
   done
   ```


   ```sh
   bun install --frozen-lockfile
   ```

3. Before starting, verify that `127.0.0.1:8787` is closed:

   ```sh
   curl --silent --show-error --connect-timeout 2 http://127.0.0.1:8787/health
   ```

   This request MUST fail to connect; a successful connection is a falsifier. Start the local runtime in a supervised process and retain its process name/PID and output. `preview:dev` MUST expand exactly to:

   ```sh
   WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_LOG_PATH=.wrangler/logs node node_modules/wrangler/bin/wrangler.js dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787 --compatibility-date 2026-08-08
   ```

   The equivalent journey command is:

   ```sh
   bun run preview:dev
   ```

   No `--no-interactive` flag is required by this spec. Wait until the local workerd endpoint is reachable at `127.0.0.1:8787`. The transcript must identify Node `>=22` CLI execution, the active dependency pin from accepted mono-web spec `0023`, compatibility date `2026-08-08`, local execution, all four egress controls, and `WRANGLER_LOG_PATH=.wrangler/logs` as the local-state/log control. Fallback `Request.cf` data is acceptable because this Worker does not inspect `Request.cf`; provider or production runtime access remains forbidden. If Wrangler unexpectedly needs a provider API, if the CLI falls back to Bun, or if it writes a global log outside `.wrangler/logs`, the start failure is `Drift`; do not add credentials or a workaround.
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
- **Cloudflare local runtime references:** [Local development](https://developers.cloudflare.com/workers/local-development/) documents Wrangler, Miniflare/workerd, and `--local` disabling remote bindings; [Wrangler `dev`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#dev) documents `wrangler dev [<SCRIPT>] [OPTIONS]`; [Wrangler local environment variables](https://developers.cloudflare.com/workers/local-development/environment-variables/) documents `.dev.vars`, `.env`, and local file loading; [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) documents `WRANGLER_SEND_METRICS`, `WRANGLER_SEND_ERROR_REPORTS`, `CLOUDFLARE_API_BASE_URL`, and `CLOUDFLARE_CF_FETCH_ENABLED`. The local environment-variable document is a filename/precedence reference only; it does not authorize loading or inspecting file contents.

- **Deferred cloud references:** [Alchemy CLI](https://alchemy.run/cli/) and [Alchemy local development](https://alchemy.run/environments/local-development/) describe the later cloud declaration/deployment slice only; they do not make Alchemy part of this local journey.
- **Domain authority:** [`docs/domain-model.md`](../../docs/domain-model.md) remains unchanged. **No domain laws are exercised by this journey.** The health JSON is a synthetic operational fixture, not a domain projection or domain claim.
- **Interface authority for this slice:** the HTTP contract in this spec is the sole intended interface. Existing SDK/API contracts are not invoked; no SDK or backend compatibility is inferred.

## Dependency and resource graph

```text
accepted ADR 0001 §11
  → this spec independently reviewed and accepted by the product lead
  → one bounded writer in an isolated worktree/capsule
  → active dependency pin from accepted mono-web spec `0023`
  → preview:dev
  → one raw Worker from infra/preview.worker.ts
  → 127.0.0.1:8787
```

| Graph item | Required shape | Boundary |
|---|---|---|
| Package version | Active dependency pin from accepted mono-web spec `0023` | Root `package.json` requires `engines.node` `>=22`; no Alchemy or Effect dependency. |
| Script | `preview:dev` → `WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0 CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_LOG_PATH=.wrangler/logs node node_modules/wrangler/bin/wrangler.js dev infra/preview.worker.ts --local --ip 127.0.0.1 --port 8787 --compatibility-date 2026-08-08` | No `preview:plan`; no Alchemy CLI invocation; Bun may run the script, but Node hosts Wrangler. |
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
| `.wrangler/` is currently not ignored. | The writer must add the `.wrangler/` ignore rule and prove `.wrangler/state` is ignored by that newly added rule; failure is a falsifier. |
| Wrangler CLI does not support Bun as its runtime host. | Keep Bun as package manager/install/script runner, require Node `>=22` in the root `engines.node`, invoke `node node_modules/wrangler/bin/wrangler.js`, and show no `bun --bun` flag or Bun-provided `node` alias from `bunfig.toml`; Bun fallback is a falsifier. |
| Wrangler's implicit compatibility date can exceed the bundled workerd maximum. | Pin `--compatibility-date 2026-08-08` for the dependency selected by accepted mono-web spec `0023`; change it only after an explicit dependency/runtime review. |
| Wrangler can create a global log outside disposable local state. | Set `WRANGLER_LOG_PATH=.wrangler/logs`; any creation or write under a global path such as `~/.config/.wrangler/logs` is a falsifier. |
| Credential files can be loaded implicitly. | The clean-checkout preflight must show no root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file; never load or inspect contents, and treat any match as `Drift`. |
| The root has no active Wrangler dependency pin. | Use the active pin from accepted mono-web spec `0023`; do not add Alchemy or Effect or migrate the SDK. |
| Current RR generated bundles are Node-oriented. | Treat as a separate compatibility lane; do not include Website.Vite or frontend build work. |
| Current app source has stale SDK imports. | Treat as related baseline drift; do not touch or claim it fixed. |
| Current apps may fail a clean build. | This raw Worker spine does not depend on frontend buildability and makes no build claim. |

## Verification and evidence plan

This experiment is proven by the live smoke journey, not by a required unit test. The future writer MUST run, from the accepted clean checkout and after updating the lockfile:

1. The project-root credential-file preflight shows no `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file; no contents are loaded or inspected.
2. `node --version` with Node `>=22`, and a check that root `package.json` declares `engines.node` `>=22`.
3. `bun install --frozen-lockfile`.
4. The pre-start closed-port check in [Exact maintainer journey](#exact-maintainer-journey) fails to connect.
5. `bun run preview:dev` under a supervised process; its expansion must invoke the Node Wrangler CLI with `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, `CLOUDFLARE_CF_FETCH_ENABLED=false`, `WRANGLER_LOG_PATH=.wrangler/logs`, and `--compatibility-date 2026-08-08`; the transcript must show no `bun --bun` flag or Bun-provided `node` alias.
6. The exact `GET /health`, unknown-route `GET`, non-`GET /health`, stop, and post-stop connection checks in [Exact maintainer journey](#exact-maintainer-journey).

The evidence record must include:

- the dependency-install result, with npm registry traffic identified as installation traffic outside the runtime provider/production boundary;
- the credential-file preflight showing no root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` match, with no contents loaded or inspected;
- the Node preflight and root `engines.node` `>=22` evidence, with Bun retained only as package manager/install/script runner;
- the `preview:dev` transcript identifying the active dependency pin from accepted mono-web spec `0023`, Node CLI execution, local Miniflare/workerd execution, compatibility date `2026-08-08`, all four egress controls, `WRANGLER_LOG_PATH=.wrangler/logs` as the local-state/log control, and no `bun --bun` or Bun-provided `node` alias; fallback `Request.cf` data is acceptable because this Worker does not inspect it;
- the writer's own corrected Node run (Node-hosted, pinned date) produces current startup and HTTP evidence; cite the already-recorded [Observed Wrangler runtime implementation Drift](#observed-wrangler-runtime-implementation-drift--2026-08-10) for the failed Bun-hosted warning, implicit compatibility-date/workerd failure, and global-log observation; **MUST NOT reproduce that falsified configuration**; the corrected Node run is the only current evidence target;

- no login, credential, provider, production, bootstrap, binding, or public-route effect during runtime; an unexpected provider-API requirement fails startup and enters `Drift`;
- complete status/header/body observations for each HTTP request;
- supervised process stop evidence and a failed connection to `127.0.0.1:8787` after stop;
- an ignore check such as `git check-ignore -v .wrangler/state` showing that the newly added `.wrangler/` rule ignores `.wrangler/state`; the output must not rely on a pre-existing `logs` or `*.log` pattern;

- a path-scope review showing only the four allowed implementation paths changed.

The evidence destination is the sanitized evidence section of the one-to-one PR for this spec; until an authorized PR exists, retain the transcript in the task handoff and do not add an evidence file to the repository. Do not open a remote PR without operator authority.

### Evidence boundary

This evidence proves only the local Wrangler runtime path, the one-Worker local graph, the loopback HTTP contract, all four egress controls, the local-state/log control, Node CLI execution, compatibility-date selection, and process cleanup for the observed run. It does **not** prove domain laws, domain behavior, SDK/backend integration, frontend buildability, React Router compatibility, cloud deployment, Cloudflare API behavior, provider authorization, public routing/DNS, production data isolation beyond the observed no-access boundary, performance, availability, staging, production, or release readiness.

### Resolved design Drift

On `2026-08-10`, the platform probe falsified the earlier credential-free Alchemy local-preview shape. Exact `alchemy@2.0.0-beta.70` with matching minimum `effect`, `@effect/platform-node`, and `@effect/platform-bun` versions at `4.0.0-beta.102` installs, but with provider environment absent `alchemy plan --stage local` fails on missing `CLOUDFLARE_ACCOUNT_ID`, and `alchemy dev --stage local` fails on the same requirement before `workerd` or a listener starts. A synthetic account ID only advances the failure to missing `CLOUDFLARE_API_TOKEN` or Cloudflare key plus email; synthetic values are not a workaround. A `bwrap --unshare-net` rerun with `ALCHEMY_TELEMETRY_DISABLED=1` proves no external path in that sandboxed run but still starts no Worker. Ordinary Alchemy telemetry targets `https://otel.alchemy.run/v1/{traces,metrics,logs}`; observed opt-outs are `ALCHEMY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `NO_TRACK`, and `$HOME/.alchemy/telemetry-disabled`.

This is resolved design Drift, not an open caveat: spec `0001` now uses Wrangler for the first local checkpoint and contains no Alchemy or Effect dependency, state, declaration, or plan evidence. The observation creates the next separately accepted Alchemy non-production cloud-preview slice, which requires operator authority before any plan/apply/provider effect. The ordinary local install may access npm; no claim of total network silence is made for the runtime unless explicitly sandboxed.
### Observed Wrangler runtime implementation Drift — 2026-08-10

The first implementation candidate passed the frozen install, then ran `bun run preview:dev` with Wrangler hosted by Bun. It printed Wrangler `4.120.0`, warned that Wrangler does not support Bun, and failed before HTTP because workerd rejected the implicit compatibility date `2026-08-10`; the bundled server supports at most `2026-08-08`. The run also created a global log under `~/.config/.wrangler/logs`; that log was removed during cleanup. These are implementation Drift observations, not reasons to add credentials or synthetic provider values.

The corrected candidate used Node `24.18`, `WRANGLER_LOG_PATH=.wrangler/logs`, and the exact pinned compatibility date `2026-08-08`. It started Wrangler/workerd and passed `GET /health` with the exact body and headers, unknown-route `GET` with `404`, `POST /health` with `405` and `Allow: GET`, supervised stop, and the closed-port check. On this workstation Node was supplied by `nix shell nixpkgs#nodejs_24`; Nix is not a product requirement. Bun remains the package manager, installer, and script runner; the Wrangler CLI requires Node `>=22`.

The compatibility date derives from the active dependency pin in accepted mono-web spec 0023 and that dependency's bundled workerd maximum; it may change only after an explicit dependency/runtime review recorded by the pin authority. The failed Bun fallback, implicit-date failure, and global-log creation remain recorded historical implementation Drift; independent review resolved and disposed of that Drift for this revision, and status is `accepted`.

## Falsifiers and definition of done

Any of these observations falsifies this slice, even if the health request passes:

- credential/profile read, login, or a provider prompt during the runtime;
- any of the four egress controls—`WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, or `CLOUDFLARE_CF_FETCH_ENABLED=false`—is absent, or the evidence does not record all four;
- the Wrangler CLI is hosted by Bun, Node is `<22`, root `package.json` lacks `engines.node` `>=22`, or the exact pinned compatibility date is omitted, changed, or rejected by the bundled workerd without an explicit dependency/runtime review;
- a root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file exists at preflight (enter `Drift`), or any such file is opened, loaded, or inspected;

- the transcript shows `bun --bun`, Bun-provided `node` aliasing through `bunfig.toml`, or another Bun host for Wrangler; no config-file workaround is permitted;
- `WRANGLER_LOG_PATH=.wrangler/logs` is absent or misdirected, or the run creates or writes a global log outside `.wrangler/logs`;
- a Cloudflare API call, provider bootstrap, remote binding, production API/data access, or other provider/production runtime effect;
- any Alchemy/Effect dependency, `alchemy.run.ts`, Alchemy state, `preview:plan`, or Alchemy CLI invocation enters this slice;
- `.wrangler/state` is not ignored by the newly added `.wrangler/` rule, or a non-disposable state is created;
- a nonlocal bind, public route, workers.dev exposure, DNS action, or other public exposure;
- wrong health status, content type, cache header, JSON value, or dynamic body field;
- an unknown route is accepted, or a non-`GET` `/health` request is accepted instead of `405` with `Allow: GET`;
- the port remains open after the supervised process stops;
- the pre-start closed-port check succeeds instead of failing to connect;
- any unrelated path changes.

Done means all of the following are observed and recorded: the exact four-path implementation boundary; credential-file preflight with no root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` match and no contents loaded or inspected; Node `>=22` preflight and root `engines.node` `>=22`; locked install using the dependency pin from accepted mono-web spec `0023`; `preview:dev` invoking Wrangler through Node with no `bun --bun` or Bun-provided `node` alias, all four egress controls, local `WRANGLER_LOG_PATH=.wrangler/logs`, `--local`, and compatibility date `2026-08-08`; a failed pre-start port check; local workerd; one raw Worker on loopback with no bindings; fallback `Request.cf` data accepted because the Worker does not inspect it; every HTTP contract case; no runtime credentials/provider/production/public effect; `.wrangler/state` ignored by the newly added `.wrangler/` rule; stopped process; closed port; the corrected Node run's current evidence; a citation to the already-recorded [Observed Wrangler runtime implementation Drift](#observed-wrangler-runtime-implementation-drift--2026-08-10); **MUST NOT reproduce its failed Bun/implicit-date/global-log configuration**; resolved Alchemy design Drift; and no open implementation Drift before status becomes accepted. No unit test is required for this experiment.

## Rollback and cleanup

- Stop the supervised local process before leaving the lane.
- Do not perform remote cleanup: no remote state or provider resource is allowed to exist.
- Treat `.wrangler/` and `.wrangler/logs` as ignored, disposable local runtime state. Remove or discard them using the local process/worktree cleanup procedure; never commit them. A global Wrangler log is a falsifier and must be removed during cleanup.
- The credential-file preflight is a safety boundary, not cleanup input: never open, inspect, copy, or delete a root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` path. If any appears before or during cleanup, stop and record `Drift` rather than masking it.

- If the slice is abandoned, revert only the named implementation files and the named dependency entries in `package.json`/`bun.lock` (and the named `.gitignore` entry). Do not revert or edit unrelated work, this spec, or authority documents.
- Record any failed or partial local run as evidence/Drift rather than presenting cleanup as proof of success.

## Conflicts and drift log

- The current SDK/frontend build drift is a related baseline, not a dependency for this raw Worker spine. It does not block local health proof unless the writer attempts to broaden scope.
- Any attempt to include `Cloudflare.Website.Vite`, a frontend, an SDK/backend call, current-build repair, or an Alchemy/Effect dependency creates a new journey and requires a new spec or explicit product-lead-reviewed revision; it must not be folded into `0001`.
- The 2026-08-10 Alchemy credential/telemetry observation is resolved design Drift recorded in [Resolved design Drift](#resolved-design-drift): it changed checkpoint 1 to Wrangler and created the next cloud-preview slice. It is not a caveat that `alchemy plan` or `alchemy dev` may work locally.
- Any new conflict between this spec, the accepted ADR, lifecycle, charter, implementation, or runtime observation enters `Drift` with the conflicting artifacts, observation, owner, evidence, and proposed return (`Specified` if intent changes; `Building` if implementation alone changes). Product lead disposes of Drift; the writer never resolves it by broadening scope.
- Current entry: the Alchemy design Drift and Wrangler runtime implementation Drift are both resolved and disposed of; their historical observations remain recorded above. Status is `accepted` after independent review and product-lead acceptance on `2026-08-10`.

## Lifecycle gates

- **Specified:** gate satisfied; this complete draft exists at the stable live-spec path with resolvable authority, dependency, contract, evidence, falsifier, and capsule sections.
- **Ready:** gate passed after independent review and explicit product-lead acceptance on `2026-08-10`; status is `accepted`.
- **Building:** only in an isolated worktree under the task capsule, with the accepted paths and boundaries above. The product lead remains read-only to production code.
- **Experienceable:** after the complete smoke journey has objective evidence and the feature lead freezes the accepted spec as the one-to-one PR opens. A remote PR is not opened without operator authority.
- **Conforming:** a blind-first verifier receives the frozen spec, implementation, and evidence before author rationale; the author does not self-verify.
- **Release-ready / Operating:** not entered. This slice has no provider, deployment, or public effect; package-install traffic is bounded as above; local process evidence is local-runtime only, not cloud/public-runtime evidence.

## Task capsule skeleton — future bounded writer

| Field | Capsule content |
|---|---|
| Spec ID/path | `0001`; `mono-web/design-specs/0001-cloudflare-local-preview-spine.md` |
| Role/objective | Engineer; realize this one Wrangler local Worker smoke journey and produce objective credential-file/Node preflight, pre-start closed-port, HTTP, cleanup, telemetry/error-report-disabled, local-log, and no-provider/production-runtime evidence. |
| Base/worktree | Start from the accepted clean `mono-web` checkout at the scheduler's recorded base checkpoint; use one isolated writer worktree dedicated to this spec. Record the checkpoint and worktree in the handoff before mutation. |
| Mutable authority | Only root `package.json`, root `bun.lock`, root `.gitignore`, and new `infra/preview.worker.ts`; generated `.wrangler/` and `.wrangler/logs` are disposable local state. |
| Forbidden actions | Every other path/resource; credentials, login, profile/account/zone/domain; Cloudflare/provider calls or bootstrap; remote state/bindings; Alchemy/Effect dependencies; `alchemy.run.ts`; `preview:plan`; Alchemy CLI; Hyperdrive; additional resources; SDK/backend/data calls; Website.Vite/frontends; deploy/apply/release; route/DNS/public exposure; production data; domain-law claims; remote PR without authority. |
| Dependencies/conflicts | Accepted ADR 0001 §11 → this independently reviewed and accepted spec with resolved/recorded Drift → this capsule. The resolved Alchemy credential/telemetry Drift is recorded in this spec and creates the next cloud-preview slice. Related SDK/frontend drift is separate. |
| Context/law/interface refs | Lifecycle §§4–6 and §9; ADR §11; charter §4 preview order; Cloudflare local-development, local environment variables, and Wrangler system-environment-variables docs; `docs/domain-model.md` unchanged and no laws exercised; this spec's HTTP contract. |
| Exact skill | Wrangler/Cloudflare local-runtime guidance; no Alchemy/Effect dependency or provider-IaC skill is part of this capsule. |
| Sensitive-data policy | No credentials, secrets, PII, production data, or provider/production access. Verify no root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` file exists and never load or inspect contents; set the four egress controls (`WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:0`, `CLOUDFLARE_CF_FETCH_ENABLED=false`) and the local-state/log control (`WRANGLER_LOG_PATH=.wrangler/logs`); fallback `Request.cf` data is acceptable because the Worker does not inspect it; use local state and synthetic health output only; stop on any prompt, Bun fallback including `bun --bun`/`bunfig.toml` node aliasing, unsupported implicit date, global log, or unexpected provider requirement. |
| Acceptance commands/scenarios | Credential-file preflight; Node `>=22` preflight; verify root `package.json` `engines.node` `>=22`; install using the active dependency pin from accepted mono-web spec `0023` with `bun install --frozen-lockfile`; pre-start closed-port check; supervised `bun run preview:dev` with the exact Node Wrangler command and `--compatibility-date 2026-08-08`; the exact health, unknown-route, non-GET, stop, and post-stop `curl` commands above; an ignore check proving `.wrangler/state` is ignored by the newly added `.wrangler/` rule. |
| Exit evidence | Sanitized install transcript with npm traffic boundary; credential-file preflight; corrected `preview:dev` transcript showing Node `>=22`, the active Wrangler dependency pin from accepted mono-web spec `0023`, local workerd, compatibility date `2026-08-08`, all four egress controls, local `WRANGLER_LOG_PATH`, no Bun aliasing, and no provider/production runtime effect; pre-start closed-port failure; all HTTP status/header/body captures; supervised stop and failed port connection; ignore proof for `.wrangler/state` via the newly added `.wrangler/` rule; four-path scope review; cite the already-recorded [Observed Wrangler runtime implementation Drift](#observed-wrangler-runtime-implementation-drift--2026-08-10); **MUST NOT reproduce the failed Bun/implicit-date/global-log configuration**; the corrected Node run produces current evidence; and resolved design Drift. |
| Evidence destination | One-to-one PR evidence section when operator-authorized; otherwise the task handoff only, with no repository evidence file. |
| Drift path | Stop on falsifier; notify product lead; link this spec, ADR §11, lifecycle, and observation. Return to `Specified` for intent revision or `Building` for an implementation correction. |
| Cleanup | Stop process, discard ignored `.wrangler/` local state and logs, remove any global log created by a failed run, and report residual risk. Never open, inspect, copy, or delete root `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*`; if one appears, stop and enter `Drift`. |
| Operator authorization | None is needed or permitted for this local-only slice. Any discovered external effect requires stopping and a separately recorded lifecycle-scoped authorization; credentials remain operator-controlled. |
