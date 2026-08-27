# Design spec 0065 - native Identity browser evidence

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0065` |
| Status | **Implemented — disposable evidence capsule passed**. This commit adds no runner, source code, test, dependency, route, or CI change |
| Base / source observation | `34b4792c4c8cc4ec57be230a31310a2071eddb9d` (`34b4792`) from `/tmp/mono-web-final-integration`; preserved as the original source observation and amendment lineage |
| Evidence implementation | Present at integrated commit `0ac645ef44f9cc52a3f588f0dc6e6f7b5ee61194` (`0ac645e`) |
| Parent contract | [`0054-native-identity-better-auth.md`](./0054-native-identity-better-auth.md) |
| Goal | Produce one objective real-Chromium and real-PostgreSQL receipt for the implemented native Better Auth login and session journey |
| Journey count | One browser journey, with session revocation, old-cookie replay, rate-limit, database, ledger, and accessibility observations inside the same disposable run |
| Browser routes | `/login` and `/dashboard` |
| Native routes | `/api/auth/sign-in/email`, `/api/me/session`, and `/api/auth/sign-out` |
| Owner | Identity feature lead. An independent verifier owns the final evidence disposition |
| Evidence destination | Sanitized one-to-one implementation handoff or PR evidence section. An ordinary run does not create a repository evidence file |
| Operator boundary | Disposable loopback PostgreSQL, native backend, native dashboard, Chromium, and recording boundary only. No production, remote, Symfony, provider, deployment, publication, notification, or credential effect |

This document freezes the missing browser-evidence contract for spec 0054. It does not replace or narrow any semantic clause in spec 0054. If this document and spec 0054 disagree, stop and enter `Drift`. Do not change either document to make the run pass.

The source implementation exists at the original base revision, where runtime evidence was missing. This source fact is not browser or PostgreSQL evidence. The 0065 evidence implementation is now present at integrated commit `0ac645e`; the disposable real PostgreSQL and Chromium capsule passed there, as recorded below.

## Observed evidence capsule

At integrated commit `0ac645e`, `bun run --cwd apps/dashboard e2e:real-identity` passed one Chromium test against disposable real PostgreSQL. The observed evidence included exactly `3x401 + 7x429` native statuses, session projection and reload, logout, old-cookie replay returning `401`, database revocation and live-session proof, the request ledger, axe `0`, and cleanup with closed ports. Hosted CI was not run; no production or remote evidence is claimed.

## Observed topology defect

`apps/dashboard/playwright.config.ts` defines `realNativeIdentityMode`, but the mode is absent from `externalTopologyMode`. The mode is also absent from the first branch of the `use.baseURL` selection.

When `REAL_NATIVE_IDENTITY_E2E=1`, the current configuration therefore has these observed results:

- `externalTopologyMode` is false unless another mode is also enabled.
- `use.baseURL` selects `http://127.0.0.1:5174` instead of `DASHBOARD_ORIGIN`.
- `webServer` starts the local dashboard server.
- The CI job supplies `API_URL` and `DASHBOARD_ORIGIN`, but Playwright ignores the supplied dashboard origin and runs against a newly started local dashboard.

This is a mixed-topology gate. It can combine a local dashboard with a supplied backend while the gate claims to exercise the supplied native dashboard. It does not prove the external native dashboard boundary.

The future implementation must correct this source defect before it records evidence. For `REAL_NATIVE_IDENTITY_E2E=1`, it must set Playwright `baseURL` to `DASHBOARD_ORIGIN`, set `webServer` to `undefined`, and use `API_URL` only as the native dashboard's server-side backend URL. Playwright and the evidence runner must not use `API_URL` as their own base URL or direct API client target.

The CI identity browser gate must pass origins for the same disposable run. It must not point at a persistent, production, staging, or remote service. The gate must fail closed when the required origins are absent or non-loopback.

This spec authorizes no change to the existing configuration or workflow. It freezes the source correction and evidence requirements for a later implementation commit.

## Dependencies and evidence authorities

The future evidence writer starts from the exact base in Metadata and reads these authorities before implementation:

