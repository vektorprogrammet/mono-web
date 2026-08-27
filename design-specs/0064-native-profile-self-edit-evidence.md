# Design spec 0064 - native Profile self-edit evidence

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0064` |
| Status | **Evidence observed** — the runner is present at integrated commit `b44c038f752e2b27c452d30c192ecc345f070b45`; original source base `0e5f12424e8f31f9c62cd805cd9ea42a15a0ba51` remains provenance; Amendment 0064.1 remains the only source correction |
| Base | `0e5f12424e8f31f9c62cd805cd9ea42a15a0ba51` (`0e5f124`) from `/tmp/mono-web-final-integration` |
| Parent contract | [`0053-native-profile-self-edit.md`](./0053-native-profile-self-edit.md) |
| Goal | Produce one objective real-PostgreSQL and real-Chromium receipt for the already implemented Profile self-edit journey |
| Journey count | One member journey, with database concurrency and replay observations inside the same disposable run |
| Browser route | `/dashboard/profile/rediger` |
| Native HTTP routes | `GET /api/me`, `PUT /api/me` |
| Owner | Profile feature lead; an independent verifier owns the final evidence disposition |
| Evidence destination | Sanitized one-to-one implementation handoff or PR evidence section; an ordinary run does not create a repository evidence file |
| Operator boundary | Disposable loopback PostgreSQL, native backend, dashboard, and recording proxy only; no production, remote database, Symfony, provider, deployment, or external notification effect |

This document freezes the missing runtime-evidence contract. Except for the explicitly scoped source correction in Amendment 0064.1, it does not replace, amend, or narrow any semantic clause in spec 0053. If this document and spec 0053 disagree outside that amendment, stop and enter `Drift`; do not repair the disagreement by changing the implementation or this evidence contract.

The current source review finds the required path in place. The editor loader calls the strict SDK profile read, the Foldkit program owns edit state and commands, the bridge sends `PUT /profile`, the backend exposes `GET` and `PUT /api/me`, and the Profile PostgreSQL layer owns the two profile rows plus the command receipt. This source review is not runtime evidence.

## Amendment 0064.1 — observed bridge tag correction

The first strict 0064 evidence attempt reached the real native `409` stale
response, but the existing dashboard bridge rendered the generic network
failure message. The SDK's actual typed error has `_tag: "Conflict"`; the
bridge recognized lowercase `"conflict"` and specific native tags, but not
the SDK tag. This is an observed source mismatch, not a change to the 0053
contract.

This amendment narrows the allowed source correction to the existing
`apps/dashboard/app/foldkit/profile/bridge.ts` mapping only: recognize the
SDK's typed `_tag: "Conflict"` (and the existing stale-error tags) as the
existing typed stale-conflict UI failure, with `_tag: "Conflict"` and the
message `"Profilen er endret av en annen. Last siden på nytt for å se de
nyeste verdiene."`. No other bridge mapping, Profile behavior, HTTP/SDK
contract, UI structure, accessibility requirement, evidence assertion, or
0053 semantic clause may change.

## Amendment 0064.2 — observed local runtime gate

The integrated evidence runner is present at commit `b44c038f752e2b27c452d30c192ecc345f070b45`. Its original source base remains `0e5f12424e8f31f9c62cd805cd9ea42a15a0ba51`. Amendment 0064.1 remains the only source correction.

The observed local gate was:

```text
bun run --cwd apps/dashboard e2e:real-profile
```

One Chromium test passed against disposable PostgreSQL. The runtime receipt recorded the exact `baseCommit` `b44c038f752e2b27c452d30c192ecc345f070b45`, worktree, branch, Node, Bun, PostgreSQL, and Chromium versions. It recorded the real Better Auth login and Profile journey.

The receipt recorded all four field edits, the fresh read after save, and the reload observation. It recorded a typed stale `409`, two independent PostgreSQL contenders with one success and one stale result, final revisions `4` and `4`, one receipt, an identical replay, and a changed-payload conflict.

The receipt recorded strict ledger statuses with no forbidden paths. Axe reported zero violations in all four states. Cleanup removed the temporary PostgreSQL root and closed all ports.

Hosted CI did not run. This amendment claims no production or remote evidence.

## Dependencies and evidence authorities

The future evidence writer starts from the exact base in Metadata and reads these authorities before implementation of the evidence harness:

