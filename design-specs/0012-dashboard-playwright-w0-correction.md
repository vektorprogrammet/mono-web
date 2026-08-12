# Accepted revision 0012 — Dashboard Playwright W0 correction

> **Summary:** This bounded revision repairs the accepted0010 Wave 0 browser gate without weakening it after code review found that implementation `36cadc3` used a disposable fixture/README path that could produce false-green generic login evidence. The five-file capsule makes the loopback fixture tracked and deterministic, starts it first through Playwright only in exact fixture mode, and makes the named `apps/dashboard/e2e/auth.spec.ts` test reset and assert the fixture's sanitized `/api/login` event after the visible error. Node 22 still invokes the installed CLI from the dashboard cwd, the dev server and fixture bind loopback, Chromium uses a portable optional executable input, and the `_page` collection repair plus effective-viewport assertion remain. This revision records inherited red W0 evidence and observed implementation under review; it does **not** claim a tracked-file W0 pass.

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0012` |
| Title | `Dashboard Playwright W0 correction` |
| Status | **`conforming`** — final code PASS (`agent://DashboardW0FinalCodeReview`) and runtime PASS (`agent://DashboardW0FinalRuntimeVerifier`); final tracked-file double pass complete on `2d3ca0b`; lifecycle `Conforming/current`; capsule consumed and freeze complete |
| Prior accepted spec commit | `7153ad7eda4a3e93b08b37676b05d9b8d4870168` |
| Implementation | `fd6ee4c` + `2d3ca0b` — **Conforming**; five-path tracked implementation and narrowed harness diff complete |
| Revision review | `agent://DashboardPlaywrightW0CodeReview` (historical); independent final PASS: `agent://DashboardW0FixtureSpecReview`, `agent://DashboardW0FixtureFeasibility`; implementation code PASS: `agent://DashboardW0FinalCodeReview`; runtime PASS: `agent://DashboardW0FinalRuntimeVerifier` |
| Reviewed spec commit | `c2babbe` |
| Spec worktree | `/tmp/mono-web-dashboard-playwright-w0-spec-0012-20260810` |
| Spec branch | `spec/0012-dashboard-playwright-w0-correction` |
| Runtime authority | `agent://DashboardAuthorityW0Verifier`; auditable transcript `history://DashboardAuthorityW0Verifier` |
| Independent diagnosis | `agent://DashboardPlaywrightW0Debugger` |
| Predecessor | Accepted `design-specs/0010-dashboard-bun-sdk-resolution.md`, S0 complete at the base checkpoint; S5 authorized to resume after this conformance record |
| Future owner | One accepted0010 integrator; one patch capsule and one PR |
| Product boundary | Harness-only W0 evidence. No frontend visual requirement, product result, provider action, backend claim, or production evidence |

This file records the accepted contract and its consumed implementation. The final tracked `test:e2e:w0` journey passed twice on `2d3ca0b` under isolated loopback with validated Node 22/Bun 1.3.10, exact fixture event assertions, one ready line and one graceful SIGTERM shutdown line per pass, and cleanup. The no-fixture auth collection first hit a transient Playwright preflight-missing error; the exact retry then passed 5 tests with 3 expected skips (the named W0 callback and two pre-existing static skips), outside W0 green evidence. Dashboard typecheck exits 2 with the same 11 pre-existing route/SDK diagnostics outside this capsule; no changed-path diagnostics and no broad green claim. No statement here authorizes a provider, deployment, publication, credential, remote-state, backend, SDK-source, or product effect.

## 1. Corrective contract

### 1.1 Goal

Accepted0010 cannot resume from S0 on the existing browser gate because the gate currently fails before a browser can run. The corrective contract preserves the gate's strictness and removes only demonstrated harness ambiguity:

```text
accepted0010 S0
  → frozen Bun 1.3.10 install
  → corrected SDK dist build (argument order fixed; SDK source unchanged)
  → loopback fixture at 127.0.0.1:8788; all non-loopback traffic denied
  → Node >=22 invokes installed Playwright CLI from apps/dashboard
  → tracked fixture auto-starts first at 127.0.0.1:8788; fixture readiness gates on 127.0.0.1:8788/health
  → dashboard webServer binds and Playwright readiness polls 127.0.0.1:5174
  → fixed 1440x900 viewport re-applied after every Desktop Chrome/Firefox/WebKit device spread
  → auth.spec named invalid-credentials test resets then proves the exact sanitized fixture event, twice
  → browser launch + Playwright control + SDK-backed login + deterministic fixture 401 + visible error assertion
  → clean worktree and disposable-artifact cleanup
  → resume accepted0010 S5 only after the five-file tracked journey
```

W0 remains a **reachability gate**, not a dashboard feature test. A successful W0 proves only that this one SDK-backed login path can be driven by the corrected harness under loopback conditions. It does not prove visual fidelity, route coverage, backend parity, provider health, deployment, or production behavior.

### 1.2 Source boundary

The future corrective patch capsule may change only these tracked files:

1. `apps/dashboard/package.json`
2. `apps/dashboard/playwright.config.ts`
3. `apps/dashboard/e2e/auth.spec.ts`
4. `apps/dashboard/README.md`
5. `apps/dashboard/e2e/fixtures/login-api.mjs`

No lockfile, dependency declaration, SDK source, route, product fixture, provider file, CI file, root hook, or other path may change. Any lock/dependency change is `Drift` and stops the capsule; the observed package already has `engines.node: ">=22"` and `@playwright/test`, so this revision proposes no install or dependency change.

### 1.3 Non-goals and forbidden effects

- Do not change `packages/sdk/src/**`, SDK exports, schemas, transport, version, or API semantics. The SDK build correction is a consumed command/evidence correction only.
- Do not change dashboard routes, labels, product login behavior, or product UI. The auth-spec edits are harness-only: retain the viewport assertion, add the Playwright `request` reset/event proof, and repair only the invalid skipped callback's fixture signature.
- The tracked fixture is a deterministic test authority, not a mock-success fallback for the dashboard: it accepts only the fixed synthetic invalid-login JSON, returns deterministic `401`, and exposes only the bounded health/reset/events contract.
- Do not add a compatibility alias, route-specific exception, retry loop, or test skip to hide a runner or fixture failure. Do not use a disposable/external fixture, temporary config, copied test, inline test, wrapper, or untracked README command for final evidence.
- Do not add a browser binary, commit a browser binary, hardcode a workstation path, or document an unobserved browser-install command.
- Do not use agent-browser, screenshots, video, visual baselines, or Foldkit evidence for W0. There is no frontend visual requirement: this is a mechanical harness correction and W0 has no product evidence obligation.
- Do not contact a provider, Railway, Cloudflare, Alchemy, remote API, production service, or non-loopback host. No provider claim follows from this spec.
- Do not resume accepted0010 S5 until the final tracked-file named test has passed twice with `--retries=0`, the in-test fixture event proof passed on both runs, and the worktree is clean. [Complete: S5 is now authorized to resume.]

## 2. Frozen source and runtime evidence

The following are observations at the exact base or in the runtime authorities, including the revision code review. They are not a prior green tracked-file W0 result. Future causal statements are marked `[INFERENCE]` or `[PROPOSED]`.