- Spec 0054 freezes Better Auth ownership, the `Identity` Service, the `auth` schema, the `PersonId` linkage, session policy, login surface, dashboard session gate, exclusions, and identity falsifiers.
- Specs 0040 and 0045 freeze capability ownership and Effect Service/Layer boundaries. They do not authorize a second identity authority.
- Spec 0064 supplies the current sanitized receipt, loopback PostgreSQL, real-session Chromium, request-ledger, cleanup, and accessibility conventions.
- `apps/dashboard/playwright.config.ts` is the Playwright topology authority.
- `.github/workflows/ci.yml` is the identity-browser-gate authority. Its current gate is the observed mixed-topology defect described above.
- `apps/dashboard/e2e/native-session-journey.spec.ts` is the existing browser journey source. Its selectors and synthetic journey persona are evidence inputs, not new product constants.
- `apps/dashboard/e2e/auth.spec.ts` is the existing login and accessibility source. The password-reset assertions in that file are not part of this journey.
- `packages/database/src/identity-seed-main.ts` is the native identity seed authority. It applies migrations through `DatabaseLive`, restricts the database URL to loopback PostgreSQL, creates `person_profiles` before `auth.user`, and sets `auth.user.id` to the caller-supplied `PersonId`.
- `packages/database/src/identity-postgres-proof-main.ts` is the PostgreSQL session proof authority. It records migration `15`, the dedicated `auth` tables, the `PersonId` foreign key, cookie attributes, persisted live sessions, sign-out deletion, and independent old-cookie replay failure.
- `packages/database/src/auth-engine.ts` freezes Better Auth `^1.7.1`, email-password minimum length `12`, seven-day sessions, one-day update age, the five-minute cookie cache, and the `auth` search path.
- `apps/backend/src/router.ts` is the backend route authority. It mounts Better Auth at `/api/auth/*` and exposes strict `GET /api/me/session` projection.
- `apps/backend/src/auth-live.ts` and `packages/database/src/auth-live.ts` are the composition authorities. Production identity resolution uses the `Identity` Service and one Better Auth engine. It does not use fixture tokens or environment token maps.
- `apps/dashboard/app/lib/auth.server.ts` is the dashboard session authority. `requireAuth` calls the SDK session projection, forwards native sign-in and sign-out cookies, maps `401` to an expired-session path, and maps `429` to the existing rate-limit message.
- `apps/dashboard/app/routes/login.tsx` owns the rendered native form and the exact existing messages. The runner must use the form and must not call the Better Auth API itself.
- `packages/database/migrations/0015-native-identity-better-auth.sql` and `packages/database/src/migrations.ts` are the schema and ordered migration authorities.
- `apps/dashboard/package.json`, `apps/backend/package.json`, and `packages/database/package.json` define the existing build, start, browser, seed, and proof entrypoints. The root requires Node `>=22` and Bun `1.3.10`. The evidence records the actual Node, Bun, PostgreSQL, Chromium, and Better Auth versions.

This slice does not add a dependency, alter the lockfile, change a route, add a compatibility endpoint, add a new authentication mode, or change a receipt schema.

## Frozen scope and exclusions

This evidence slice proves only the already implemented native Identity journey:

1. The browser opens the native dashboard login page.
2. The browser submits the seeded synthetic account through the rendered form.
3. Better Auth issues one native session cookie.
4. The dashboard uses the session to read the direct session projection.
5. The dashboard survives a reload.
6. The browser signs out through the rendered user menu.
7. The old cookie fails after sign-out, and PostgreSQL reports zero live sessions.
8. Ten wrong-password submissions reach the native Better Auth endpoint and produce the declared invalid-credential and rate-limit outcomes.
9. The login page passes the named accessibility checks.

The slice explicitly excludes:

- password reset, reset email, reset tokens, or `/glemt-passord` navigation.
- JWT or token-map retirement, migration, or production authorization claims.
- social login, SSO, 2FA, passkeys, providers, or external notification.
- production, staging, remote, public, or deployed services.
- production data and credentials of any kind.
- credential acquisition, credential rotation, credential persistence, or credential publication.
- a Symfony process, Symfony route, fixture login server, mock transport, or legacy login path.
- Profile, Organization, authorization-role, or unrelated dashboard behavior beyond the minimum seed needed to render the authenticated dashboard shell.
- a new product contract or a source change disguised as evidence.