- Spec 0053 freezes the actor, four writable fields, command shape, revisions, replay laws, HTTP statuses, Foldkit ownership, browser route, and falsifiers.
- Spec 0054 supplies the native Better Auth login and session boundary. The browser signs in through the native login page and uses the resulting session cookie.
- Specs 0040 and 0045 supply capability ownership and Effect Service/Layer boundaries. They do not authorize a new Profile behavior.
- Spec 0055 supplies the person-keyed Organization authority projection from which the profile role is derived. The evidence seed must create an active member authority; it must not insert a writable role into the command.
- Spec 0061 and spec 0062 supply the current real-session Chromium, request-ledger, disposable PostgreSQL, cleanup, and sanitized-evidence conventions.
- The implementation paths are `apps/dashboard/app/routes/dashboard.profile.rediger._index.tsx`, `apps/dashboard/app/routes/__foldkit.profile.ts`, `apps/dashboard/app/foldkit/profile/**`, `apps/backend/src/profile/http.ts`, `apps/backend/src/router.ts`, `packages/sdk/src/domains/me.ts`, `packages/sdk/src/schemas/user.ts`, `packages/domain/src/profile/**`, and the ordered database migrations `0010`, `0011`, `0014`, and `0015`.
- `packages/database/src/layers.ts` and `packages/database/src/migrations.ts` are the PostgreSQL composition and migration authorities. The evidence must use the same `DatabaseLive` path as the backend.
- `apps/dashboard/package.json`, `apps/backend/package.json`, and `packages/database/package.json` define the existing build and runtime entrypoints. The repository root requires Node `>=22` and Bun `1.3.10`; record the actual versions used.

This slice does not add a dependency, change a lockfile, alter a route, add a compatibility endpoint, or modify an existing evidence receipt schema.

## Frozen semantic contract under evidence

The evidence must demonstrate the existing 0053 journey without adding product behavior:

1. An authenticated active member opens `/dashboard/profile/rediger`.
2. The loader authenticates the request and reads one strict `GET /api/me` observation.
3. The page displays the stored first name, last name, email, and phone.
4. The member edits all four writable fields.
5. The page validates all four fields and sends one strict update command.
6. Profile locks the member name row and contact row in one PostgreSQL transaction.
7. Profile rejects a stale revision or a conflicting command replay.
8. Profile updates both rows and records the command in the same transaction.
9. The page obtains a fresh `GET /api/me` observation after a successful write.
10. The page displays the committed values, and a reload displays those values again.
11. The evidence records no Symfony request and no fixture canary.

The command contains exactly `_tag`, `commandId`, `expectedNameRevision`, `expectedContactRevision`, `firstName`, `lastName`, `email`, and `phone`. The browser does not supply `personId` or `role`. The command cannot edit gender, field of study, account number, username, or profile photo.

The response contains exactly the strict `UserProfile` observation: `personId`, the four writable fields, `role`, `nameRevision`, and `contactRevision`. The role is a read-only projection from the authenticated actor. The profile authority persists no role.

## One bounded user journey

The future writer runs one disposable stack and one Chromium project with one worker. The writer records command output and sanitized observations. The writer does not run a fixture transport in place of the native stack.

### Seed

Create a fresh loopback PostgreSQL cluster and one database. Apply the repository migration runner through `DatabaseLive`. Record the migration revision and confirm that `person_profiles`, `person_contact_profiles`, and `profile_self_edit_commands` exist.

Seed one browser actor in dependency order:

1. A Better Auth user and credential account with a deterministic disposable password.
2. One `person_profiles` row for person id `profile-self-edit-e2e-0064`.
3. One `person_contact_profiles` row for that person.
4. The minimum active Organization membership records that make the actor an active team member. Derive `ROLE_TEAM_MEMBER` from the existing authority mapper; do not insert a role column or role command field.

Use synthetic `.invalid` email values and deterministic values that do not identify a real person. The seed must record the values in sanitized evidence, but it must not record the password, session token, cookie value, or database URL credentials.

Use these values for the primary browser observation:

| Observation | `firstName` | `lastName` | `email` | `phone` | Name revision | Contact revision |
|---|---|---|---|---|---:|---:|
| Seeded | `Ada` | `Profile` | `profile-before-0064@example.invalid` | `+47 9000 0001` | `0` | `0` |
| Browser commit | `Ada Updated` | `Profile Updated` | `profile-after-0064@example.invalid` | `+47 9000 0002` | `1` | `1` |

The fixture values are evidence inputs, not product constants. A different seeded value is a failed evidence run, not a reason to change the contract.

### Native stack

Start the native backend with `BACKEND_HOST=127.0.0.1`, a loopback-only `BACKEND_PORT`, the disposable `BACKEND_PG_URL`, the disposable `BETTER_AUTH_SECRET`, the dashboard loopback origin as `BETTER_AUTH_URL`, and disabled public application effects. Start the dashboard production server with `API_URL` and `VITE_API_URL` set to the recording proxy, not to Symfony.