| ID | Frozen observation | Evidence |
|---|---|---|
| `O-0012-1` | The base dashboard package requires Node `>=22`, has `@playwright/test`, and currently exposes `test:e2e: "playwright test"` plus `e2e:test:*`, report, codegen, and install scripts prefixed with `exec`. | `apps/dashboard/package.json:6-24,66-70` |
| `O-0012-2` | The base Playwright config uses `baseURL: http://localhost:5174`, `webServer.command: bun run dev`, `webServer.url: http://localhost:5174`, `timeout: 120_000`, and `reuseExistingServer: !process.env.CI`. It does not set the W0 viewport or a portable Chromium executable input. | `apps/dashboard/playwright.config.ts:14-82` |
| `O-0012-3` | The original auth spec contains the named test `shows error on invalid credentials` and an otherwise skipped callback declared as `async ({ _page }) =>`; `_page` is not a Playwright fixture. | `apps/dashboard/e2e/auth.spec.ts:19-29,48-52` |
| `O-0012-4` | The existing Bun-run Playwright attempt exits before browser launch because Playwright's transform looks for `apps/dashboard/playwright.config.ts.esm.preflight` and cannot find that generated module. | Primary: `agent://DashboardPlaywrightW0Debugger` (`red_command`); corroborating transcript: `history://DashboardAuthorityW0Verifier` |
| `O-0012-5` | Under the explicit Node 22 fallback, the unmodified dev command starts on `[::1]:5173`, while the config readiness poll requests `::1:5174` and repeatedly receives `ECONNREFUSED`. A config outside the app cwd runs `bun run dev` from that temporary directory and reports `Script not found "dev"`; placing the same temporary config under `apps/dashboard` changes the cwd and starts the server. | Primary: `agent://DashboardPlaywrightW0Debugger` (`node_timeout_repro`); corroborating transcript: `history://DashboardAuthorityW0Verifier` |
| `O-0012-6` | A corrected temporary config using `http://127.0.0.1:5174` for both bind/readiness, `bun run dev --host 127.0.0.1 --port 5174`, and an explicit system Chromium executable reached the browser under Node `v22.23.1` and Playwright `1.58.2`. The config's project-level `Desktop Chrome` device setting superseded its root `1440x900` setting; this diagnosis did not measure an effective viewport, so the future `1440x900` override remains unproven. The isolated copy of the named invalid-credentials test passed in `4.7s` and `4.1s`; the fixture recorded `POST /api/login` on both runs. | `agent://DashboardPlaywrightW0Debugger` (`green_command`, `pass_1`, `pass_2`); viewport-precedence reanalysis: `agent://DashboardPlaywrightW0FeasibilityReview` |
| `O-0012-7` | The green diagnosis used a temporary config and temporary isolated spec copy because the original auth spec still fails collection on `_page`. It is evidence that the corrected mechanics can work, not evidence that the unchanged original file passed. | `agent://DashboardPlaywrightW0Debugger` (`evidence_limits`) |
| `O-0012-8` | The accepted0010 SDK build instruction's ordering is a no-op/usage path: `bunx --bun bun@1.3.10 --cwd packages/sdk run build`. The proven command is `bunx --bun bun@1.3.10 run --cwd packages/sdk build`, which runs `$ tsc -b` and exits `0`; the four required dist exports were present before cleanup. | Primary: `agent://DashboardPlaywrightW0Debugger` (`sdk_build`); accepted0010 source: `design-specs/0010-dashboard-bun-sdk-resolution.md:409-417`; corroborating transcript: `history://DashboardAuthorityW0Verifier` |
| `O-0012-9` | The SDK package's generated exports are `dist/promise.js`, `dist/promise.d.ts`, `dist/effect-client.js`, and `dist/effect-client.d.ts`; its source build script is `tsc -b`. | `packages/sdk/package.json:5-19` |
| `O-0012-10` | The independent diagnosis cleaned temporary configs/specs/logs/processes/listeners and left its tracked checkout clean. No non-loopback service, provider, real credential, or production state was used. | `agent://DashboardPlaywrightW0Debugger` (`cleanup`) |
| `O-0012-11` | The diagnostic capsule lacked a usable Playwright-managed Chromium binary/library set; the green runs reached Chromium through an already-installed system browser. No browser-install command was observed or proven. When the managed browser is absent, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is mandatory for that environment; its value remains a noncommitted operator input. | `agent://DashboardPlaywrightW0Debugger` (`evidence_limits`) |
| `O-0012-12` | Frozen workspace resolution uses an app-local `apps/dashboard/node_modules/@playwright/test` link whose realpath is under `node_modules/.bun/@playwright+test@1.58.2/node_modules/@playwright/test`; no root `node_modules/@playwright/test` file is present at this base. | `history://DashboardPlaywrightW0Debugger` (app-local realpath); `history://DashboardAuthorityW0Verifier` (root install listing) |
| `O-0012-13` | Observed implementation `36cadc3` reached a `Building` state but is not accepted. Code review found its disposable fixture and README path could make the generic visible login error appear green without proving that the dashboard's SDK-configured login path produced the observed fixture request; it is false-green evidence until a tracked fixture and in-test event assertion close that causal gap. | `agent://DashboardPlaywrightW0CodeReview` |
| `O-0012-14` | The revision therefore requires a tracked plain-Node fixture, Playwright-managed fixture startup, and an auth-spec `request` reset plus exact sanitized `/api/login` event assertion. The prior temporary-copy durations and POST observation remain diagnosis limits, not tracked-file W0 evidence. | `[PROPOSED]` revision contract grounded by `agent://DashboardPlaywrightW0CodeReview` |

### 2.1 Red reproduction record

The authority run used an already-cached exact Bun `1.3.10` runtime. The portable command below requires the operator to supply that executable through `BUN_1_3_10_BIN`; the path is validated at runtime and is never committed. A bare `bun`, `bunx`, or other PATH-selected substitute is non-conforming red evidence:

```sh
: "${BUN_1_3_10_BIN:?set to an already-cached Bun 1.3.10 executable}"
test -x "$BUN_1_3_10_BIN"
export BUN_1_3_10_BIN

unshare -Urn sh -c '
  ip link set lo up 2>/dev/null || true
  API_URL=http://127.0.0.1:8787 \
  VITE_API_URL=http://127.0.0.1:8787 \
  API_MODE=fixture \
  VITE_API_MODE=fixture \
  DASHBOARD_CUTOVER_FIXTURE_SEED=dashboard-cutover-0010 \
  "$BUN_1_3_10_BIN" run --cwd apps/dashboard test:e2e \
    e2e/auth.spec.ts -g "shows error on invalid credentials" --project=chromium
'
```

This revision inherits that red preflight failure. Observed implementation `36cadc3` is a `Building` artifact, not a replacement green result: its disposable fixture/README path is explicitly under review and cannot authorize W0 or S5.

Observed result: Playwright exits `1` during config transform before browser launch with the missing `playwright.config.ts.esm.preflight` module. This is the frozen red baseline, not a command to document as successful.

The independent Node fallback then used an in-app temporary config and reduced readiness timeout to make the mismatch bounded and observable. It observed:

- Node `v22.23.1` launched `bun run dev`.
- The server printed `http://localhost:5173/` and listened on `[::1]:5173`.
- Playwright polled `http://localhost:5174/`, resolving `localhost` to `::1:5174`, and logged repeated `ECONNREFUSED`.
- A config outside `apps/dashboard` produced `Script not found "dev"` because `webServer.command` was evaluated from the temporary config's cwd.

These observations establish the required source correction: the command's bind host, readiness URL, base URL, and config cwd must agree. `[INFERENCE]` The Bun runtime itself is not the port/cwd cause; exact Bun `1.3.10` started the corrected server and built the SDK in the independent diagnosis.

### 2.2 Green diagnosis and false-green boundary

The independent diagnosis proved corrected mechanics only with a temporary fixed config and temporary isolated copy of the named test. It used:

- Node `v22.23.1` and Bun `1.3.10`;
- Playwright `1.58.2` and project `chromium`;
- `baseURL`/readiness `http://127.0.0.1:5174`;
- `webServer.command: bun run dev --host 127.0.0.1 --port 5174`;
- the `Desktop Chrome` project setting superseded the temporary config's root `1440x900` setting; this diagnosis did not measure an effective viewport, so the future `1440x900` override remains unproven;
- an explicit system Chromium executable supplied at runtime, with the workstation-specific absolute path intentionally **not** carried into this spec or future source;
- fixture/API variables pointed at `http://127.0.0.1:8787`, seed `dashboard-cutover-0010`, and non-loopback network denied;
- two passes (`4.7s`, `4.1s`) with Chromium launch, Playwright control, fixture `POST /api/login`, and the invalid-credentials assertion.