Synthetic disposable login input is required to exercise the form. The input is passed at the process boundary, never committed, and never included in the spec, command line, logs, screenshots, traces, ledger, or sanitized receipt. A credential value is not evidence.

## Topology contract

### External Playwright mode

The identity gate sets `REAL_NATIVE_IDENTITY_E2E=1`, `DASHBOARD_ORIGIN`, and `API_URL`. The corrected Playwright configuration must satisfy all of these conditions:

- `use.baseURL` equals `DASHBOARD_ORIGIN` exactly.
- `webServer` is `undefined`.
- Playwright does not start, reuse, or contact a local dashboard server.
- The dashboard process receives `API_URL` and uses it for its server-side SDK calls.
- The runner does not construct a client from `API_URL`.
- The browser opens only `DASHBOARD_ORIGIN`.
- The dashboard's `API_URL` target is the native backend or a loopback recording boundary that forwards only to the native backend.
- `DASHBOARD_ORIGIN`, the backend origin, the PostgreSQL host, and the recording boundary resolve to loopback addresses.
- The gate uses one Chromium project and one worker. Retries are disabled for the evidence run.

The corrected configuration must include native identity mode in the same external-topology decision that disables `webServer`. It must not add a second special case that can select a local server.

### Disposable resources

The future writer creates one fresh PostgreSQL cluster and one database on loopback. The writer starts one native backend and one native dashboard for that database. The dashboard can use a loopback recording boundary for `API_URL`, but that boundary must forward only to the native backend and must record no secret or private body.

The future writer records the exact process commands, origins, ports, process identifiers, and resource ownership. It does not use a repository variable that points to a persistent or remote service. The browser and all runtime processes use the exact source revision in Metadata.

The backend starts with loopback `BACKEND_HOST`, a disposable `BACKEND_PORT`, `BACKEND_PG_URL`, a process-scoped `BETTER_AUTH_SECRET`, the dashboard origin as `BETTER_AUTH_URL`, and `PUBLIC_APPLICATION_EFFECT_MODE=disabled`. The secret and database URL credentials never enter evidence. The dashboard starts from the committed production build with `API_URL` set to the loopback native backend or recording boundary and no Symfony URL.

Before the browser starts, the writer proves that all selected ports are closed. After cleanup, the writer proves that all selected ports refuse a connection and that no owned process remains.

## Deterministic seed

The writer applies the repository migration runner through `DatabaseLive` before the seed. The observed database revision must be exactly `15`, and the migration record must name `native-identity-better-auth`. PostgreSQL must contain the four Better Auth tables `auth.account`, `auth.session`, `auth.user`, and `auth.verification`. It must contain no copy of those tables in `public`.

The seed uses `packages/database` `identity:seed` or the same checked-in seed path. It must be deterministic and idempotent for this fresh database. It creates rows in dependency order:

1. one `public.person_profiles` row.
2. one `auth.user` row whose `id` is exactly that `person_id`.
3. one credential account linked to that same user.
4. the minimum active Organization authority needed for the dashboard shell to project the seeded actor.
5. any contact row required by the existing `/api/me` shell read.

Use one deterministic synthetic admin persona with these non-secret facts:

| Fact | Required value |
|---|---|
| `personId` | `journey-0065-admin` |
| `firstName` | `Journey` |
| `lastName` | `Identity` |
| `email` | `admin.identity-0065@example.invalid` |
| Organization state | one active global administrator grant, or the existing equivalent active authority projection |

The seed password is a process-bound synthetic input that satisfies the existing minimum length. The password value is not written in this document or any evidence artifact. The seed must record only the persona identifier, email classification (`synthetic.invalid`), migration revision, row counts, and the fact that the account was created or skipped.

The seed must assert that `auth.user.id = public.person_profiles.person_id`. It must assert that the seeded user resolves to the expected `PersonId` through the native `Identity` Service. It must not insert a role into the `auth` schema or let the browser supply a role.

## One bounded browser journey

Run one fresh stack and one Chromium project. Do not run a fixture transport, a mock response, or a second browser. Keep the old cookie only in process memory. Do not print or persist its value.

### Login and session projection