The recording proxy forwards only to the loopback native backend. It records method, path, status, and bounded duration for every forwarded request. It must not log request bodies, cookies, passwords, or authorization values. The browser accesses only the loopback dashboard origin.

### Browser arc

Drive Chromium through the real login form:

1. Open `/login`.
2. Submit the seeded email and password through the form.
3. Observe the native Better Auth session cookie by name only. Do not copy its value into a request.
4. Open `/dashboard/profile/rediger`.
5. Observe heading `Rediger profil`, the four labelled inputs, and the seeded values.
6. Fill all four inputs with the Browser commit values.
7. Submit the form once.
8. Observe the success status text and the four committed values after the bridge action completes its fresh profile read.
9. Reload the route and observe the same four committed values and revisions `1` and `1`.

The browser then proves the stale path. Keep the browser model at the committed revision. Use one controlled native Profile command against the same actor to advance both rows to revision `2`, with a new command id and synthetic values. Do not reload the browser before the stale submit. Change at least one browser field and submit the browser's stale revision. Observe a `409` response from the bridge and the visible typed conflict alert. Query PostgreSQL and prove that the rejected command changed no row and wrote no receipt. Reload the browser and observe the controlled command's committed values at revisions `2` and `2`.

The browser journey does not show a success state for the stale command. It does not silently replace the stale model with the write response. The fresh reload is the only browser observation after the controlled concurrent write.

### Database replay and concurrency arc

Use two independent PostgreSQL connections. Prove independence with two distinct `pg_backend_pid()` values and distinct application names. Synchronize both contenders after they have opened their connections and before they issue the command. Both commands must target the same actor and carry the same expected name and contact revisions. The two command ids and payloads must differ.

The two contenders must produce exactly these outcomes:

- Exactly one command commits.
- Exactly one command returns a successful `OwnProfile` result.
- Exactly one command returns `ProfileStaleRevision`.
- The committed profile has both revisions incremented by one.
- The committed name and contact values come from the winning command.
- `profile_self_edit_commands` contains exactly one receipt for the two contenders.
- The receipt actor, canonical command JSON, digest, committed revisions, and result JSON link to the winning command.
- The losing command changes neither profile row and writes no receipt.

Replay the winning command after both contenders finish, from an independent connection. The replay must return the original committed `OwnProfile` result byte-for-byte after canonical JSON encoding. The two profile revisions and the receipt count must remain unchanged.

Send the same command id with one changed writable field. The result must be the typed `ProfileCommandConflict` failure. The profile rows, revisions, receipt count, and winning receipt bytes must remain unchanged.

The evidence must inspect the committed rows and receipt with PostgreSQL queries. It must not infer atomicity from an Effect result, a process log, a PGlite run, or a mocked SQL function. PGlite can cover schema and pure adapter checks, but it is not PostgreSQL concurrency evidence and cannot satisfy this section.

## HTTP and SDK observations

The real backend must expose only the 0053 routes for this journey:

| Request | Required observation |
|---|---|
| Authenticated `GET /api/me` | `200`, strict `UserProfile`, stored names and contacts, role projection, revisions |
| Authenticated `PUT /api/me` | `200`, strict fresh `UserProfile`; request contains exactly the command fields |
| Unauthenticated `GET /api/me` | `401` with the typed authentication error |
| Unauthenticated `PUT /api/me` | `401` with the typed authentication error |
| Malformed or excess-property `PUT /api/me` | `422`; no profile or receipt mutation |
| Stale command | `409` with the typed stale-revision error |
| Same-id, different-payload replay | `409` with the typed command-conflict error |

A missing Profile row or contact row remains `404`, and a database failure remains `503` under 0053. The writer records these statuses only through a real native HTTP boundary or a focused existing check; the writer must not manufacture them in the browser fixture.

The SDK must decode the request and response with the strict schemas. The evidence records that the SDK calls `/api/me`, not an old `/api/me/profile` or Hydra endpoint. The bridge action is an application route at `/profile`; it is not a second Profile authority. The action calls the authenticated SDK update and then the authenticated SDK fresh read.

## Browser, network, and accessibility boundaries

The Chromium evidence is valid only when all of these conditions hold:

- Playwright drives real Chromium in one worker with retries disabled.
- Login uses the rendered native Better Auth form. The runner does not inject a bearer token, a cookie value, a person id, or a role into a dashboard request.
- The dashboard uses the production build and the actual Foldkit custom element. The run does not import fixture data or replace `fetch` with a mock.
- The browser-visible route is `/dashboard/profile/rediger`; the bridge request is `/profile`; the backend requests are `GET /api/me` and `PUT /api/me`.
- The request ledger contains the native login and expected Profile requests only. It contains zero Symfony requests, zero legacy profile requests, zero fixture-server requests, and zero `/mock/api` requests.
- The `PUT /api/me` body has no `personId`, `role`, unknown field, gender, field-of-study, account-number, username, or photo field. Evidence records field names and revision numbers, not private payload values.
- `VITE_API_MODE` is absent or disabled. A fixture mode or fixture canary is a falsifier even if the page displays the expected synthetic values.
- The recording proxy forwards only to the loopback native backend and makes no external request.

Run an automated accessibility check with axe-core against Chromium at these states:

1. Initial editor with seeded values.
2. Invalid-field feedback after a local validation failure.
3. Successful save status.
4. Typed stale-conflict alert.

The check must report zero violations at the configured serious and critical impact levels. Also record these direct observations:

- One visible `h1` names the editor.
- Each input has one associated visible label and a stable unique id.
- Field errors use the existing alert semantics and reference the invalid field.
- The saving state exposes `aria-busy` and disables the form controls.
- The success message uses status semantics.
- The conflict message uses alert semantics.
- A keyboard-only user can focus every input, submit the form, reach the cancel link, and reach each error or status message without a pointer.

Accessibility evidence does not authorize a visual redesign. A violation is a failed evidence run and enters `Drift`.

## Exact falsifiers

Any one of these observations falsifies this evidence slice or opens `Drift`, even when another check passes:

- The implementation or evidence run changes the 0053 actor, fields, routes, command shape, ownership, revision law, replay law, or status mapping.
- The current source cannot run the journey without a semantic product change.
- The browser displays a fixture value, `getProfileData()`, a mock response, or a fixture canary.
- The browser journey does not use the real native login form and real Better Auth session boundary.
- The browser or command contains a person id or writable role supplied by the browser.
- The command accepts gender, field of study, account number, username, profile photo, or any excess property.
- The native read returns empty contact placeholders instead of the seeded contact values.
- The update response is accepted without strict request and response decoding.
- The page reports success without one decoded native `PUT /api/me` command.
- The page replaces the committed state from the write response without a fresh native `GET /api/me` read.
- A stale revision returns `200`, updates either profile row, or writes a receipt.
- Two conflicting PostgreSQL commands both commit, or neither command commits without a PostgreSQL failure.
- The two PostgreSQL contenders do not use independent connections, or the evidence cannot prove distinct backend pids.
- The two profile rows do not increment together, or their values disagree after a commit.
- The audit row is missing, mutable, duplicated for one winning command, or inconsistent with its canonical payload, digest, actor, revisions, or result.
- A same-id, identical-payload replay increments a revision, writes a second receipt, or returns a different committed result.
- A same-id, different-payload replay commits, changes a profile row, or changes the winning receipt.
- A missing Profile row or contact row does not map to `404`, a strict decode failure does not map to `422`, an authentication failure does not map to `401`, a stale or conflicting command does not map to `409`, or a database failure does not map to `503`.
- The SDK calls `/api/me/profile`, accepts Hydra, accepts excess properties, or sends a partial profile object.
- The backend HTTP adapter imports SQL, constructs a Layer, or bypasses the Profile Service.
- A fixture, mock, bearer-token map, Symfony request, legacy profile request, or external request supplies a profile value.
- The request ledger contains a request to Symfony, a legacy profile path, `/mock/api`, a fixture server, or any non-loopback host.
- Chromium is replaced by another browser, retries hide a failed attempt, or the run uses a mocked transport.
- The accessibility check reports a serious or critical violation, a field has no associated label, or keyboard submission cannot reach the typed result.
- PGlite output is presented as PostgreSQL concurrency proof.
- A credential, production row, remote database, provider, deployment, notification, or public-route effect occurs.
- Cleanup leaves the PostgreSQL cluster, backend, dashboard, proxy, temporary state, password, session token, or generated evidence containing sensitive material.

## Operator and data boundary

The writer has no authority to access production or remote resources. Use only loopback addresses and a fresh disposable PostgreSQL cluster. Use a process-scoped Better Auth secret and synthetic credentials. Do not read, copy, or load repository `.env`, `.env.*`, `.dev.vars`, or `.dev.vars.*` files. Pass all values at the process boundary.

Do not run a Symfony process. Do not contact Symfony, Cloudflare, an external API, a provider, a public route, or a notification service. Do not use production data or a production credential. Do not publish a PR, deploy, migrate remote data, or remove a remote resource.