The exact absolute Node and Chromium paths were capsule-local workstation inputs. They are intentionally not prescribed here. The future patch must accept `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when an operator needs an explicit system browser and otherwise leave `launchOptions.executablePath` unset so Playwright uses its installed browser. **No claim is made that `apps/dashboard/e2e/auth.spec.ts` itself has passed.**

Separately, implementation `36cadc3` is observed in `Building` but is not accepted. The revision code review found that its disposable fixture and README path could satisfy a generic visible error without proving the SDK-configured login request reached the intended fixture. Therefore the temporary-copy green runs and the observed implementation are diagnosis/review evidence only. The tracked fixture, Playwright webServer ordering, `request` reset, and exact in-test event assertion below are required to close that false-green gap. The future capsule deliberately moves its new tracked fixture to `127.0.0.1:8788` so accepted0010/Receipt0008's historical `127.0.0.1:8787` fixture remains untouched.


## 3. Consumed implementation capsule

### 3.1 One capsule, one PR

| Field | Frozen contract |
|---|---|
| Capsule ID | `0012-dashboard-playwright-w0-correction` |
| Start gate | Final independent review and product/operator acceptance preceded implementation; the exact contract is consumed and frozen |
| Base | Clean `01062ed9c1892832dfe52c756d05f77da5b70ef5` |
| Tracked patch paths | Exactly five: `apps/dashboard/package.json`, `apps/dashboard/playwright.config.ts`, `apps/dashboard/e2e/auth.spec.ts`, `apps/dashboard/README.md`, `apps/dashboard/e2e/fixtures/login-api.mjs` |
| Integrator | Accepted0010 integrator, one owner, one implementation PR |
| SDK boundary | Read-only `packages/sdk/**`; only the corrected build command is consumed |
| Browser boundary | Playwright is the authority for W0; no agent-browser or visual evidence |
| Resume point | Accepted0010 §7.2.3 S5, only after this capsule's tracked-file double pass, exact fixture-event proof, and cleanup |
| Forbidden | Any lock/dependency churn, source outside five paths, disposable/external fixture, provider/backend/remote effects, visual/product claims, real credentials, non-loopback traffic |
| Consumption | Consumed by implementation `fd6ee4c` + `2d3ca0b`; lifecycle is frozen at Conforming/current. |

The five-file list was the hard boundary and was satisfied by `fd6ee4c` + `2d3ca0b`; the capsule is consumed and frozen. Implementation `36cadc3` remains historical nonconforming review evidence only.

### 3.2 `apps/dashboard/package.json`

Replace every Playwright script that currently invokes `playwright` directly or prefixes it with `exec` so the installed CLI is invoked by Node from the dashboard app cwd through the workspace's **app-local installed link**. Bun's frozen workspace layout keeps this package edge under `apps/dashboard/node_modules` and links it into the root `node_modules/.bun` store; the root package does not declare `@playwright/test` (`package.json:21-33`), so a root-relative `../../node_modules/@playwright/test/cli.js` is not an authority path. Preserve the useful general script names and their intent, but remove the Bun-Playwright ambiguity and all `exec` prefixes. Add one canonical `test:e2e:w0` script: it owns all five exact fixture environment assignments, the tracked-file selector, `--project=chromium`, and `--retries=0`. The README and Phase D invoke only this script; they must not duplicate its CLI, env, selector, or retry arguments. From `apps/dashboard`, the resulting script family must have this exact shape:

```json
{
  "test:e2e": "node ./node_modules/@playwright/test/cli.js test",
  "test:e2e:w0": "API_URL=http://127.0.0.1:8788 VITE_API_URL=http://127.0.0.1:8788 API_MODE=fixture VITE_API_MODE=fixture DASHBOARD_CUTOVER_FIXTURE_SEED=dashboard-cutover-0010 node ./node_modules/@playwright/test/cli.js test e2e/auth.spec.ts -g \"shows error on invalid credentials\" --project=chromium --retries=0",
  "e2e:test": "node ./node_modules/@playwright/test/cli.js test",
  "e2e:test:ui": "node ./node_modules/@playwright/test/cli.js test --ui",
  "e2e:test:chrome": "node ./node_modules/@playwright/test/cli.js test --project=chromium",
  "e2e:test:firefox": "node ./node_modules/@playwright/test/cli.js test --project=firefox",
  "e2e:test:webkit": "node ./node_modules/@playwright/test/cli.js test --project=webkit",
  "e2e:test:generate": "node ./node_modules/@playwright/test/cli.js codegen",
  "e2e:show-report": "node ./node_modules/@playwright/test/cli.js show-report",
  "e2e:install": "node ./node_modules/@playwright/test/cli.js install"
}
```

`test:e2e:w0` is the single source for the W0 env/selector/retry contract. The general scripts remain usable: when `!fixtureMode` (both mode variables unset, one-sided, or otherwise nonexact), the config uses app-only webServer behavior, starts no fixture, and the named auth test's callback skips before any fixture request. `./node_modules/@playwright/test/cli.js` is a literal app-local path from the dashboard cwd, not a dynamic path choice. The frozen-install preflight in §4 must prove this exact file exists, resolve it with `realpath`, assert that it lands at the root `node_modules/.bun/@playwright+test@1.58.2/node_modules/@playwright/test/cli.js` store path, and directly invoke it under `NODE_22_BIN`. The existing `engines.node: ">=22"` remains the package contract. The future journey must invoke `test:e2e:w0` only with an operator-validated Node 22 first on `PATH`.

`e2e:install` may remain as a package script for local operator use, but it is not W0 evidence and must not be documented or run unless a future environment reports a missing browser and the actual observed installation command is recorded. This capsule does not add a dependency or change a lock.

### 3.3 `apps/dashboard/playwright.config.ts`

Keep the existing test directory/projects unless a source-level type error proves otherwise. Make the following values explicit and internally identical:

```ts
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const w0Viewport = { width: 1440, height: 900 };
const apiMode = process.env.API_MODE;
const viteApiMode = process.env.VITE_API_MODE;
const fixtureMode =
  apiMode === "fixture" && viteApiMode === "fixture";

const fixtureServer = {
  command: "node e2e/fixtures/login-api.mjs",
  url: "http://127.0.0.1:8788/health",
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: "pipe" as const,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
};
const dashboardServer = {
  command: "bun run dev --host 127.0.0.1 --port 5174",
  url: "http://127.0.0.1:5174",
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: "pipe" as const,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
};

// Replace the existing workers setting in the exported config:
workers: fixtureMode || process.env.CI ? 1 : undefined,
use: {
  baseURL: "http://127.0.0.1:5174",
  viewport: w0Viewport,
  // trace/reporter and existing test settings may remain
},
webServer: fixtureMode
  ? [fixtureServer, dashboardServer]
  : dashboardServer,
```

When `fixtureMode` is true (both mode variables exactly `fixture`), the tracked fixture is the first web server and the dashboard is second, and `fixtureMode` forces `workers: 1` so the shared fixture event list cannot race between workers. When `!fixtureMode` (both variables unset, one-sided, or otherwise nonexact), the config uses app-only webServer behavior, starts no fixture, and the named auth test is skipped; general package scripts remain usable. Only the package-owned `test:e2e:w0` script supplies both exact values. Any missing or incorrect fixture startup/seed variable makes the fixture process fail before listening; the config must not silently fall back to an app-only green W0 run. Both server entries use loopback URLs, explicit binds, `timeout: 120_000`, literal `reuseExistingServer: false`, `stdout: "pipe"`, and `gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }`.
All existing browser projects must spread their device first and then re-apply `viewport: w0Viewport`, so the shared `1440x900` assertion remains true for Chromium, Firefox, and WebKit while their existing all-project scripts remain usable:

```ts
projects: [
  {
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      viewport: w0Viewport,
      launchOptions: chromiumExecutablePath
        ? { executablePath: chromiumExecutablePath }
        : undefined,
    },
  },
  {
    name: "firefox",
    use: { ...devices["Desktop Firefox"], viewport: w0Viewport },
  },
  {
    name: "webkit",
    use: { ...devices["Desktop Safari"], viewport: w0Viewport },
  },
],
```

Only the Chromium project receives the optional executable input; Firefox/WebKit retain their installed-browser behavior. Do not hardcode `/nix/store`, `/usr/bin`, `/etc/profiles`, a home-directory cache, or any other workstation path. When the environment variable is absent, the config must not set an executable path so Playwright selects its installed browser. When the frozen install has no usable Playwright-managed browser, the env var is mandatory for that environment and must point to an operator-supplied system Chromium; the value is never committed. When it is present, the value is passed unchanged.

Do not remove or retarget the existing all-project, Firefox, or WebKit package scripts; their project selectors remain intact and inherit the post-device-spread viewport. The fixture command is plain Node and resolves through the validated Node directory placed first in the W0 `PATH`; the tracked dashboard command remains bare `bun` and resolves through the validated Bun directory.

### 3.4 `apps/dashboard/e2e/fixtures/login-api.mjs`

Add this tracked fixture as plain Node 22 JavaScript with no new dependency. It is the only authoritative login fixture for the future W0 run:

- Before listening, require these exact values; any missing or different value prints a bounded configuration error and exits nonzero:
  - `API_URL=http://127.0.0.1:8788`
  - `VITE_API_URL=http://127.0.0.1:8788`
  - `API_MODE=fixture`
  - `VITE_API_MODE=fixture`
  - `DASHBOARD_CUTOVER_FIXTURE_SEED=dashboard-cutover-0010`
- Bind an HTTP server only to `127.0.0.1:8788`; never derive the host or port from an operator input and never bind `0.0.0.0`, IPv6 wildcard, or an external interface.
- Serve `GET /health` with deterministic `200` JSON exactly `{ "ok": true, "seed": "dashboard-cutover-0010" }`. It must not append an event.
- After the listener is ready, write exactly one bounded stdout line: `w0-login-fixture ready seed=dashboard-cutover-0010`. This line is provenance; the Playwright readiness gate is the fixture `url` at `http://127.0.0.1:8788/health`. Do not print request bodies, passwords, or unbounded diagnostics.
- Serve `POST /reset` only with an empty body, clear the in-memory event list, and return deterministic HTTP `204`. Invalid method/body combinations are rejected.
- Serve `POST /api/login` only for a bounded JSON body whose keys and values are exactly the synthetic invalid-login input `{ "username": "invalid@test.com", "password": "wrongpassword" }`. Decode the body, never log or retain the password, append only `{ "method": "POST", "path": "/api/login", "username": "invalid@test.com" }`, and return deterministic HTTP `401` JSON.
- Serve `GET /events` with the ordered sanitized event list and no other request data. The expected post-login response is exactly `{ "events": [{ "method": "POST", "path": "/api/login", "username": "invalid@test.com" }] }`.
- Reject every other route, method, malformed JSON, extra login key, wrong synthetic value, and body over the exact `8192`-byte limit with a deterministic `4xx`; rejected requests must not append events. The `8192`-byte limit must be enforced while reading chunks, not only from `Content-Length`.
- On `SIGTERM`, close the listener cleanly within the Playwright `5_000` ms graceful-shutdown window, write exactly one bounded stdout line `w0-login-fixture shutdown signal=SIGTERM`, and exit `0`. No process, log, report, trace, wrapper, or fixture state may remain after cleanup.

The fixture records no PII beyond the synthetic `invalid@test.com` username required by the named test. It must not call a provider, external API, dashboard route, SDK, filesystem persistence, or network other than its loopback listener.

### 3.5 `apps/dashboard/e2e/auth.spec.ts`

Change the named invalid-credentials test only by making it structurally W0-only, adding Playwright `request` reset/event proof alongside the existing effective-viewport assertion, and changing the skipped logout callback from the unknown fixture shape to a no-fixture callback. The named test is skipped unless both mode variables are exactly `fixture`; once collected in the exact pair, reset and event assertions are unconditional:

```ts
const fixtureMode =
  process.env.API_MODE === "fixture" &&
  process.env.VITE_API_MODE === "fixture";

test("shows error on invalid credentials", async ({ page, request }) => {
  test.skip(!fixtureMode, 'requires the exact W0 fixture mode pair');
  const reset = await request.post("http://127.0.0.1:8788/reset");
  expect(reset.status()).toBe(204);

  await page.goto("/login");
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });

  await page.getByLabel("Brukernavn eller e-post").fill("invalid@test.com");
  await page.getByLabel("Passord").fill("wrongpassword");
  await page.getByRole("button", { name: "Logg inn" }).click();

  await expect(
    page.getByText("Feil brukernavn eller passord"),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const response = await request.get("http://127.0.0.1:8788/events");
      return response.status() === 200 ? response.json() : null;
    })
    .toEqual({
      events: [
        {
          method: "POST",
          path: "/api/login",
          username: "invalid@test.com",
        },
      ],
    });
});

test.skip("logout clears session", async () => {
  // Would need to set up auth state first, then trigger logout
  // and verify redirect back to /login
});
```

The named test's first callback statement is `test.skip(!fixtureMode, 'requires the exact W0 fixture mode pair')`; this scopes the skip to the named test and preserves all other auth tests in non-fixture runs. In the exact fixture pair, reset happens before navigation and the exact event assertion happens after the generic visible error assertion; both are unconditional within the collected test. Do not alter the named test's route, labels, credentials, login action, or visible error assertion. The viewport and event assertions are harness evidence, not product-semantic changes. Outside the exact fixture pair, the named test is skipped while general scripts remain usable. The logout callback remains skipped because valid-session setup is out of scope; it must simply be collectable by Playwright. This repair is required before claiming the named file is collected.

### 3.6 `apps/dashboard/README.md`

The Testing section records the consumed implementation and exact evidence: W0 browser reachability passed through the tracked five-file correction, with no-fixture scope evidence separately disclosed below. The package script is the single source for all five fixture envs, the tracked selector, `--project=chromium`, and `--retries=0`; README supplies only CI, the isolated namespace, and the dual validated-runtime `PATH`:

```sh
# from the repository root; set these noncommitted operator inputs first
: "${BUN_1_3_10_BIN:?set to an already-cached Bun 1.3.10 executable}"
: "${NODE_22_BIN:?set to a Node 22 executable}"
test -x "$BUN_1_3_10_BIN"
test -x "$NODE_22_BIN"
test "$("$BUN_1_3_10_BIN" --version)" = "1.3.10"
test "$("$NODE_22_BIN" -p \
  'Number(process.versions.node.split(".")[0]) >= 22 && process.versions.bun === undefined ? "ok" : "bad"')" = "ok"
export BUN_1_3_10_BIN NODE_22_BIN

# Optional only when Playwright's managed Chromium is unavailable:
# export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="<operator-supplied-system-chromium>"

unshare -Urn sh -c '
  ip link set lo up 2>/dev/null || true
  CI=1 \
  PATH="$(dirname "$NODE_22_BIN"):$(dirname "$BUN_1_3_10_BIN"):$PATH" \
    "$BUN_1_3_10_BIN" run --cwd apps/dashboard test:e2e:w0
'
```

The config auto-starts `node e2e/fixtures/login-api.mjs` first and the dashboard server second when both mode variables are exact; the package script supplies those mode variables and the seed. The command must not start a disposable fixture or use a temporary config/copy/wrapper. The fixture `url` at `http://127.0.0.1:8788/health` is the readiness gate; the uniquely prefixed stdout line is recorded provenance only. Because the named test is skipped outside the exact pair, the README must state that its in-test event proof must observe exactly:

```json
{"events":[{"method":"POST","path":"/api/login","username":"invalid@test.com"}]}
```

The fixture stdout must also show exactly one bounded `w0-login-fixture ready seed=dashboard-cutover-0010` line and one graceful `w0-login-fixture shutdown signal=SIGTERM` line, with Playwright's `stdout: "pipe"` and `gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }` contract. These lines are lifecycle provenance, not the readiness trigger. This is a W0 login reachability probe, not a product/visual suite; it requires validated Node `>=22` and Bun `1.3.10`, denies all non-loopback traffic, and accepts the optional runtime `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only when a managed Playwright browser is unavailable. No workstation path or unobserved browser-install command may be documented.


## 4. Consumed implementation journey

The integrator performed one mechanical journey in a fresh worktree. Every phase records exact command, cwd, runtime versions, exit status, and sanitized evidence. A failure would return to `Drift`; it was not hidden by changing the test scope.

### Phase A — establish base and freeze inherited red evidence

1. Start at clean `01062ed9c1892832dfe52c756d05f77da5b70ef5`, verify the branch/worktree, and confirm no generated `node_modules`, `packages/sdk/dist`, Playwright report, trace, ignored fixture log, or fixture process is being mistaken for tracked source. The only intended new source path is `apps/dashboard/e2e/fixtures/login-api.mjs`.
2. Define the two noncommitted operator runtime inputs. They must be executable files, and their versions/process identity must be proven before entering the isolated network namespace:

   ```sh
   : "${BUN_1_3_10_BIN:?set to an already-cached Bun 1.3.10 executable}"
   : "${NODE_22_BIN:?set to a Node 22 executable}"
   test -x "$BUN_1_3_10_BIN"
   test -x "$NODE_22_BIN"
   test "$("$BUN_1_3_10_BIN" --version)" = "1.3.10"
   "$NODE_22_BIN" --version
   test "$("$NODE_22_BIN" -p \
     'Number(process.versions.node.split(".")[0]) >= 22 && process.versions.bun === undefined ? "ok" : "bad"')" = "ok"
   test "$(PATH="$(dirname "$NODE_22_BIN"):$PATH" command -v node)" = "$NODE_22_BIN"
   export BUN_1_3_10_BIN NODE_22_BIN
   ```

   The `NODE_22_BIN -p` assertion proves both Node `>=22` and absent `process.versions.bun`; a Bun-compatible version string is not sufficient. Do not use `bunx --bun` to provide either runtime. Keep the exact executable paths outside the repository and never commit them.
3. Run the inherited red existing Bun package command from §2.1 under loopback-only `unshare -Urn`. Retain the missing `playwright.config.ts.esm.preflight` failure and `exit 1` as red evidence. Do not call this a test failure after browser launch; it is a config-transform failure.
4. Reproduce the Node fallback observations with a temporary config only: config outside `apps/dashboard` must show `Script not found "dev"`; an in-app config whose `webServer.command` uses the exact `$BUN_1_3_10_BIN run dev` command must show `[::1]:5173` versus readiness `::1:5174` and `ECONNREFUSED`. Temporary files are evidence artifacts only and are not in the capsule.
5. Record `36cadc3` as observed `Building`, not accepted, and retain `agent://DashboardPlaywrightW0CodeReview` as the false-green review authority. Do not promote its disposable fixture, README command, generic visible error, or temporary-copy POST observation to tracked-file W0 evidence.
6. Preserve the accepted0010 command-ordering evidence from `O-0012-8`: the historical candidate `bunx --bun bun@1.3.10 --cwd packages/sdk run build` is the no-op/usage path, while the proven ordering is `bunx --bun bun@1.3.10 run --cwd packages/sdk build`. Do not execute either wrapper in the future capsule; reuse the validated exact binary without the wrapper:

   ```sh
   "$BUN_1_3_10_BIN" run --cwd packages/sdk build
   ```

   It must run `$ tsc -b` and exit `0`. The source tree under `packages/sdk/**` remains untouched.

### Phase B — apply only the five-file patch

7. Apply the future capsule to exactly the five paths in §3.1. Re-read the patch and verify:

   - no `exec playwright` or raw Bun Playwright script remains;
   - every general package script uses the literal app-local `node ./node_modules/@playwright/test/cli.js` path from the dashboard app cwd, and `test:e2e:w0` is the single source for all five fixture envs, the tracked `e2e/auth.spec.ts` selector, `--project=chromium`, and `--retries=0`;
   - the frozen-install preflight proves `apps/dashboard/node_modules/@playwright/test/cli.js` exists, its realpath is the root `node_modules/.bun/@playwright+test@1.58.2/node_modules/@playwright/test/cli.js` store path, and direct Node `--version` invocation succeeds;
   - the mode pair starts fixture mode only when both variables exactly equal `fixture`; any one-sided fixture request/nonexact fixture pair remains app-only, starts no fixture, and leaves the named test skipped outside the W0 gate; the package-owned `test:e2e:w0` supplies both values; fixture mode is the first fixture webServer and second dashboard webServer;
   - replace the existing `workers` setting with `workers: fixtureMode || process.env.CI ? 1 : undefined`; do not add a duplicate `workers` key;
   - bind, poll, and base URLs are all exactly `http://127.0.0.1:5174`, and the fixture health URL is exactly `http://127.0.0.1:8788/health`;
   - Chromium, Firefox, and WebKit each re-apply `viewport: w0Viewport` after their device spread, and the named test asserts `page.viewportSize()` equals `{ width: 1440, height: 900 }`; only Chromium consumes the optional env executable path;
   - the W0 PATH prefix contains both validated Node and Bun directories, so the fixture's bare `node` and the tracked dashboard's bare `bun` resolve the validated runtimes;
   - `login-api.mjs` validates all five exact fixture envs before listening, emits exactly one bounded `w0-login-fixture ready seed=dashboard-cutover-0010` line as provenance, enforces the bounded routes/body, records only the exact sanitized event, emits exactly one `w0-login-fixture shutdown signal=SIGTERM` line on graceful close, and handles SIGTERM within `5_000` ms;
   - the named auth test skips when `!fixtureMode`; in exact fixture mode it unconditionally resets the tracked fixture before navigation and polls/asserts the exact event after the generic visible error;
   - no workstation path, disposable fixture, temporary config/copy, wrapper, or fixture log is in the diff;
   - README contains only the standalone CI/unshare/dual-PATH invocation of `test:e2e:w0` and expected event proof after the final double pass.
8. Stop if `git diff --name-only` contains anything outside the five paths. Do not repair unrelated dashboard or SDK code.

### Phase C — frozen install, SDK build, and tracked fixture preflight

9. From the repository root, use the validated exact Bun binary and a capsule-local cache for frozen install:

   ```sh
   BUN_INSTALL_CACHE_DIR=/tmp/dashboard-playwright-w0-correction-bun-cache \
     "$BUN_1_3_10_BIN" install --frozen-lockfile
   ```

   Before any browser run, prove the app-local CLI file, its workspace-store realpath, and direct Node resolution from the dashboard cwd:

   ```sh
   PLAYWRIGHT_CLI="$PWD/apps/dashboard/node_modules/@playwright/test/cli.js"
   test -f "$PLAYWRIGHT_CLI"
   PLAYWRIGHT_CLI_REALPATH="$(realpath "$PLAYWRIGHT_CLI")"
   case "$PLAYWRIGHT_CLI_REALPATH" in
     "$PWD"/node_modules/.bun/@playwright+test@1.58.2/node_modules/@playwright/test/cli.js) ;;
     *) printf 'unexpected Playwright CLI realpath: %s\n' "$PLAYWRIGHT_CLI_REALPATH" >&2; exit 1 ;;
   esac
   (cd apps/dashboard && "$NODE_22_BIN" ./node_modules/@playwright/test/cli.js --version)
   ```

   This exact preflight must pass; a missing app-local file, a realpath outside the root `node_modules/.bun/@playwright+test@1.58.2/` store, or a direct Node invocation failure is `Drift`. The cache path is capsule-local and disposable. A lockfile mutation or dependency resolution that requires source outside the capsule is `Drift`.
10. Build generated SDK output before any dashboard typecheck or browser check using the same validated exact Bun binary and the proven argument order:

    ```sh
    "$BUN_1_3_10_BIN" run --cwd packages/sdk build
    ```

    Assert all four generated files exist:

    ```sh
    test -f packages/sdk/dist/promise.js
    test -f packages/sdk/dist/promise.d.ts
    test -f packages/sdk/dist/effect-client.js
    test -f packages/sdk/dist/effect-client.d.ts
    ```

    Keep `packages/sdk/dist/**` local through W0; never commit it. This is a generated prerequisite, not SDK source work.
11. After install/build, enter the isolated `unshare -Urn` namespace used for the browser command, bring up only loopback, deny all non-loopback traffic, and do not duplicate the five fixture variables in the shell: `test:e2e:w0` owns the exact assignments in §3.2 and exports them for the Playwright process. Preserve the optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` operator input only when a managed browser is unavailable.

    Do not start the fixture manually. The Playwright config must start the tracked `node e2e/fixtures/login-api.mjs` first because the package script supplies both exact mode variables, then start the dashboard server. The fixture must fail before listening if any of the five values is missing or wrong; the fixture `url` at `http://127.0.0.1:8788/health` is the readiness gate and must return the exact seed JSON. Record the uniquely prefixed stdout line `w0-login-fixture ready seed=dashboard-cutover-0010` as provenance, plus namespace, `w0-login-fixture shutdown signal=SIGTERM`, and denial result. No external DNS/API/provider request is allowed.

### Phase D — tracked auth double pass with fixture-event proof

12. With loopback up and non-loopback traffic denied in the isolated namespace, run the **same exact tracked-file package script** twice, with no shell fixture exports, temporary config, fixture, wrapper, or test copy:

    ```sh
    CI=1 \
    PATH="$(dirname "$NODE_22_BIN"):$(dirname "$BUN_1_3_10_BIN"):$PATH" \
      "$BUN_1_3_10_BIN" run --cwd apps/dashboard test:e2e:w0
    ```

    Before each pass, run `test "$(PATH="$(dirname "$NODE_22_BIN"):$PATH" command -v node)" = "$NODE_22_BIN"` and `test "$(PATH="$(dirname "$BUN_1_3_10_BIN"):$PATH" command -v bun)" = "$BUN_1_3_10_BIN"`, then record `"$NODE_22_BIN" -p 'JSON.stringify({ node: process.version, bun: process.versions.bun ?? null })'` and verify the PATH-selected `node` is the same validated Node 22 runtime. `test:e2e:w0` must own the five exact fixture env assignments, `e2e/auth.spec.ts -g "shows error on invalid credentials"`, `--project=chromium`, and `--retries=0`; the README and shell command must not repeat them.
13. Each pass is green only when all of these are observed:

    - Node `>=22` invokes the installed app-local Playwright CLI; `process.versions.bun` is absent and no Bun Playwright config transform is used.
    - The config accepts the exact fixture mode pair, replaces the existing `workers` setting with `workers: 1`, starts the tracked fixture first, uses `http://127.0.0.1:8788/health` as the readiness gate with seed `dashboard-cutover-0010`, records exactly one `w0-login-fixture ready seed=dashboard-cutover-0010` stdout provenance line, then starts the dashboard server on `127.0.0.1:5174`; the fixture process is plain Node 22 and the dashboard process resolves the validated bare `bun`.
    - Playwright reports exactly one selected test in project `chromium`, reaches a launched Chromium browser, and controls the page.
    - The named test's viewport assertion passes with effective `{ width: 1440, height: 900 }` after the device spread.
    - The page reaches `/login` through `http://127.0.0.1:5174`; the named test fills the unchanged synthetic invalid credentials and observes the unchanged visible error assertion.
    - The named test's `request` fixture unconditionally resets before navigation and, after the visible error, polls `/events` until it observes exactly `{ "events": [{ "method": "POST", "path": "/api/login", "username": "invalid@test.com" }] }`; the named test is not collected outside the exact fixture pair, so no password or extra event data is accepted.
    - Playwright closes the fixture server with `SIGTERM` within `5_000` ms and records exactly one `w0-login-fixture shutdown signal=SIGTERM` stdout line; dashboard shutdown is verified only by no W0 listener/process remaining.
    - The run exits `0` with `--retries=0`; output records exactly one passed selected test and zero failed, skipped, flaky, or retried attempts. Record duration and sanitized stdout/stderr.

    Both passes must use `apps/dashboard/e2e/auth.spec.ts`, not a copied file, inline test, temporary config, or disposable fixture. The prior isolated-copy results (`4.7s`/`4.1s`) and observed `36cadc3` remain diagnosis/review evidence only; final tracked-file durations, event assertions, and lifecycle lines are new evidence. A single pass is insufficient.

### Phase E — freeze, clean, and resume

14. The final tracked-file double pass and both exact in-test event assertions succeeded on `2d3ca0b`; the README Testing block records the frozen command from §3.6. No browser-install command was added.
15. Temporary configs/specs, reports, traces, screenshots, ignored fixture logs, generated route artifacts, `node_modules`, ignored SDK dist, capsule cache, and browser/fixture processes were removed. Both sanitized event proofs and exactly one ready plus one graceful SIGTERM shutdown line per pass were retained as evidence. No listener remains on `5173`, `5174`, or `8788`; the accepted0008 Receipt fixture listener on `8787` was not disturbed; no matching W0 process, disposable fixture, or wrapper remains; and no non-loopback request occurred.
16. The implementation diff contains only the five paths, generated artifacts are absent from the index, the README command and event proof are exact, and the implementation worktree is clean. Accepted0010 §7.2.3 S5 is authorized to resume exactly, including its accepted Receipt0008 replay/order; this W0 capsule does not edit or reinterpret S5.

## 5. Drift handling and falsifiers

### 5.1 Drift register

| ID | Drift condition | Return path |
|---|---|---|
| `D-0012-1` | Bun transform again seeks `playwright.config.ts.esm.preflight`, or the patch claims the existing Bun Playwright path is green. | Stop before browser; retain transform output; re-check package script/CLI boundary. |
| `D-0012-2` | Dev server binds/polls any host or port other than the exact pair `127.0.0.1:5174`, including `localhost`, `::1`, or default `5173`. | Stop W0; correct config only, not a route or server workaround. |
| `D-0012-3` | `webServer.command` resolves from a temporary/outside-app cwd or reports `Script not found "dev"`. | Stop; ensure the installed CLI/config is executed from `apps/dashboard` and no temp config is used for final evidence. |
| `D-0012-4` | Auth collection reports unknown `_page`/`request` fixture, the named viewport assertion is absent, the fixture-mode reset is missing/before navigation is not proven, or the fixture-mode exact post-error event assertion is absent/changed. | Stop; repair only the harness assertion/request proof and skipped callback; do not alter product login semantics. |
| `D-0012-5` | The SDK build uses `--cwd packages/sdk run build`, skips dist, edits SDK source, or commits generated dist. | Stop; use the validated exact `"$BUN_1_3_10_BIN" run --cwd packages/sdk build`; source/dist boundary remains unchanged. |
| `D-0012-6` | Playwright needs an absolute browser path that is hardcoded in source/docs, the managed browser is absent without the mandatory env input, or a temporary binary/config substitutes for the env input. | Stop; pass `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at runtime when required or use the installed Playwright browser; never commit the path. |
| `D-0012-7` | Green evidence uses a copied test/config, disposable fixture, direct inline test, another project, a different selector, or only one pass. | Stop; repeat the exact tracked-file named test twice with the tracked fixture. Prior copy/implementation evidence cannot be promoted. |
| `D-0012-8` | The tracked fixture accepts wrong/missing startup env, binds beyond `127.0.0.1:8788`, lacks `/health`, `/reset`, `/api/login`, or `/events` contract, records unsanitized data, accepts malformed/oversized input beyond the exact `8192`-byte body limit, fails to emit bounded `w0-login-fixture ready seed=dashboard-cutover-0010`/`w0-login-fixture shutdown signal=SIGTERM` lines, or fails to close on SIGTERM within `5_000` ms. | Stop and repair the fixture source; no W0 claim is valid. |
| `D-0012-9` | Fixture uses a non-loopback URL, external network is not denied, real credentials/data appear, or a provider/remote service is contacted. | Stop and clean; no W0 claim is valid. |
| `D-0012-10` | A sixth tracked path or any lock/dependency change occurs, or README freezes an unproven command/event proof. | Stop; revert scope expansion and return to review. |
| `D-0012-11` | W0 is presented as visual/product evidence, S5 resumes early, or a green browser run is generalized to backend/provider/production health. | Stop; preserve the harness-only boundary and accepted0010 order. |
| `D-0012-12` | `BUN_1_3_10_BIN` is not exact Bun `1.3.10`, `NODE_22_BIN` is not a real Node `>=22` executable, `NODE_22_BIN -p` reports a Bun runtime, the W0 PATH omits either validated runtime directory, the tracked bare `bun`/`node` resolves to another version, or the final command uses a `bunx --bun` wrapper. | Stop before install/W0; revalidate the noncommitted runtime inputs and PATH. |
| `D-0012-13` | The canonical `test:e2e:w0` script does not own the exact tracked selector, `--project=chromium`, and `--retries=0`, or either final pass reports a flaky/retried attempt, does not show exactly one passed selected test with zero failed/skipped/flaky/retried results, or the viewport/event assertion fails. | Stop; no double-pass claim or S5 resume. |
| `D-0012-14` | Observed implementation `36cadc3`, its disposable fixture, generic visible error, or README is presented as accepted tracked-file evidence. | Stop; cite `agent://DashboardPlaywrightW0CodeReview` and return to the five-file revision. |
| `D-0012-15` | `test:e2e:w0` does not own all five exact fixture env assignments, the README or shell duplicates its CLI/selector/retry/env contract, or the named test is not structurally skipped outside the exact fixture pair and unconditional within it. | Stop; restore the package-script single source and structural auth proof. |
| `D-0012-16` | The config adds the fixture/proof for a one-sided fixture request/nonexact fixture pair, or fails to force `workers: 1` in fixture mode. | Stop before browser; only the package-owned exact pair may enter W0. |
| `D-0012-17` | Either webServer omits `stdout: "pipe"` or `gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }`, or the bounded fixture `w0-login-fixture ready seed=dashboard-cutover-0010`/`w0-login-fixture shutdown signal=SIGTERM` lines are missing, duplicated, or contain request data. | Stop and repair lifecycle/output handling; no W0 claim is valid. |

### 5.2 Falsifiers

Any one of the following falsifies the capsule, even if a login page renders:

- The inherited red preflight failure, port/host mismatch, or outside-cwd script error cannot be reproduced or is silently omitted from the evidence record.
- The final package script does not invoke the literal `node ./node_modules/@playwright/test/cli.js` from the dashboard cwd, still uses `exec`, a raw `playwright` binary, a root-relative CLI path, Bun to load the Playwright config, a temporary CLI, or a Node runtime below `22`.
- The frozen-install preflight does not prove `apps/dashboard/node_modules/@playwright/test/cli.js` exists, resolves to the root `node_modules/.bun/@playwright+test@1.58.2/node_modules/@playwright/test/cli.js` store path, and starts under direct `NODE_22_BIN` from the dashboard cwd.
- `login-api.mjs` does not use plain Node 22, validate all five exact envs before listening, bind only `127.0.0.1:8788`, enforce the exact `8192`-byte body limit and route/schema contract, return deterministic `401`, expose `/health`, `/reset`, and `/events`, record only the exact sanitized event, reject malformed/other input, emit exactly one bounded `w0-login-fixture ready seed=dashboard-cutover-0010` line and one `w0-login-fixture shutdown signal=SIGTERM` line, or close cleanly within `5_000` ms with stdout piped.
- `baseURL`, app `webServer.url`, and the app bind are not all exactly `http://127.0.0.1:5174`; the config adds fixture/proof for a mode pair other than both exact `fixture`; fixture mode does not add the fixture first and app second or force `workers: 1`; fixture health is not exactly `http://127.0.0.1:8788/health`; either server lacks `timeout: 120_000`, literal `reuseExistingServer: false`, `stdout: "pipe"`, or graceful SIGTERM shutdown with a `5_000` ms timeout; or any configured Chromium, Firefox, or WebKit project has an effective viewport other than `1440x900`.
- A workstation-specific Chromium path is committed, the managed browser is absent without the mandatory `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, or the config unconditionally sets `executablePath`.
- The named `apps/dashboard/e2e/auth.spec.ts` file is not tested under project `chromium` twice, or either exact-fixture pass lacks browser launch, Playwright control, the unchanged visible error assertion, the viewport assertion, the unconditional pre-navigation reset, or the unconditional post-error exact event assertion.
- The canonical W0 package script does not own `e2e/auth.spec.ts -g "shows error on invalid credentials"`, `--project=chromium`, and `--retries=0`, or the README/shell command repeats those arguments instead of invoking only `test:e2e:w0`.
- The skipped callback still declares `_page`, the `request` fixture is unknown, or the auth source changes route, labels, credentials, login action, visible assertion, or product semantics.
- SDK dist is absent before W0, the SDK build uses the wrong command order, generated dist is committed, or SDK source changes.
- Any non-loopback traffic, real credential/PII, production/remote/provider request, visual artifact, or provider command is used.
- README freezes anything other than the standalone CI/unshare/dual-PATH invocation of `test:e2e:w0`, with its package-owned five fixture envs, auto-started tracked fixture, exact event proof, bounded `w0-login-fixture ready seed=dashboard-cutover-0010`/`w0-login-fixture shutdown signal=SIGTERM` provenance, validated runtime inputs, and no unobserved browser-install command.
- Any path outside the five-file capsule changes, any lock/dependency mutates, a disposable fixture/wrapper/log remains, or the final tree is not clean before accepted0010 S5 resumes.
- Observed implementation `36cadc3` or its generic visible-error/disposable-fixture result is presented as satisfying the revised acceptance, contrary to `agent://DashboardPlaywrightW0CodeReview`; it cannot substitute for the tracked five-file double pass and exact in-test event proof.

## 6. Lifecycle and definition of done

### 6.1 Lifecycle gates

| Gate | State in this accepted revision | Meaning |
|---|---|---|
| `Draft` | **Complete / not current** | The draft contract, inherited red evidence, revision boundary, deterministic fixture contract, journey, Drift rules, and falsifiers are complete. |
| `Specified` | **Complete** | Independent final review PASS and product/operator acceptance confirmed the exact contract. |
| `Ready` | **Complete / not current** | The capsule was ready before implementation and is now consumed. |
| `Building` | **Complete / historical** | `fd6ee4c`/`2d3ca0b` implemented the five-path capsule; earlier `36cadc3` remains nonconforming historical evidence. |
| `Experienceable` | Not applicable to W0 | W0 has no frontend visual/product evidence requirement; browser reachability is harness evidence only. |
| `Conforming` | **Current** | Final code PASS and runtime PASS confirm the tracked-file double pass, exact event proof, cleanup, scope, and no external effects. |
| `Release-ready` / `Operating` | Out of scope | No deployment, publication, provider, production, or operating state is authorized. |

The capsule is consumed and frozen. Final evidence is recorded above and below; accepted0010 S5 is authorized to resume.

### 6.2 Definition of done

The consumed capsule is complete because every item below is evidenced:

1. Final revision review PASS and product/operator acceptance preceded implementation; final code/runtime PASS URIs, one owner, one PR, and the accepted0010 S5 boundary are recorded. The capsule is consumed and frozen.
2. The implementation diff contains only the five paths in §3.1. No lock, dependency, SDK source, generated dist, provider, backend, root hook, or unrelated dashboard path changes.
3. The dashboard package keeps the literal app-local `node ./node_modules/@playwright/test/cli.js` path from the dashboard cwd, requires Node `>=22`, and gives `test:e2e:w0` sole ownership of all five fixture env assignments, the tracked selector, `--project=chromium`, and `--retries=0`; general scripts remain usable, while the named auth test skips when `!fixtureMode` and uses unconditional reset/event assertions in the exact pair; no stale `exec`/raw-Bun Playwright ambiguity remains.
4. The frozen install preflight proves the exact app-local CLI file exists, resolves to the root `node_modules/.bun/@playwright+test@1.58.2/` store, and starts under direct Node; the config enters fixture mode only when both mode variables exactly equal `fixture`, leaves one-sided/nonexact pairs app-only with the named test skipped outside the W0 gate, keeps app-only general scripts usable otherwise, replaces the existing `workers` setting with `workers: 1` in fixture mode, adds the fixture first and app second, and gives both servers exact loopback binds/URLs, `timeout: 120_000`, literal `reuseExistingServer: false`, `stdout: "pipe"`, and graceful SIGTERM shutdown within `5_000` ms; every configured Chromium/Firefox/WebKit project re-applies `1440x900` after its device spread.
5. The Chromium project accepts an optional runtime `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, mandatory when the managed browser is absent, and otherwise uses the installed Playwright browser; no workstation-specific path is committed.
6. The tracked `login-api.mjs` is plain Node 22, validates all five exact envs before listening only on `127.0.0.1:8788`, serves exact `/health`, `/reset`, `/api/login`, and `/events` behavior, emits exactly one bounded `w0-login-fixture ready seed=dashboard-cutover-0010` line as provenance, enforces the exact `8192`-byte input limit/rejection, records only the sanitized event, returns deterministic `401`, emits exactly one `w0-login-fixture shutdown signal=SIGTERM` line, and closes within the `5_000` ms graceful-shutdown window.
7. The named auth test collects without unknown fixtures, has `test.skip(!fixtureMode, 'requires the exact W0 fixture mode pair')` as the first statement inside its callback, preserves all other auth tests in non-fixture runs, unconditionally resets the tracked fixture before navigation and polls/asserts the exact sanitized event after the generic visible error in the exact pair, keeps the effective `page.viewportSize()` assertion, preserves product login semantics, and the skipped logout callback has no `_page`.
8. Exact validated Bun `1.3.10` frozen install and the corrected SDK command `"$BUN_1_3_10_BIN" run --cwd packages/sdk build` succeed; all four generated SDK dist exports exist before W0 and are removed from the final index. The historical argument-order proof remains `bunx --bun bun@1.3.10 run --cwd packages/sdk build`.
9. The exact standalone unshare package invocation runs `test:e2e:w0` twice with `CI=1` and the dual validated-runtime `PATH`; that package script owns the tracked named test, `--project=chromium`, and `--retries=0`; each exact-pair pass starts the tracked fixture first, reaches browser launch/Playwright control, passes effective `1440x900`, visible error, exact event assertions, uniquely prefixed fixture ready/shutdown provenance, exits `0`, shows one passed selected test and zero failed/skipped/flaky/retried results, and records sanitized duration/evidence.
10. The fixture uses all five exact loopback/fixture envs under external network denial, records no PII beyond synthetic `invalid@test.com`, and no provider, remote, real credential, or non-loopback request occurs.
11. README is standalone and freezes only the CI/unshare/dual-PATH invocation of `test:e2e:w0`, its package-owned fixture behavior, expected event proof, uniquely prefixed fixture ready/shutdown provenance, validated runtime prerequisites, and commented optional browser executable input after both passes; no duplicated raw CLI/selector/env/retry arguments, temporary fixture/log/wrapper, or unobserved browser-install command remains.
12. Temporary configs/specs, reports, traces, screenshots, logs, processes, listeners, caches, `node_modules`, and ignored dist are cleaned after retaining the two sanitized event proofs and uniquely prefixed fixture lifecycle lines; tracked fixture source remains but no fixture runtime does; the five-path implementation tree is clean.
13. Items 1–12 are complete and accepted0010 S5 is authorized to resume. No W0 statement is promoted to frontend visual, product, backend, provider, deployment, or production evidence.

## 7. Review and acceptance markers

This accepted revision has final independent PASS review. The final review authorities are `agent://DashboardW0FixtureSpecReview` and `agent://DashboardW0FixtureFeasibility`; implementation code PASS is `agent://DashboardW0FinalCodeReview`, and runtime PASS is `agent://DashboardW0FinalRuntimeVerifier` against `2d3ca0b`.

- the inherited red evidence and `36cadc3` false-green finding are separated from the temporary-copy diagnosis;
- the corrected app-local Node CLI path and app-cwd contract cannot regress to Bun config transform or `Script not found "dev"`;
- the frozen-install preflight proves the exact app-local CLI file, workspace-store realpath, direct Node invocation, and validated dual PATH before W0;
- the fixture mode condition leaves one-sided fixture requests/nonexact fixture pairs outside the W0 gate with the named test skipped, replaces the existing `workers` setting with `workers: 1`, starts fixture first/app second, validates all five package-owned startup envs, and carries loopback binds, bounded routes, sanitization, uniquely prefixed fixture stdout ready/shutdown provenance, and graceful SIGTERM cleanup into source, command, and evidence;
- the exact loopback host/port, two server timeouts/reuse flags, stdout pipe/graceful-shutdown contract, named `page.viewportSize()` assertion, effective `1440x900` viewport across Chromium/Firefox/WebKit, and zero-retry output are carried into source, command, and evidence;
- the auth `request` reset/event proof is structural: the named test skips outside exact fixture mode, then unconditionally resets before navigation and asserts the exact event after the generic visible error on both W0 passes;
- the optional Chromium path is portable and absent from the committed diff, and is mandatory when the managed browser is absent;
- the five-file boundary is sufficient and contains no lock/dependency or SDK-source change;
- the tracked-file double pass, exact event proof, cleanup, and freeze are complete; accepted0010 S5 is authorized to resume; and
- the no-visual/no-provider/no-product-evidence boundary is preserved.

Recorded revision markers:

| `REVIEW-0012` | Final PASS — `agent://DashboardW0FixtureSpecReview`; `agent://DashboardW0FixtureFeasibility`; implementation code PASS — `agent://DashboardW0FinalCodeReview`; runtime PASS — `agent://DashboardW0FinalRuntimeVerifier` |
| `OPERATOR-0012` | Accepted `2026-08-10` — product lead/operator acceptance for reviewed spec commit `c2babbe` |
| `CAPSULE-0012` | Consumed and frozen by implementation `fd6ee4c` + `2d3ca0b`; lifecycle `Conforming/current` |
| `FREEZE-0012` | Complete — exact tracked double pass, event proof, cleanup, and clean implementation worktree recorded |

This accepted revision is Conforming/current. The implementation is complete, the capsule is consumed/frozen, and accepted0010 S5 is authorized to resume. W0 remains harness-only evidence and does not establish frontend visual, product, backend, provider, deployment, or production behavior.