1. Open `DASHBOARD_ORIGIN/login` through Playwright `baseURL`.
2. Run the login accessibility check at the initial state.
3. Fill the visible `E-post` and `Passord` controls with the process-bound synthetic seed input.
4. Submit the visible `Logg inn` button.
5. Observe a redirect to `/dashboard`.
6. Observe one cookie named `better-auth.session_token` in the browser context.
7. Assert cookie attributes by name only: `httpOnly=true`, `sameSite=Lax`, `path=/`, and `secure=false` for the loopback HTTP run. Do not record or compare the cookie value.
8. Observe the authenticated dashboard shell and the seeded display name `Journey Identity`.
9. Observe the native `GET /api/me/session` response through the recording boundary. Its status is `200`, and its strict JSON projection contains exactly `personId` and `expiresAt`. `personId` equals `journey-0065-admin`. `expiresAt` is a valid future UTC timestamp. The projection contains no user name, email, role, token, cookie, or extra property.
10. Reload `/dashboard`.
11. Observe the same authenticated shell and the same strict session projection after reload.

The browser must not call `/api/login`, `/login_check`, `/sso/login`, a fixture login endpoint, a token exchange endpoint, or a legacy dashboard endpoint. The browser must not inject a cookie, bearer token, `PersonId`, or role.

### Sign-out and old-cookie replay

12. Copy the session cookie pair to an in-memory variable only. Do not write the pair to output, a file, a screenshot, a trace, a request header outside the controlled browser context, or the receipt.
13. Open the rendered user menu and select `Logg ut`.
14. Observe a redirect to `/login`.
15. Assert that the browser context has no cookie named `better-auth.session_token` after sign-out.
16. Query the disposable PostgreSQL observer and record `auth.session` live-session count `0` for `journey-0065-admin`. Record total rows and live rows without recording a session token.
17. Reinstall the old cookie in the browser context from the in-memory value. Do not use a direct API client.
18. Open `/dashboard` with the old cookie.
19. Observe the dashboard's direct `GET /api/me/session` projection request return HTTP `401` with the typed unauthenticated result. The dashboard redirects to `/login` and renders no authenticated shell.
20. Query PostgreSQL again and require live-session count `0`.

The old-cookie replay is valid only when the cookie value existed before sign-out, was retained only in memory, and was rejected by the live native backend after sign-out. A response caused only by local cookie deletion is not session revocation evidence.

### Ten wrong-password attempts

Wait for more than ten seconds after sign-out before starting this arc. Use a fresh browser context or the same context after the old-cookie replay, but use the same seeded email and a deterministic wrong password. Submit ten wrong-password attempts through the rendered login form in one ten-second rate-limit window. Do not call `/api/auth/sign-in/email` directly from the runner.

Better Auth `1.7.1` applies its special sign-in rule of three requests per ten seconds. The native backend observations must therefore be:

| Attempts | Native `/api/auth/sign-in/email` result |
|---|---|
| 1, 2, 3 | HTTP `401`, invalid credentials, no session cookie, no `auth.session` row |
| 4, 5, 6, 7, 8, 9, 10 | HTTP `429`, rate limited, no session cookie, no `auth.session` row |

The dashboard action response can be an HTML response because the dashboard owns the form action. The recording boundary must record the native backend statuses. After the first rate-limited response, the login page must show the exact existing message `For mange innloggingsforsøk. Prøv igjen om 15 minutter.` The ledger records any `X-Retry-After` value as a non-secret scalar when the backend sends it. The receipt records statuses and attempt ordinals, not passwords or response bodies.

If timing causes an attempt to leave the ten-second window, if a prior request affects the rule, or if the implementation returns a different status, enter `Drift`. Do not retry until the expected result appears. Do not lower the request count or change the Better Auth rule for evidence.

## HTTP, database, and ownership observations

The recording boundary must observe these native backend requests from the dashboard and no direct runner API requests:

| Request | Required observation |
|---|---|
| `POST /api/auth/sign-in/email` with the valid form submission | `200`, one native Better Auth session cookie by name, no cookie value in evidence |
| `GET /api/me/session` after login | `200`, strict `{ personId, expiresAt }` projection |
| `GET /api/me/session` after reload | `200`, same strict projection and person id |
| `POST /api/auth/sign-out` | `200`, native revocation response, no retained live session |
| `GET /api/me/session` with the old cookie | `401`, typed unauthenticated result |
| ten wrong-password sign-in requests | three `401` results followed by seven `429` results in one ten-second window |