If any command requests non-loopback access, a credential prompt, provider access, a production row, external notification, deployment, or publication, stop the run, retain a sanitized failure receipt, and enter `Drift`. Operator authorization cannot be inferred from this spec.

The writer removes disposable PostgreSQL data, generated auth rows, temporary logs, cookies, screenshots, traces, and process state in a `finally` path. The writer proves that the backend, dashboard, and proxy ports close. Evidence contains no password, session token, cookie value, database URL credential, or real personal data.

## Evidence record

The sanitized record must include:

- Base commit, worktree, branch or detached state, Node/Bun/PostgreSQL/Chromium versions, and the exact command invocation.
- Dependency and migration preflight, including the observed database migration revision and the three Profile tables.
- Seed identifiers and synthetic before/after values, with credentials and tokens removed.
- Browser observations for login, initial values, all-four-field edit, successful save, fresh read, reload, stale conflict, and post-conflict reload.
- The exact request ledger with method, path, status, and direction. Record no request or response body containing credentials or private payload values.
- PostgreSQL connection pids, contender command ids, both typed outcomes, winner identity, final two-row revisions and values, receipt count, replay result, and different-payload conflict result.
- Strict HTTP/SDK observations and the accessibility result.
- Cleanup observations and the post-stop closed-port checks.
- Any failure or Drift record. A failed run is not rewritten as a passing receipt.

The ordinary evidence command emits only sanitized stdout and local temporary artifacts. If the established runtime-evidence receipt path is requested later, the receipt must use the existing schema and evidence directory; this spec does not add a receipt file or invent a new journey identifier.

## Definition of done

This evidence slice is done only when all conditions are observed and recorded:

1. This spec is frozen and committed before any 0064 evidence runner, code, or test implementation.
2. The implementation at base `0e5f124` runs the unchanged 0053 semantic journey without a product behavior change.
3. A fresh loopback PostgreSQL cluster receives the repository migrations through `DatabaseLive`, and the Profile tables exist before the seed.
4. One seeded active member signs in through the real native Better Auth form in Chromium without bearer-token injection.
5. `/dashboard/profile/rediger` displays the seeded four writable values through the native Profile read.
6. The browser edits all four values, sends one strict command, observes committed values after the bridge's fresh native read, and observes the same values after reload.
7. The browser submits a stale revision and observes a typed `409` conflict. PostgreSQL proves that the rejected command changes no row and writes no receipt.
8. Two independent PostgreSQL connections issue conflicting commands from the same expected revisions. Exactly one commits, exactly one fails stale, both profile rows increment together, and one immutable receipt links the commit.
9. An identical replay returns the original committed result without another revision increment or receipt. A different payload with the same command id returns `409` and changes no data.
10. Native HTTP and SDK evidence records strict schemas and the 0053 status mapping, including `401`, `404`, `409`, `422`, and `503` boundaries where exercised.
11. The request ledger contains no Symfony, legacy profile, fixture, mock, or non-loopback request. The run contains no fixture canary.
12. Axe and the direct keyboard/label/heading/status/alert observations pass at the named browser states.
13. PostgreSQL is the only database used for concurrency claims. PGlite, mocks, unit output, and process logs are not presented as PostgreSQL or Chromium proof.
14. Cleanup closes every process and port and removes disposable data and sensitive artifacts.
15. The evidence is sanitized, independently reviewable, and limited to this one Profile self-edit journey. No source code, runner, test, dependency, route, or product contract is changed by this spec commit.

## Lifecycle and handoff

- **Specified:** satisfied by this frozen evidence contract at `design-specs/0064-native-profile-self-edit-evidence.md`.
- **Ready:** historical; superseded by the observed local runtime gate at integrated commit `b44c038f752e2b27c452d30c192ecc345f070b45`.
- **Building:** historical; superseded by the integrated evidence runner at commit `b44c038f752e2b27c452d30c192ecc345f070b45`.
- **Experienceable:** satisfied by the observed real PostgreSQL and Chromium receipt, ledger, accessibility output, and cleanup proof.
- **Conforming:** pending blind-first independent disposition of the frozen spec, source implementation, and sanitized objective evidence, with no linked Drift.
- **Release-ready / Operating:** not entered. This evidence run has no production, public, deployment, or provider authority.
- **Drift:** any falsifier, source mismatch, boundary breach, incomplete receipt, or disagreement with spec 0053 blocks the slice. The product lead routes intent disagreement back to `Specified` and implementation-only correction back to `Building`.