The evidence writer decodes response bodies before sanitization. It records only the strict session projection, typed status tags, synthetic person identifier, attempt ordinals, timestamps with bounded precision, and safe headers needed to establish cookie attributes or rate-limit behavior.

The PostgreSQL observer proves all of these facts:

- migration revision `15` is applied by the repository migration runner.
- the Better Auth tables exist only in schema `auth`.
- `auth.user.id` references `public.person_profiles.person_id`.
- the seeded identity has the declared `PersonId`.
- one valid sign-in creates one live session.
- reload does not create a second session solely because the page reloads.
- sign-out removes or expires the session so that live-session count is zero.
- old-cookie replay does not restore or create a live session.
- all ten wrong-password attempts create no session row.
- the `Identity` Service is the only production actor-resolution boundary.
- no role, permission, or membership fact comes from the `auth` schema.

The database observer must use a distinct read connection and record connection application names and PostgreSQL backend pids. It must not infer revocation from browser cookie deletion or from a process log.

## Request ledger and accessibility boundary

The ledger records every request in both directions:

- `browser -> dashboard`, and
- `dashboard -> recording boundary -> native backend`.

Each entry contains direction, destination classification, method, path, status, and bounded duration. It contains no request body, response body, cookie value, password, authorization value, database URL, or secret.

The ledger must show the browser opening only the supplied `DASHBOARD_ORIGIN`. It must show the dashboard forwarding only to the loopback native backend or its loopback recording boundary. It must contain zero requests to:

- Symfony, including `/login_check`, `/login`, `/sso/login`, or any Symfony host.
- fixture servers, fixture login paths, `/api/login`, or `/mock/api`.
- JWT, bearer-token, token-map, or legacy authentication paths.
- password reset or verification routes.
- any non-loopback host, remote database, provider, public route, or external API.

The ledger must identify the expected native paths and no extra native API path. Static dashboard assets can appear when they use the supplied dashboard origin. A request to an unexpected host or path is a falsifier even when the page renders the expected text.

Run axe-core against Chromium at these login states:

1. initial login form.
2. invalid-credential feedback.
3. rate-limit feedback.

The accessibility result must report zero serious and critical violations. Record these direct observations:

- one visible `h1` names `Vektorprogrammet`.
- `E-post` and `Passord` each have one visible associated label and a stable unique id.
- the `Logg inn` control is keyboard reachable and operable.
- invalid-credential and rate-limit messages are reachable and visible.
- the password visibility control has an accessible name.
- keyboard-only navigation can reach the email input, password input, visibility control, submit button, and password-reset link without opening the password-reset route.

Accessibility evidence does not authorize a visual redesign. A violation enters `Drift`.

## Exact falsifiers

Any one of these observations falsifies this evidence slice or opens `Drift`, even when another check passes:

- The evidence base, source revision, or browser configuration is not the exact revision in Metadata.
- `REAL_NATIVE_IDENTITY_E2E=1` selects a local Playwright server, a generic `127.0.0.1:5174` base URL, or any base URL other than `DASHBOARD_ORIGIN`.
- Playwright starts or reuses `webServer` in external native identity mode.
- The runner uses `API_URL` as its base URL, direct API client target, or direct session probe.
- The CI gate supplies a persistent, remote, staging, production, or non-loopback dashboard or backend.
- The browser does not use the supplied native dashboard origin.
- The login uses a fixture, mock, bearer token, injected cookie, direct Better Auth request, or pre-authenticated browser state.
- The login does not use the rendered native form and the real Better Auth handler.
- A session cookie has a name other than `better-auth.session_token`, or the evidence records a cookie value.
- Cookie attributes do not match the native policy: `httpOnly`, `SameSite=Lax`, loopback `secure=false`, and `/` path.
- The valid sign-in does not create one native live session, or a reload creates an unexplained additional session.
- `GET /api/me/session` is absent, is not a native backend request, returns a non-strict projection, returns a role or profile field, or resolves to a different person.
- The dashboard renders authenticated content without a successful native session projection.
- Sign-out does not reach `/api/auth/sign-out`, does not revoke the live session, or leaves a live session count greater than zero.
- The old cookie was not retained before sign-out, was persisted outside memory, or is replayed through a direct API client.
- Old-cookie replay returns `200`, creates a new session, renders authenticated content, or returns a non-`401` result.
- PostgreSQL reports a live session after sign-out or old-cookie replay.
- The wrong-password arc has fewer or more than ten attempts, uses a password other than the deterministic wrong input, or leaves the ten-second rate-limit window.
- Attempts 1–3 do not return native HTTP `401`, or attempts 4–10 do not return native HTTP `429` under the Better Auth `1.7.1` three-per-ten-second sign-in rule.
- Any wrong-password request issues a session cookie or creates a live session.
- The page does not display the exact existing rate-limit message after the first `429`.
- A request reaches Symfony, a fixture, `/mock/api`, `/api/login`, a JWT or token-map path, a password-reset path, a legacy path, an external provider, or a non-loopback host.
- The ledger omits a request, records a direct runner API request, or contains an unsanitized header, body, password, cookie, authorization value, URL credential, or secret.
- The backend resolves the actor through an environment token map, a fixture token, a JWT, a role from `auth`, or any source other than the native `Identity` Service.
- `auth.user.id` is not the canonical `PersonId`, the foreign key is absent, the auth tables appear in `public`, or the schema revision is not `15`.
- The run uses PGlite, a mocked SQL function, a stubbed transport, a fake browser, or process logs as PostgreSQL or Chromium evidence.
- The accessibility check reports a serious or critical violation, a login control lacks its visible label, or keyboard-only submission cannot reach the required controls.
- The run follows or claims password-reset behavior, JWT/token-map retirement, production migration, remote deployment, provider integration, or any excluded behavior.
- The PostgreSQL cluster, backend, dashboard, recording boundary, port, process, cookie, trace, screenshot, raw log, password, secret, or temporary state remains after cleanup.
- The receipt contains a credential, session token, cookie value, database URL credential, real personal data, or unsanitized payload.
- A failed or partial run is rewritten as a passing receipt, or a source mismatch is hidden by a retry, skip, filter, or changed fixture.

## Operator and data boundary

The writer has no authority to access production, staging, remote PostgreSQL, a provider, or an external API. Use only fresh loopback resources and synthetic `.invalid` identity data. Do not read, copy, or load repository `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` files. Pass process-bound values explicitly.

Do not run Symfony. Do not contact Symfony, Cloudflare, a provider, a public route, an external API, a remote database, or a notification service. Do not publish a PR, deploy, migrate remote data, remove a remote resource, or acquire credentials.

If any command requests non-loopback access, a credential prompt, a production row, a remote database, a provider, an external notification, a deployment, or publication, stop the run. Retain only a sanitized failure record and enter `Drift`. Operator authorization cannot be inferred from this document.

The writer removes the disposable PostgreSQL cluster, generated auth rows, temporary processes, ports, recording state, cookies, screenshots, traces, and raw logs in a `finally` path. The writer proves closed ports and no owned processes. Evidence retains no password, session token, cookie value, secret, database URL credential, or real personal data.

## Sanitized receipt and evidence

The receipt must contain only sanitized machine-readable facts and the exact source and command lineage. It must include:

- spec ID `0065`, parent spec `0054`, base commit, exact worktree, detached or branch state, and final implementation revision.
- Node, Bun, PostgreSQL, Chromium, Better Auth, Playwright, and operating-system versions.
- exact commands, mode variables by name and classification, selected loopback origins, and port ownership without secrets.
- the Playwright topology result: `baseURL=DASHBOARD_ORIGIN` and `webServer=undefined`.
- migration revision `15`, Better Auth table names, `auth` search path, and foreign-key result.
- deterministic seed identifiers, synthetic email classification, person projection, authority classification, and row counts without a password.
- valid login status, redirect, cookie name and safe attributes, direct strict session projection, reload result, and shell observation.
- sign-out status, in-memory old-cookie replay result, direct `GET /api/me/session` `401`, and PostgreSQL total/live session counts.
- all ten wrong-password attempt ordinals and native statuses, the rate-limit threshold and window, the safe UI message classification, and any safe `X-Retry-After` scalar.
- the complete two-direction request ledger with method, path, status, destination classification, and bounded duration.
- axe result, heading, labels, keyboard, and message observations.
- cleanup result, closed-port checks, process exit status, and residual-resource result.
- every failure or `Drift` record. A failed run is not rewritten as a passing receipt.

The ordinary evidence command emits sanitized stdout and local temporary artifacts only. If a runtime-evidence receipt path is requested later, use the established schema and evidence directory. This spec does not add a receipt file or invent a second evidence format.

## Definition of done

This evidence slice is done only when all conditions are observed and recorded:

1. This frozen spec is committed before any 0065 configuration correction, gate correction, evidence runner, or test implementation.
2. The implementation starts from exact base `34b4792c4c8cc4ec57be230a31310a2071eddb9d` and preserves the 0054 ownership and route contract.
3. `REAL_NATIVE_IDENTITY_E2E` uses `DASHBOARD_ORIGIN` as Playwright `baseURL` and disables local `webServer`.
4. `API_URL` is used only by the native dashboard's server-side API client. The Playwright runner has no direct API_URL client or direct backend probe.
5. The CI identity-browser-gate uses one disposable loopback PostgreSQL/native backend/native dashboard topology and rejects missing or non-loopback origins.
6. PostgreSQL migration revision `15` applies through `DatabaseLive`, and the Better Auth tables and `PersonId` foreign key exist in the dedicated `auth` schema.
7. One deterministic synthetic admin signs in through the real native Better Auth form in real Chromium without bearer-token or cookie injection.
8. The browser observes cookie attributes by name only, observes the strict direct `/api/me/session` projection, and retains the session across reload.
9. Sign-out revokes the session. In-memory old-cookie replay reaches the live native backend, returns HTTP `401` from `/api/me/session`, redirects to login, renders no authenticated content, and leaves PostgreSQL live-session count at zero.
10. Ten wrong-password attempts occur in one ten-second window. Native attempts 1–3 return `401`, attempts 4–10 return `429`, no session is created, and the exact existing rate-limit message appears.
11. The request ledger contains all browser and dashboard-to-backend requests with no Symfony, fixture, legacy, token-map, password-reset, external, or non-loopback request.
12. Login accessibility passes axe at the named states and the direct keyboard, label, heading, control, and message observations.
13. The receipt is exact, sanitized, independently reviewable, and contains no credentials, session tokens, cookie values, database URL credentials, or real personal data.
14. Cleanup removes all disposable resources, closes all ports, exits all owned processes, and retains no raw evidence.
15. No existing source, config, workflow, runner, code, test, lockfile, route, product contract, or repository evidence file changes in this frozen-spec commit.

## Lifecycle and handoff

- **Specified:** satisfied by this frozen evidence contract at `design-specs/0065-native-identity-browser-evidence.md`.
- **Ready:** requires independent review of this document, the observed topology defect, the 0054 implementation, and the future implementation capsule anchored to the exact base.
- **Building:** limited to one isolated implementation worktree. The future writer can correct Playwright topology and the CI gate, then add the one evidence runner and its required tests without changing 0054 semantics.
- **Experienceable:** entered only after the complete disposable PostgreSQL and Chromium receipt, request ledger, accessibility output, old-cookie replay, rate-limit output, and cleanup proof exist in the one-to-one handoff or PR.
- **Conforming:** entered only after a blind-first verifier receives this frozen spec, the corrected implementation, and sanitized objective evidence before author rationale, with no linked `Drift`.
- **Release-ready / Operating:** not entered. This slice has no production, remote, deployment, provider, publication, or credential authority.
- **Drift:** any falsifier, source mismatch, mixed topology, boundary breach, incomplete receipt, or disagreement with spec 0054 blocks the slice. The product lead routes intent disagreement to `Specified`. An implementation-only correction returns to `Building`.


## Amendment 0065.1 - corrected external native topology

This amendment records the observed correction present at implementation commit
`2bcc38a605c9c85dcc1be722dff361138c801827` (`2bcc38a`) in
`apps/dashboard/playwright.config.ts` and `.github/workflows/ci.yml`. It is a
documentation-only amendment. It does not replace, narrow, or weaken any
requirement, semantic clause, exclusion, falsifier, or operator boundary above.

The original `34b4792c4c8cc4ec57be230a31310a2071eddb9d` (`34b4792`) entry in
Metadata remains the preserved source observation: it is the revision at which
the mixed-topology defect was observed, and it remains part of the source
history. After that correction, the evidence implementation base is explicitly
frozen to the current commit `2bcc38a605c9c85dcc1be722dff361138c801827`
(`2bcc38a`). No evidence implementation may claim a base earlier than this
correction or silently substitute another revision.

### Observed Playwright correction

At the amended evidence base, `REAL_NATIVE_IDENTITY_E2E=1`:

- participates in `externalTopologyMode`;
- selects `DASHBOARD_ORIGIN` exactly as Playwright `use.baseURL`;
- sets `webServer` to `undefined`, so Playwright does not start or reuse a
  local dashboard server;
- uses one Chromium project and one worker; and
- disables retries (`retries=0`) for the identity evidence run.

`API_URL` remains the native dashboard's server-side backend target. It is not
the Playwright base URL and is not a direct API client or probe target for the
runner. The browser therefore remains bounded to the supplied
`DASHBOARD_ORIGIN`, subject to every existing topology and ledger requirement.

### Observed CI boundary correction

The amended CI identity-browser gate still supplies `API_URL` from the native
backend origin and `DASHBOARD_ORIGIN` from the native dashboard origin. Before
the Chromium journey, it fails closed when either required origin is absent and
validates each configured origin as an HTTP or HTTPS loopback origin without
credentials, a path, a query, or a fragment. It then checks the native backend
health path and dashboard login path before running the existing one-project
Chromium journey.

These observations establish the corrected external topology only. They do not
constitute the PostgreSQL, browser journey, request-ledger, accessibility,
revocation, rate-limit, cleanup, or sanitized-receipt evidence required by this
spec. All such semantic and evidentiary requirements remain unchanged and must
still be observed independently.

## Amendment 0065.2 - first Chromium accessibility observation

The first real Chromium run observed one serious `color-contrast` violation on
the existing login password-visibility button. The button uses `#99a1af` on
white. The measured contrast ratio is `2.6`, below the required `4.5` ratio.

This amendment authorizes only the smallest source-level color or style
correction for that existing button that makes the frozen login accessibility
requirement pass. The correction must preserve the button behavior, DOM
structure, accessible labels, authentication semantics, and every other
requirement in this spec and its parent contract. It must not redesign the
login page or change any other source, runner, configuration, workflow, CI,
route, dependency, test, or evidence contract.

After this correction, evidence implementation must begin from the resulting
amended current commit. The evidence implementation must not begin from
`cdf3343a6e67ab37304931b26d93037ca0133977` or an earlier commit. This amendment
does not itself authorize evidence implementation or any other source change.

## Amendment 0065.3 - first complete rate-limit accessibility observation

The first complete rate-limit run observed one serious `color-contrast` violation on the existing login error paragraph at `apps/dashboard/app/routes/login.tsx:65-68`. The paragraph uses `text-red-600` on `bg-red-50`. The measured contrast ratio is `4.36`, below the required `4.5` ratio.

This amendment authorizes only the smallest color or style correction for that existing error paragraph so that the frozen login accessibility requirement passes. For example, use a darker red text token. Preserve the paragraph DOM structure, text, semantics, authentication behavior, and every other requirement in this spec and its parent contract.

Do not redesign the login page or change any other source, runner, configuration, workflow, CI, route, dependency, test, or evidence contract. Evidence implementation must begin from the resulting amended commit.

## Amendment 0065.4 - integrated disposable evidence closeout

This documentation-only amendment records that the 0065 evidence implementation is
present and that the disposable real PostgreSQL and Chromium capsule passed at
integrated commit `0ac645ef44f9cc52a3f588f0dc6e6f7b5ee61194` (`0ac645e`).
The original `34b4792c4c8cc4ec57be230a31310a2071eddb9d` (`34b4792`) source
observation remains preserved in Metadata and in the amendment lineage above.

The observed command was
`bun run --cwd apps/dashboard e2e:real-identity` passed one Chromium test with
exactly `3x401 + 7x429` native statuses, session projection and reload, logout,
old-cookie replay `401`, database revocation and live-session proof, the request
ledger, axe `0`, and cleanup with closed ports.
Hosted CI was not run. This closeout claims no production or remote evidence.

This amendment preserves every semantic clause, falsifier, exclusion, and
operator boundary in this spec and does not authorize any source, runner,
configuration, workflow, CI, route, dependency, test, or production change.