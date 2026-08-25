# Live design spec 0018 — Dashboard applicant assignment SDK seam

> **Summary:** One dashboard maintainer journey moves the existing `Søkere` interview-assignment path onto the accepted server-side `@vektorprogrammet/sdk` seam. The loader obtains applicants, eligible interviewers, and interview schemas through the SDK. The action assigns one interview through the SDK. React Router revalidates the route and the maintainer sees the assigned interviewer. A loopback-only stub, synthetic data, one deterministic Playwright journey, and the completed visual artifact set provide local evidence. The accepted 0019 return rerun closes the unknown-status dependency without changing this route. This spec does not change the SDK, server, API contract, provider state, production data, or the applicant delete flow. Lifecycle remains `Building` until the frozen/open one-to-one PR gate.

## Metadata

| Field                            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stable ID                        | `0018`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Title                            | `Dashboard applicant assignment SDK seam`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Status                           | `accepted` — product-lead accepted the intent on `2026-08-11`; accepted 0019 closed the linked SDK dependency on `2026-08-12`. Canonical implementation, local browser evidence, visual evidence, and the canonical 0019 return rerun are complete. No provider, remote, production, or operator authority is granted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lifecycle state                  | `Building`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Ready`                          | Historical entry after independent review and intent acceptance. It is superseded by the current implementation state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Building`                       | Current: implementation, local browser evidence, visual evidence, and the accepted 0019 return rerun are complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Experienceable`                 | Not entered. No frozen/open one-to-one implementation PR exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Conforming`                     | Not entered and not claimed. The lifecycle authority requires the PR gate and blind-first verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Release-ready` / `Operating`    | Not entered and not implied. No release, deployment, provider, production, or operator authority exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Owner                            | Dashboard consumer specification lane                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Intended lane                    | One dashboard route consumer seam and one local browser journey                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Created                          | `2026-08-11`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Base checkpoint                  | `a8dafe618907dfd623718802fdaf5712d55f70d4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Parent checkpoint                | `33c37975a9eef8628a3b88ae1cbcf2230755234f`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Base worktree                    | `/tmp/mono-web-dashboard-applicant-assignment-spec-0018-20260811`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Spec branch                      | `spec/0018-dashboard-applicant-assignment-sdk-seam`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Journey count                    | One felt maintainer journey; one bounded implementation capsule; one local browser evidence set; one canonical 0019 return rerun; one future one-to-one PR gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Product-lead acceptance          | `ACCEPT` — intent accepted on `2026-08-11`; the linked 0019 implementation and Drift-closure disposition were accepted on `2026-08-12`. The product lead remains read-only to implementation and grants no external authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Independent specification review | `PASS` — `ApplicantAssignmentSpecReview0018`; exact semantic reviewed content HEAD `8b38acff6066889ea81a8e1b945f9f4de60f4333`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Implementation source candidate  | `3ab30e7f2e304e228a89b9108da50d078e8bd603` (parent `89f3b0cfe080ef196d89ae55e4f70eb6fa619619`); four-path source candidate under the applicant assignment implementation lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Canonical integration            | `c46104776106cbdfe72789fec64a80d54c4d79d1` (parent `2d8e8a6c4435a7fb627f45e65ce178979f7688dd`); canonical implementation integration for the four-path set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Canonical final head             | `ab95b5d36f515d1b60945b9d77a17a7519281493` (parent `beff9154e8efb94c641b6cd6f8d65384ae0110f8`); final `ab95` change is the applicant fixture terminal-newline repair only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Implementation status            | Complete and integrated on the canonical line. The four-path set is `apps/dashboard/app/lib/applicant-view.ts`, `apps/dashboard/app/routes/dashboard.sokere._index.tsx`, `apps/dashboard/e2e/applicant-assignment.spec.ts`, and `apps/dashboard/e2e/fixtures/applicant-api.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Code review                      | PASS — `agent://ApplicantAssignmentCodeRecheck0018` at source-candidate parent `89f3b0cfe080ef196d89ae55e4f70eb6fa619619`; `agent://ApplicantAssignmentFinalVerify0018` covers the `89f3b0c..3ab30e7` fixture-module delta; `agent://Canonical1718CodeReview` covers canonical `c46104776106cbdfe72789fec64a80d54c4d79d1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Local browser evidence           | PASS — `agent://Canonical1718RuntimeVerify` at canonical `c46104776106cbdfe72789fec64a80d54c4d79d1`, `agent://ApplicantAssignmentRuntimeReverify0018`, and `agent://ApplicantAssignmentFinalVerify0018`. Fixed loopback `127.0.0.1:8789`, typed faults, assignment/revalidation, forbidden browser product paths, and clean shutdown are recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Canonical 0019 return rerun      | PASS — `agent://ApplicationStatusRuntimeVerify0019` at canonical SDK head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; existing 0018 journey exit `0`, `1` passed/`1` skipped, exact alert `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`, zero Applicant One rows, no raw unknown/payload, zero product requests, and no unexpected hosts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Typecheck disposition            | Exactly six diagnostics remain in unrelated dashboard routes (`assistenter`, `epostliste`, `intervjuer`, `skoler`, `teaminteresse`, `vikarer`); zero diagnostics occur in the four 0018 paths. This is not a full-dashboard green claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unknown-status disposition       | Historical pre-0019 observation: the SDK unknown integer escaped as a non-`SdkError` ordinary `Error`, while the route failed closed with zero rows. **Closed by accepted 0019** at canonical `25e`; the typed Promise/Effect evidence and refined alert are recorded in the 0019 canonical gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Root lock authority              | Base `bun.lock` SHA-256 `ee978425937c78658cce31b76d667e01e8d082321b6d809cb09e64e217936514`; integrated accepted-0017 SHA-256 `90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a`. Only accepted 0017 changed the lock before/alongside integration; the 0018 and 0019 source/canonical chains changed no lock path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E-0018-12 disposition            | **Closed and satisfied:** the four 0018 paths changed, `bun.lock` and all SDK/server/Receipt/unrelated/provider paths stayed untouched, and accepted 0019 completed the owner/return path for `D-0018-SDK-1` at canonical `25e`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Structured evidence boundary     | Stub/trace evidence contains only sanitized methods, paths, statuses, response shapes, body keys, and synthetic technical IDs. It forbids names, emails, token/cookie values, raw payloads, network headers/payloads, real PII, and production data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Visual artifacts                 | PASS — `/tmp/mono-web-dashboard-applicant-assignment-evidence-0018-20260811/`: `before.png` 61,062 bytes, SHA-256 `cd20e4fbb4ba37c7360aeb7d6d21c93b712ae5ff8057469677c2250bfc1921fc`, 1440x900; `after.png` 60,534 bytes, SHA-256 `4c819b7ed03961e695ab7c6c43e33ce57048ce54de4733f211ed046b55f1fccb`, 1440x900; `interaction.webm` 382,785 bytes, SHA-256 `351474b3a9765984fcc0cde0a44a7dd04d16d2a4615b144322537d6e774693b2`, 1440x900, 6.08 seconds; `manifest.json` 10,148 bytes, SHA-256 `71cca70ac9202e9b8040039efe8c6c7a38b2f9318fd81dbed272c9f5cc6f99ac`; `README.txt` 4,566 bytes, SHA-256 `fd28b9e799578a228a6cc0a76e1648098e3d703105b7ce4c9a04fd935f6123f0`. Media was captured against pre-closure spec SHA-256 `28eb520d125ede622011d684795357e73d0ecbd5d6fe128e78d1755a064c05ee`; 0019 did not change the four UI-owned paths. |
| Visual review                    | PASS — `agent://ApplicantVisualUXReview0018` and `agent://ApplicantVisualArtifactReview0018`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Visual safe boundary             | Visuals show only fixed synthetic product/fixture labels and synthetic addresses under `@example.invalid`. They exclude real email, real PII, credentials, token/cookie values, network headers/payloads, raw stub payloads, provider output, and production data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PR evidence gate                 | The visual artifacts are recorded before any PR. A future one-to-one PR still requires the frozen-spec gate and may attach these artifacts; no PR is open or authorized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Current claim                    | Implementation, local browser evidence, visual evidence, and canonical 0019 return evidence are complete. `D-0018-SDK-1` is closed. This spec remains `Building` because no frozen/open one-to-one PR exists; it makes no `Experienceable`, `Conforming`, `Release-ready`, or `Operating` claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Historical adjacent ID check     | The frozen-base assertion that no `design-specs/0017*.md` existed is superseded. Canonical 0017 now exists as a separate live spec and does not conflict with 0018.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Goal, journey, and product boundary

### Goal

Give one team maintainer a repeatable local journey through the existing `Søkere` route:

```text
synthetic HttpOnly jwt_token cookie
  → /dashboard/sokere
  → server loader + API_URL + authenticated SDK client
  → admin.applications.list(status?)
  → admin.users.list()
  → admin.interviews.schemas()
  → existing Norwegian filter and table
  → existing “Tildel intervju” dialog
  → server action + admin.interviews.assign(applicationId, interviewerId, schemaId)
  → POST /api/admin/interviews/assign with exact JSON body
  → 204 / void
  → route revalidation
  → the assigned interviewer is visible in the same row
```

The maintainer then exercises the same route's typed failure boundary with deterministic loopback faults. API expiry redirects to `/login?expired=true`. Configuration, validation, conflict, not-found, rate-limit, network, and decode failures remain visible. A failure never becomes a successful empty table.

The journey proves only the named dashboard route and its server-side SDK consumer seam against a synthetic loopback instrument. It does not prove a Symfony response, API Platform behavior, backend authorization, persistence, provider state, production data, or a production route.

### One felt user journey

The felt journey is a maintainer opening `Søkere`, filtering applicants, assigning an interview, and seeing the assignment after revalidation. The negative branches are counterexamples inside this same route journey. They demonstrate that the seam fails visibly and fail closed; they are not additional product features or additional implementation PRs.

The route URL, Norwegian labels, filter interaction, dialog interaction, and successful behavior remain the current product contract:

- route: `/dashboard/sokere`;
- heading: `Søkere`;
- filters: `Alle`, `Nye`, `Tildelt`, `Intervjuet`, `Eksisterende`;
- columns: `Navn`, `E-post`, `Status`, `Intervjustatus`, `Intervjuer`, `Tidspunkt`, `Handlinger`;
- application labels: `Avbrutt`, `Ikke mottatt`, `Mottatt`, `Invitert`, `Akseptert`, `Fullført`, `Tildelt skole`;
- assignment button: `Tildel intervju`;
- dialog title: `Tildel intervju — <applicant>`;
- dialog labels: `Intervjuer`, `Intervjuskjema`, `Velg intervjuer`, `Velg skjema`, `Avbryt`, `Tildel`;
- delete interaction remains `Slett`, `Slett søknad`, and `Dette kan ikke angres`.

Adding safe error feedback in the existing route or dialog surfaces is required. A visual redesign, new product labels, or a new interaction model is forbidden.

## Values

1. **Stable product seam.** Keep the route, product language, filters, dialog, and successful assignment behavior stable while transport ownership moves to the accepted SDK.
2. **One transport owner.** The route parses request and form values. The server-side SDK owns API transport and wire semantics.
3. **Strict boundary.** Accepted SDK schemas decode applicants, users, and interview schemas. The route does not cast malformed data or invent fields.
4. **Fail closed.** Missing or invalid server configuration is a typed visible error before any request. It never selects a default or production destination.
5. **Typed failure over empty success.** A failed loader or action is distinguishable from a valid empty applicant list.
6. **Revalidation over optimistic fiction.** A successful assignment is observed from the revalidated loader result. The route does not fabricate a changed row in local state.
7. **Deterministic local evidence.** Synthetic state, a fixed loopback port, fixed IDs, fixed browser settings, and sanitized evidence make the journey repeatable.
8. **Reversible scope.** The only mutable product state in the journey is disposable in-memory stub state. No remote rollback or data cleanup is required.
9. **Honest claims.** A local browser trace proves only the named route, accepted SDK calls, and loopback responses. It does not prove backend or provider behavior.

## Constraints

### Canonical line and lifecycle

- `mono-web` is the canonical implementation line.
- This spec is currently `Building`: the four-path implementation and local browser evidence are complete on the canonical line.
- `Ready` is historical. Independent review and product-lead intent acceptance were recorded before implementation.
- No frozen/open one-to-one PR exists, so this spec is not `Experienceable` or `Conforming`.
- A source, dependency, runtime, or evidence disagreement enters `Drift`. The writer stops and does not edit the easiest authority.

### SDK and configuration boundary

- Accepted `0003` and the current SDK source are immutable dependencies for this slice. The future writer MUST NOT edit SDK source, schemas, transport, errors, exports, package metadata, generated output, or the root lock.
- Accepted Promise methods are the only route API. The route uses `client.admin.applications.list(status?)`, `client.admin.users.list()`, `client.admin.interviews.schemas()`, and `client.admin.interviews.assign(applicationId, interviewerId, schemaId)`.
- `API_URL` is the server-side base URL authority. `createAuthenticatedClient` passes that URL and the current `jwt_token` cookie to the SDK. `VITE_API_URL` is not an SSR substitute.
- Missing or invalid `API_URL` produces a typed SDK configuration error before `fetch`. The route makes that error visible. No Railway, localhost-default, environment inference, or other fallback is allowed.
- The current cookie is a static `AuthOption` for this journey. No refresh endpoint, rotation, persistence, provider, or invented authentication lifecycle is allowed.
- The SDK owns URL construction, query encoding, Bearer injection, JSON encoding, HTTP status mapping, response decoding, and `204`/void handling. The route never constructs an API URL or API `FormData`.

### Route and view boundary

- The loader calls `requireAuth` before SDK work. Missing cookie keeps the existing `/login` redirect.
- A loader API `401` or `403` uses the existing expired-session behavior and redirects exactly to `/login?expired=true`.
- The loader reads the current `status` search parameter and passes it as the optional status value to `admin.applications.list`. The SDK owns the query name and URL.
- The loader obtains applicant values, active/inactive users, and schema values through the authenticated server client. The browser receives serialized route data. It does not become a second transport owner.
- The existing eligibility rule remains: only active users with role `ROLE_TEAM_LEADER` or `ROLE_ADMIN` appear as interviewer choices. Inactive users and other active roles do not appear.
- The SDK returns an array from `admin.interviews.schemas()`. The route MUST NOT expect or unwrap a Hydra member envelope for that method.
- The action parses assignment IDs as finite positive integers. Invalid form values return a visible typed validation result and do not call the SDK.
- The assignment action calls exactly `admin.interviews.assign(applicationId, interviewerId, schemaId)`. It does not call a generic status operation or a new SDK alias.
- A successful assignment returns the SDK's void result. The route does not parse a response body.
- React Router's normal action revalidation MUST rerun the applicant loader. The post-assignment row comes from the revalidated SDK result. A local optimistic row update is not evidence.
- Assignment errors remain observable from the fetcher result in an existing route or dialog surface. The route does not close over or discard the error.
- Configuration, validation, conflict, not-found, rate-limit, network, and schema errors use safe visible route text. They MUST NOT expose raw response bodies, stack traces, tokens, or PII.
- A valid empty result remains a valid empty result. A typed failure is never represented as `{ applications: [] }` or another empty-success fallback.
- An optional `applicant-view.ts` helper can contain pure SDK-value-to-view and safe-error projections. It MUST NOT own transport, URLs, auth, schemas, fallback rows, or persistence.

### Browser boundary

- The browser page under test MUST NOT issue raw `fetch` calls to `/api/me/profile`, `/api/admin/users`, `/api/admin/interview-schemas`, `/api/admin/applications`, or `/api/admin/interviews/assign`.
- Playwright control requests to the loopback stub's `__applicant_stub` paths run outside the page under test. They are test instrumentation, not product transport, and MUST NOT be used by route code.
- `API_MODE` and `VITE_API_MODE` remain unset or non-fixture for the browser run. Existing inline mock behavior is not seam evidence and must not be used by the journey.
- The future e2e run uses Chromium, viewport `1440x900`, `CI=1`, retries `0`, and the fixed applicant stub port `8789`. The existing login fixture on `8788` and Receipt fixture on `8787` remain read-only and are not reused.

### Sensitive data and external effects

- Use only synthetic IDs, names, addresses under `.invalid`, and an in-memory synthetic token such as `trace-token`.
- Do not load, inspect, copy, log, commit, or attach credentials, environment secrets, production tokens, real names, real emails, operational records, or production data.
- The stub binds only to `127.0.0.1:8789`, performs no nested fetch, and has no provider or backend connection.
- No provider command, cloud account, remote state, deployment, public route, production API, route cutover, or operator action is part of this slice.
- Operator authorization is not needed or permitted. Any discovered external effect is `Drift`; stop and notify the product lead.

## Historical behavior and resolved defect

The following observations come from the exact base checkpoint. They describe the pre-implementation behavior and the correction recorded by the completed capsule.

| Area                   | Historical behavior or defect                                                                                                                                                                   | Recorded correction                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture boundary       | The route imported `isFixtureMode` and returned inline `mockApplications` before auth, server configuration, or SDK calls.                                                                      | The canonical browser journey ran non-fixture. The route uses the server SDK for its named data. Existing mock-success behavior was removed only from the owned route path. |
| Applicant wire model   | The route defined a duplicate local `Application` shape and cast `result.items as Application[]`.                                                                                               | The route consumes accepted SDK `Application` values. A pure view projection is used only when needed.                                                                      |
| Loader failure         | The loader caught every SDK failure and returned `{ applications: [] }`. A request failure therefore looked like a valid empty table.                                                           | Typed errors remain visible. A failed list, user list, or schema list does not become an empty success.                                                                     |
| Option transport       | `AssignInterviewDialog` called browser `fetch('/api/admin/users')` and `fetch('/api/admin/interview-schemas')`, called `.json()`, cast both responses, and expected `hydra:member` for schemas. | The server loader calls the accepted SDK methods and passes decoded option values to the dialog. The browser makes no product API call.                                     |
| Auth ownership         | Browser option requests used `credentials: 'include'`; the server-side SDK seam was bypassed.                                                                                                   | The current cookie reaches the SDK through `createAuthenticatedClient`. The SDK injects the Bearer header.                                                                  |
| Assignment action      | The action already called `admin.interviews.assign`, but caught every failure and returned a generic result without a visible fetcher error surface.                                            | The accepted SDK call parses IDs safely, preserves typed error identity, and renders safe visible failure feedback.                                                         |
| Assignment observation | The action did not provide evidence that the changed row came from a revalidated applicant list.                                                                                                | A successful `204` is followed by loader revalidation. The row shows the synthetic assigned interviewer from the loader result.                                             |
| Delete behavior        | The same route has a delete action and dialog with separate current behavior and broad error concerns.                                                                                          | The implementation did not rewrite, delete, redesign, or claim the applicant delete flow.                                                                                   |
| Product interaction    | The base page had Norwegian headings, filters, table columns, assignment dialog, and delete dialog.                                                                                             | Labels, route URLs, interaction sequence, and successful assignment behavior remain stable.                                                                                 |
| Parent shell loader    | The read-only `dashboard.tsx` parent loader calls `client.me.profile()` during page load and normal route revalidation.                                                                         | The applicant stub answers `GET /api/me/profile` with a complete synthetic `UserProfile`. The implementation did not edit the parent loader or claim a parent migration.    |

The route's inline mock and local duplicate type were inside the owned route file. `apps/dashboard/app/mock/api/data-sokere.ts`, if present or referenced by another route, remains outside this slice.

## Accepted SDK contract

The SDK methods below are read-only dependencies. Their current source owns the wire contract.

| Route need               | Accepted method                                                          | SDK-owned wire behavior                                                                                                                                                            | Route-owned behavior                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parent shell profile     | Read-only `client.me.profile()` in the parent dashboard loader           | `GET /api/me/profile`; Bearer auth; `UserProfile` decoding; typed errors                                                                                                           | Parent dashboard loader projects the accepted profile to the existing shell. This spec supplies the stub response and does not edit the parent loader. |
| Applicant list           | `client.admin.applications.list(status?)`                                | `GET /api/admin/applications`; status query construction; Bearer auth; Hydra collection decode; strict `Application` decode; typed errors                                          | Read the route search parameter and project accepted values to table values                                                                            |
| Interviewer options      | `client.admin.users.list()`                                              | `GET /api/admin/users`; plain `{ activeUsers, inactiveUsers }` response; strict `User` decode; typed errors                                                                        | Filter active accepted users by the existing eligible roles and project display labels                                                                 |
| Interview schema options | `client.admin.interviews.schemas()`                                      | `GET /api/admin/interview-schemas`; JSON array response; strict `InterviewSchema_` decode; typed errors                                                                            | Project accepted `id` and `name` values to the existing select interaction                                                                             |
| Assignment command       | `client.admin.interviews.assign(applicationId, interviewerId, schemaId)` | `POST /api/admin/interviews/assign`; JSON body with numeric IDs; Bearer auth; `Content-Type: application/json`; no `Accept` header; HTTP status mapping; `204`/void interpretation | Parse form IDs, call the method, expose the result, and allow normal route revalidation                                                                |

The parent dashboard loader is a read-only dependency. It calls `client.me.profile()` on the initial dashboard load and on normal route revalidation. The applicant fixture must answer that request so the browser journey is locally experienceable. This spec does not change the parent loader or its shell projection.

The SDK's `ApplicationFromRaw` boundary accepts the server's integer `applicationStatus` and maps known values to its closed status values. The route does not reproduce that integer mapping. Known malformed collection or member shapes fail at the SDK boundary as public validation errors and remain visible.

The inherited `parseApplicationStatus` ordinary `Error` escape is a historical pre-0019 observation. The 0018 implementation failed closed with a visible list error and zero applicant rows. Accepted 0019 repaired the SDK typed channel without editing 0018, and the canonical 25e rerun shows the exact alert `Kunne ikke laste søkere. Kontroller dataene og prøv igjen.`. `D-0018-SDK-1` is **Closed** with owner and return completed by 0019; no open dependency remains for this slice.

The read-only OpenAPI document is a server contract reference. Its shape is not permission to weaken the accepted SDK schemas. Any mismatch between OpenAPI, current server behavior, and the accepted SDK is downstream `Drift`; this slice does not repair or adjudicate it.

## Source and authority table

The exact base is `a8dafe618907dfd623718802fdaf5712d55f70d4`, with parent `33c37975a9eef8628a3b88ae1cbcf2230755234f`. Every `mono-web` path below was read at that base. Each SHA-256 value is the whole-file content hash at authoring time. The two `/srv/share/projects/vektorprogrammet/docs/` files are outer canonical documents outside this checkout. Their hashes are content digests, not claims of a mono-web commit.

| Authority or observation                   | Exact path and relevant section                                                                                                                                                   | Frozen revision or SHA-256                                                                                                                                                                                                                                                                                                                                  | Boundary for this spec                                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle process                          | `/srv/share/projects/vektorprogrammet/docs/agentic-development-lifecycle.md` §§2, 4–6, 8–10, 12                                                                                   | `sha256:a13956a1a2b6cbf09a58c460071827728f16ae7febe961275c905747ed29f809`                                                                                                                                                                                                                                                                                   | Owns lifecycle, gates, capsules, evidence, Drift, and operator boundaries.                                                                                                                                                                                            |
| Product direction                          | `/srv/share/projects/vektorprogrammet/docs/product-lead-charter.md` §§1–5, 6–12                                                                                                   | `sha256:d731fb63212ca1412cbd5edc928f4f16fa01efe1c509e1dbb199f601d455ca85`                                                                                                                                                                                                                                                                                   | Owns canonical line, SDK seam, order, product-lead boundary, and external-effect authority.                                                                                                                                                                           |
| Program snapshot                           | `/srv/share/projects/vektorprogrammet/docs/status-2026-08-10.md`                                                                                                                  | `sha256:115a79c20daa4082b979642ac1c157c095b526cc3bd6b57881abad1a294105b3`                                                                                                                                                                                                                                                                                   | Pointer for current priority only. It cannot replace the lifecycle or charter.                                                                                                                                                                                        |
| Accepted SDK predecessor                   | `design-specs/0003-effect-v4-receipt-sdk-compatibility.md` §§1–5, 8–12                                                                                                            | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:2c1e1205e07a8ecb3aa0c615d3566254ce0b487f183bcbdca232ca25616386ce`                                                                                                                                                                                                                                  | Read-only SDK boundary, typed errors, strict decoding, fail-closed configuration, and local evidence limits.                                                                                                                                                          |
| Accepted consumer seam                     | `design-specs/0008-dashboard-receipt-sdk-consumer-seam.md` §§1–6, 8–12                                                                                                            | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:f9ebe21a0945596b19a0a656afb0d7589c4777b1a73b411c571722aaaea6db93`                                                                                                                                                                                                                                  | Read-only consumer pattern for SSR `API_URL`, cookie auth, typed errors, loopback stubs, evidence, and rollback. Its Receipt paths remain untouched.                                                                                                                  |
| Accepted dashboard cutover                 | `design-specs/0010-dashboard-bun-sdk-resolution.md` §§1–6 and final scope/evidence sections                                                                                       | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:9c8921f8cbe427a683eec621771b2e7918f1f7853e7c0526640274771f97f69d`                                                                                                                                                                                                                                  | Read-only integrated workspace authority. Its separately recorded `Conforming` state is not inherited by 0018. The base residue remains with the consumed 0010 capsule; accepted 0019 now closes `D-0018-SDK-1` through its typed SDK return and canonical 25e rerun. |
| Current applicant route                    | `apps/dashboard/app/routes/dashboard.sokere._index.tsx`                                                                                                                           | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:bbc6039db16bef4d04a6f60155310c2fe8b1861bf4426334ab396c4f61efe1c9`                                                                                                                                                                                                                                  | Canonical 0018 implementation path. Delete behavior remains a non-goal.                                                                                                                                                                                               |
| Parent dashboard loader                    | `apps/dashboard/app/routes/dashboard.tsx`                                                                                                                                         | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:dd61aed23a79407ec33769ef157a353c848913615ddf54e081c6751d80d3acfd`                                                                                                                                                                                                                                  | Read-only parent dependency. It calls `client.me.profile()` on initial load and normal revalidation.                                                                                                                                                                  |
| SSR client helper and auth                 | `apps/dashboard/app/lib/api.server.ts`; `apps/dashboard/app/lib/auth.server.ts`                                                                                                   | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:7942bc107e3895dd3061ece2c9226d04b117e57fd064de98a771e3d86f714ab1`; `sha256:120939752328310834ea75dc3d7a29d72cb0c1945d367bbf211220a163f4358a`                                                                                                                                                       | Read-only server seam. `API_URL`, `AuthOption`, cookie extraction, `/login`, and Bearer ownership are not reimplemented here.                                                                                                                                         |
| Profile SDK domain                         | `packages/sdk/src/domains/me.ts`                                                                                                                                                  | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:b2660877a73656136a1772b584b49633342e91f84e4a2cebd6912584d4f7f943`                                                                                                                                                                                                                                  | Read-only `profile` capability used by the parent loader.                                                                                                                                                                                                             |
| Applicant SDK domain                       | `packages/sdk/src/domains/admin/applications.ts`                                                                                                                                  | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:e7c4ae0cdba5bfe4724d4c47cc61a8284bb61bad0c853385a957a21a4d95b544`                                                                                                                                                                                                                                  | Read-only `list`, `get`, delete, and bulk-delete capability. Only `list` is in this journey.                                                                                                                                                                          |
| Interview SDK domain                       | `packages/sdk/src/domains/admin/interviews.ts`                                                                                                                                    | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:fd3f4cd6cbd3923755371da6fcfdaf9663fe332c82667b36ca70a426e61df3d3`                                                                                                                                                                                                                                  | Read-only `assign` and `schemas` capability. Scheduling, conducting, and cancellation are outside this journey.                                                                                                                                                       |
| User SDK domain                            | `packages/sdk/src/domains/admin/users.ts`                                                                                                                                         | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:e3613011809a3a9913c6093f251d00949517c448df7d386612557ac518afea71`                                                                                                                                                                                                                                  | Read-only plain users response and strict user decoding.                                                                                                                                                                                                              |
| Applicant value schema                     | `packages/sdk/src/schemas/application.ts`; `packages/sdk/src/adapter/status.ts`                                                                                                   | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:2647d04675cbe334f94aa8453f9c9ea4bd196f599a4d3d5cdecee194335cbaad`; `sha256:f840518282ccfd5c97d5d9e620c05ff78b92fcaf9c611e54ca6b7ad59cdba279`                                                                                                                                                       | Read-only integer status decoding and closed application-status values.                                                                                                                                                                                               |
| Interview and user schemas                 | `packages/sdk/src/schemas/interview.ts`; `packages/sdk/src/schemas/user.ts`                                                                                                       | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:871e518204345cf5cab8837437dab7af351e95ed28e348c36c148dbd26211c9b`; `sha256:4d7ee6aa127c98ac0881e4d5d41a7480bf14a201d233e078f2eb4aff4f0d68e6`                                                                                                                                                       | Read-only `InterviewSchema_` and `User` values.                                                                                                                                                                                                                       |
| SDK transport and errors                   | `packages/sdk/src/transport.ts`; `packages/sdk/src/errors.ts`; `packages/sdk/src/promise.ts`; `packages/sdk/src/config.ts`                                                        | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:f0c906095e55717ff19ecf8b882b76ee8724a470b1ce9929f580c617a83e8f84`; `sha256:aedae4aa50bd9232142f94ead5fb262e98cd9a85349526da39bc6084653c0342`; `sha256:78f8ec5a2613e74486498b248da68eefc1ff73a92aca902edf40fc35bf44c9ae`; `sha256:1c562f72068f71c539c8268ca51e2a0a90560811e359367ce4c2e52af22eb9ec` | Read-only URL, auth, headers, status mapping, Schema decoding, void, Promise, and configuration behavior.                                                                                                                                                             |
| API contract reference                     | `packages/sdk/legacy-symfony-openapi.snapshot.json` applicant paths `/api/admin/applications`, `/api/admin/users`, `/api/admin/interview-schemas`, `/api/admin/interviews/assign` | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:7a2419617b1f1801f2218d460963873705b7653805de61c5d2448d397229a00f`                                                                                                                                                                                                                                  | Read-only server contract reference. No OpenAPI or backend edit is allowed.                                                                                                                                                                                           |
| Workspace and dependency authority         | `package.json`; `packages/sdk/package.json`; `apps/dashboard/package.json`; `bun.lock`                                                                                            | Base `a8dafe618907dfd623718802fdaf5712d55f70d4`; base `bun.lock` SHA-256 `ee978425937c78658cce31b76d667e01e8d082321b6d809cb09e64e217936514`; integrated accepted-0017 `bun.lock` SHA-256 `90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a`                                                                                                 | The accepted 0017 lane owns the lock mutation before/alongside integration. The 0018 source candidate, canonical integration, and final `ab95` chain changed no `bun.lock` path.                                                                                      |
| Root lock cross-lane disposition           | `bun.lock` cross-lane record                                                                                                                                                      | Base SHA-256 `ee978425937c78658cce31b76d667e01e8d082321b6d809cb09e64e217936514`; integrated accepted-0017 SHA-256 `90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a`                                                                                                                                                                        | Accepted 0017 changed the lock before/alongside integration. The 0018 four-path set and final newline repair did not mutate it; `E-0018-12` is satisfied. No lock refresh, install, or dependency repair is authorized by 0018.                                       |
| Browser harness and existing fixture ports | `apps/dashboard/playwright.config.ts`; `apps/dashboard/e2e/fixtures/login-api.mjs`; `apps/dashboard/e2e/fixtures/receipt-api.ts`; `apps/dashboard/e2e/receipts.spec.ts`           | `base a8dafe618907dfd623718802fdaf5712d55f70d4`; `sha256:ae33c9ca233bd5df55899505f4e29567a1dba3e017fef3ec7664d4a7acc1b5a3`; `sha256:b60b9aa8e007d9a469882b44fb1557b842709936b2ca199e0ed46283b1b00984`; `sha256:7b235995ee4f5a885503b41fe8baca9369176f4b10c58a52e8b7d4b302f8b0f4`; `sha256:bbaeeb412b470f62ada31dd62abbaeee672154f2e4f9ab763f84bce1b00478d6` | Read-only harness pattern. Login uses `8788`; Receipt uses `8787`; applicant fixture owns `8789`. No Playwright config edit.                                                                                                                                          |

The authority table records frozen source identity and current canonical provenance. The implementation is complete, but the four-path capsule and its evidence do not open or freeze a one-to-one PR. A future PR must re-check the named authorities and visual boundary; a changed authority enters `Drift`.

## Loader, action, and view ownership

### Loader

The loader owns only request authentication precondition, search-parameter reading, and route-safe projection:

1. Call `requireAuth(request)`. Preserve `/login` for a missing cookie.
2. Create the client through `createAuthenticatedClient(token)`.
3. Read the optional `status` search parameter.
4. Call `admin.applications.list(status ? { status } : undefined)`, `admin.users.list()`, and `admin.interviews.schemas()` through the server-side client.
5. Filter active users to `ROLE_TEAM_LEADER` and `ROLE_ADMIN` for the existing select.
6. Pass accepted applicant values and projected option values to the existing view.
7. Preserve typed SDK failures. Redirect API `UnauthorizedError` to `/login?expired=true`; expose all other typed failures safely.

The loader does not own URL construction, query encoding, auth headers, JSON decoding, Hydra decoding, schema decoding, retries, persistence, or fallback data.

### Action

The action owns only form intent and assignment input parsing:

1. Call `requireAuth(request)` and create the authenticated server client.
2. Read the existing `intent=assign`, `applicationId`, `interviewerId`, and `interviewSchemaId` fields. Map `interviewSchemaId` to the SDK's `schemaId` argument; do not rename the browser form contract.
3. Reject missing, non-integer, non-finite, zero, or negative IDs visibly before the SDK call.
4. Call `client.admin.interviews.assign(applicationId, interviewerId, schemaId)` with numeric IDs.
5. Return the accepted void success or a typed safe error result. Do not turn an error into `{ success: true }`.
6. Leave the existing delete intent and delete interaction unchanged. Delete is not part of the assignment action contract.

The action does not own API paths, JSON serialization, headers, status mapping, response decoding, or direct browser communication.

### View and dialog

The view owns only presentation of accepted values and existing interaction:

- render the existing `Søkere` table, filter tabs, status badges, columns, and action controls;
- pass loader-provided eligible users and schemas into `AssignInterviewDialog`;
- keep `Intervjuer`, `Intervjuskjema`, and the existing select labels;
- submit the existing `assign` intent through the route action;
- show a safe typed error from the fetcher in an existing route/dialog surface;
- close or remain open only according to the current interaction after success, but never hide a failed assignment;
- rely on loader revalidation for the assigned row;
- keep the delete dialog and its action unchanged.

The view does not call a product API, read `API_URL`, parse wire payloads, own auth, or construct `FormData`. The optional pure helper can map `Application`, `User`, and `InterviewSchema_` values to stable view records. It cannot create a second schema authority.

## Typed error and representation contract

| Boundary observation                     | Required route result                                                                                                      | Falsifier                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Missing `jwt_token` cookie               | Existing redirect to `/login` before SDK work                                                                              | SDK request, empty table, or `/login?expired=true` for this precondition                |
| API `401` or `403`                       | Redirect exactly to `/login?expired=true`                                                                                  | Stale table, generic success, or another redirect                                       |
| Missing or invalid `API_URL`             | Visible `API-konfigurasjon mangler eller er ugyldig.` or the accepted equivalent safe configuration view; zero API request | Default URL, synchronous helper failure, request to a non-loopback host, or empty table |
| SDK `ValidationError`                    | Visible safe validation feedback; preserve no raw payload                                                                  | Cast, partial row, or empty-success table                                               |
| SDK `ConflictError` or `NotFoundError`   | Visible safe operation error; preserve existing rows when route semantics allow                                            | Silent success or invented retry/alias                                                  |
| SDK `RateLimitedError` or `NetworkError` | Visible stable error; no unbounded retry                                                                                   | Empty table or hidden failure                                                           |
| SDK decode failure                       | Visible safe list/option error before a row or option is rendered                                                          | Malformed applicant, user, or schema reaches the view                                   |
| Invalid assignment IDs                   | Visible validation result; zero assignment request                                                                         | `Number('')` or another invalid value reaches the SDK                                   |
| Assignment `204`                         | Void success followed by loader revalidation                                                                               | Response JSON parse, optimistic-only row change, or no revalidation                     |
| Valid empty applicant collection         | Empty table with no error                                                                                                  | Failure represented as an empty table                                                   |

Safe assignment failure text can preserve the current `Kunne ikke tildele intervju` wording. Safe list/option failure text can use `Kunne ikke laste søkere` or a similarly stable Norwegian product message. The implementation must retain the typed error category in route logic even when the visible text is intentionally safe and concise.

## Exact maintainer journey

The historical journey contract below drove the canonical implementation. The named runtime agents recorded its objective local browser evidence; this docs-only revision runs no implementation commands.

### 1. Freeze the boundary

1. Start from a clean worktree at `a8dafe618907dfd623718802fdaf5712d55f70d4`.
2. Confirm the accepted `0003`, `0008`, and `0010` sources and the current route/SDK hashes in the authority table.
3. Confirm that only the future capsule paths are mutable. Treat the SDK, server helper, auth helper, OpenAPI, root package files, root `bun.lock`, Playwright config, existing fixtures, Receipt paths, and unrelated routes as read-only.
4. Keep `API_MODE`, `VITE_API_MODE`, and `VITE_API_URL` unset. Do not inspect or load credential files.

### 2. Fail-closed configuration preflight

Before starting the applicant stub, run the same server route boundary with `API_URL`, `VITE_API_URL`, `API_MODE`, and `VITE_API_MODE` absent. Supply only the synthetic `jwt_token` cookie in memory. Request the applicant route loader or its data response.

The helper construction must not synchronously throw. The invoked SDK operation must fail with a typed configuration error before `fetch`. The route must show its safe configuration error. The stub and every external host must receive zero requests. Missing cookie remains a separate `/login` precondition.

This preflight is configuration evidence for the same journey. It is not a second product journey and it does not authorize a default API destination.

### 3. Start the fixed loopback stub

The future writer adds `apps/dashboard/e2e/fixtures/applicant-api.ts`. A command-scoped wrapper starts it before Playwright:

```sh
stub_pid=
stub_log="${TMPDIR:-/tmp}/applicant-api-$$.log"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$stub_pid" ]; then
    kill -TERM "$stub_pid" 2>/dev/null || true
    wait "$stub_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM
bun e2e/fixtures/applicant-api.ts --port 8789 >"$stub_log" 2>&1 &
stub_pid=$!
ready=
for attempt in $(seq 1 100); do
  if curl --fail --silent http://127.0.0.1:8789/__applicant_stub/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
[ "$ready" = 1 ] || { printf '%s\n' 'applicant stub did not become ready' >&2; exit 1; }
env -u API_MODE -u VITE_API_MODE -u VITE_API_URL \
  CI=1 API_URL=http://127.0.0.1:8789 \
  bun run test:e2e -- e2e/applicant-assignment.spec.ts \
  --project=chromium --retries=0
```

Run the wrapper from `apps/dashboard`. The wrapper owns startup and shutdown. The browser test only uses Playwright request controls for reset, faults, and evidence. It does not start the stub or mutate process environment. The stub must bind only to `127.0.0.1:8789`, drain in-flight requests, handle `SIGINT` and `SIGTERM`, and close before the wrapper exits.

### 4. Main browser pass

Use a fixed synthetic cookie:

```text
name: jwt_token
value: trace-token
host: 127.0.0.1
path: /
HttpOnly: true
SameSite: Lax
```

The value exists only in memory. The evidence endpoint and attached evidence MUST NOT contain it.

The Playwright journey uses one Chromium test at `1440x900`, with retries disabled. It performs these steps:

1. Reset the stub through `POST /__applicant_stub/reset`.
2. Add the synthetic cookie to the browser context.
3. Visit `/dashboard/sokere`.
4. Assert `Søkere`, the seeded applicant row, and the existing table labels are visible.
5. Click `Nye`. Assert that the route remains the same product route and that the stub records an SDK-owned applicant list request with `status=new`. The status value is an opaque route filter for this local contract; this journey does not claim backend filter semantics.
6. Assert that the browser request log contains no product request to `/api/me/profile`, `/api/admin/users`, `/api/admin/interview-schemas`, `/api/admin/applications`, or `/api/admin/interviews/assign`.
7. Open `Tildel intervju` for the seeded unassigned applicant. Assert that `Intervjuer Test` is available, that an ineligible active role is absent, that an inactive user is absent, and that `Førstegangsintervju` is available.
8. Select interviewer ID `201` and schema ID `301`. Submit the existing `Tildel` interaction.
9. Assert that the stub receives `POST /api/admin/interviews/assign` with numeric body `{ applicationId: 101, interviewerId: 201, schemaId: 301 }` and returns bodyless `204`.
10. Assert that the route performs a subsequent applicant loader request after the successful action. The evidence must show a second applicant list observation for the active filter or an equivalent React Router revalidation observation.
11. Assert that the revalidated row shows `Intervjuer Test`, and that the assignment control is no longer offered for that row. The row must come from the loader response, not an optimistic local-only mutation.
12. Read the sanitized stub evidence and assert the request, response-shape, auth-shape, transition, and no-secret contract below.

The route may issue the three initial loader calls concurrently. The evidence assertion checks the required request set and revalidation, not an incidental network ordering.

### 5. Typed failure branches in the same journey

Use the stub control route to set one deterministic fault at a time. Reset between branches.

1. Set `assign` to `422` with a Symfony-style violations shape. Attempt assignment for the second seeded applicant. Assert `Kunne ikke tildele intervju` or the accepted safe equivalent is visible, the row remains unassigned, and the failure does not become success.
2. Set `applications-list` to `500`. Reload the route. Assert a visible list error and no successful empty table.
3. Set `users-list` or `schemas-list` to a malformed payload. Reload the route. Assert a visible typed decode error and no silently empty select.
4. Set `applications-list` to `401` and reload. Assert the exact `/login?expired=true` redirect.
5. Clear the fault and restore the route. Remove the cookie and visit the route once. Assert the existing `/login` redirect. Restore the synthetic cookie before cleanup.
6. Exercise `404`, `409`, `429`, and network/configuration faults through the same typed route boundary in the future capsule. Each must remain visible or use the exact expiry redirect. The implementation must not add an unbounded retry.

The negative branches do not add new UI flows. They prove that the one assignment journey does not hide transport or decoding errors.

### 6. Evidence and cleanup

1. Read `GET /__applicant_stub/evidence` after the main and negative observations.
2. Assert that the evidence has no `trace-token`, applicant names, emails, question text, raw response body, stack trace, or credential value.
3. Clear the stub and let the wrapper signal and await process shutdown.
4. Remove temporary Playwright output, browser storage, logs, and in-memory fixture state. Do not commit generated output or a repository evidence file.

## Exact synthetic loopback evidence contract

The applicant stub is a test instrument. It is not a backend replacement and is not a source of domain authority. It must implement only the following local contract.

### Synthetic seed

The reset state contains two synthetic applicants, one complete synthetic parent profile, and one assignment target:

| Entity                 | Synthetic value                                                                                                                                                                     | Required use                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Parent profile         | `id: 900`; `firstName: "Admin"`; `lastName: "Test"`; `email: "admin.profile@example.invalid"`; `phone: null`; `department: "Syntetisk"`; `fieldOfStudy: null`; `profilePhoto: null` | Complete accepted `UserProfile` response for the read-only parent dashboard loader |
| Applicant A            | application ID `101`; required string fields; raw `applicationStatus: 1`; `interviewer: null`                                                                                       | Main assignment target                                                             |
| Applicant B            | application ID `102`; required string fields; raw `applicationStatus: 1`; `interviewer: null`                                                                                       | Assignment failure branch                                                          |
| Eligible interviewer   | user ID `201`; `firstName: "Intervjuer"`; `lastName: "Test"`; role `ROLE_TEAM_LEADER`                                                                                               | Main assignment option                                                             |
| Eligible administrator | user ID `202`; `firstName: "Admin"`; `lastName: "Test"`; role `ROLE_ADMIN`                                                                                                          | Prove the existing role rule                                                       |
| Ineligible active user | user ID `203`; complete fields; another role                                                                                                                                        | Must not appear in the select                                                      |
| Inactive user          | user ID `204` in `inactiveUsers`; complete fields                                                                                                                                   | Must not appear in the select                                                      |
| Interview schema       | schema ID `301`; name `Førstegangsintervju`; at least one strict question record                                                                                                    | Main schema option                                                                 |
| Synthetic token        | `trace-token` in memory only                                                                                                                                                        | Bearer assertion; never evidence                                                   |

The profile response contains exactly the accepted `UserProfile` fields. It has no role field. The SDK and parent loader remain immutable dependencies. The parent loader's current profile-role cast therefore cannot establish Admin visibility; this slice does not repair or accept that shell behavior. `Søkere` remains reachable through its direct route and existing main navigation. Names and email fields satisfy the accepted schemas and use synthetic `.invalid` addresses. The exact values are test data, not PII authority. The stub evidence omits all person-facing values.

### Product API paths

| Method and path                                                       | Required request                                                                                                                                                             | Deterministic response and state                                                                                                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me/profile`                                                 | Bearer shape required                                                                                                                                                        | `200` complete synthetic `UserProfile` fields for the read-only parent loader's existing shell projection. This endpoint is observed on initial page load and normal route revalidation.            |
| `GET /api/admin/applications`                                         | Bearer shape required; optional `status` query is recorded                                                                                                                   | `200` with `{ "hydra:member": [<two strict raw applications>], "hydra:totalItems": 2 }`. After valid assignment, Applicant A has `interviewer: "Intervjuer Test"` and `interviewStatus: "Pending"`. |
| `GET /api/admin/users`                                                | Bearer shape required                                                                                                                                                        | `200` plain `{ activeUsers: [...], inactiveUsers: [...] }` with complete strict user fields. This is not a Hydra collection.                                                                        |
| `GET /api/admin/interview-schemas`                                    | Bearer shape required                                                                                                                                                        | `200` JSON array of complete `InterviewSchema_` values. This is not a Hydra envelope.                                                                                                               |
| `POST /api/admin/interviews/assign`                                   | Bearer shape required; JSON body exactly `{ applicationId: 101, interviewerId: 201, schemaId: 301 }` for the main pass; `Content-Type: application/json`; no `Accept` header | `204` with no body. Mutate only disposable in-memory state. Record `application-assigned:101:201:301`. A wrong method, path, field, type, or ID returns `422` and does not mutate state.            |
| Any other loopback `GET /api/*` caused by a read-only parent prefetch | Bearer shape accepted; no state mutation                                                                                                                                     | `404` with no nested request; record response shape `unlisted-api-404`. This observation is outside the named applicant request set and is not a backend claim.                                     |

Every product API request must receive the synthetic Bearer header through the server-side SDK. `GET` requests record `Accept: application/ld+json`. The assignment `POST` records no `Accept` header and records `Content-Type: application/json`. The stub records only `bearer-present: true`; it never records the token. A missing or wrong auth shape is a fixture failure, not a successful request.

#### Exact successful response bodies

The successful reset state uses these exact JSON bodies. The assignment transition changes only Applicant A's `interviewer` and `interviewStatus` fields.

```text
GET /api/me/profile
{
  "id": 900,
  "firstName": "Admin",
  "lastName": "Test",
  "email": "admin.profile@example.invalid",
  "phone": null,
  "department": "Syntetisk",
  "fieldOfStudy": null,
  "profilePhoto": null
}

GET /api/admin/applications
{
  "hydra:member": [
    {
      "id": 101,
      "userName": "Applicant One",
      "userEmail": "applicant-101@example.invalid",
      "applicationStatus": 1,
      "interviewStatus": null,
      "interviewer": null,
      "interviewScheduled": null,
      "previousParticipation": false
    },
    {
      "id": 102,
      "userName": "Applicant Two",
      "userEmail": "applicant-102@example.invalid",
      "applicationStatus": 1,
      "interviewStatus": null,
      "interviewer": null,
      "interviewScheduled": null,
      "previousParticipation": false
    }
  ],
  "hydra:totalItems": 2
}

GET /api/admin/users
{
  "activeUsers": [
    {
      "id": 201,
      "firstName": "Intervjuer",
      "lastName": "Test",
      "email": "interviewer-201@example.invalid",
      "role": "ROLE_TEAM_LEADER"
    },
    {
      "id": 202,
      "firstName": "Admin",
      "lastName": "Test",
      "email": "admin-202@example.invalid",
      "role": "ROLE_ADMIN"
    },
    {
      "id": 203,
      "firstName": "Uegnet",
      "lastName": "Test",
      "email": "ineligible-203@example.invalid",
      "role": "ROLE_MEMBER"
    }
  ],
  "inactiveUsers": [
    {
      "id": 204,
      "firstName": "Inaktiv",
      "lastName": "Test",
      "email": "inactive-204@example.invalid",
      "role": "ROLE_TEAM_LEADER"
    }
  ]
}

GET /api/admin/interview-schemas
[
  {
    "id": 301,
    "name": "Førstegangsintervju",
    "questions": [
      { "id": 311, "text": "Fortell kort om motivasjonen din.", "type": "text" }
    ]
  }
]
```

After the valid assignment, the application response for ID `101` is identical except for `"interviewStatus": "Pending"` and `"interviewer": "Intervjuer Test"`. No other seeded value changes.

The `requests` array records each observed product request. Repeated profile or applicant-list entries caused by normal route revalidation remain as separate observations; the fixture does not collapse them.

### Local controls

| Method and path                  | Request and response                                                                                                                                                                                                                                 | Purpose                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /__applicant_stub/ready`    | `200` `{ "ready": true }` only after the fixed loopback listener accepts requests                                                                                                                                                                    | Wrapper readiness gate                                                    |
| `POST /__applicant_stub/reset`   | Empty request, `204` response                                                                                                                                                                                                                        | Reset synthetic state, faults, and observations                           |
| `POST /__applicant_stub/control` | Strict local control body with one operation (`applications-list`, `users-list`, `schemas-list`, or `assign`) and one status (`401`, `403`, `404`, `409`, `422`, `429`, or `500`), or one malformed-payload selector, or `clear: true`; return `204` | Set one deterministic negative branch without editing process environment |
| `GET /__applicant_stub/evidence` | `200` sanitized JSON only                                                                                                                                                                                                                            | Return the exact observation contract below                               |

The control body grammar is exact:

```text
{ "operation": "applications-list", "status": 500 }
{ "operation": "users-list", "malformed": "missing-activeUsers" }
{ "operation": "schemas-list", "malformed": "hydra-envelope" }
{ "operation": "assign", "status": 422 }
{ "clear": true }
```

`operation` and `status`, `operation` and `malformed`, or `clear` are mutually exclusive forms. The malformed selectors are fixed strings: `missing-hydra-member`, `wrong-hydra-member-type`, `unknown-application-status`, `missing-activeUsers`, `wrong-inactiveUsers-type`, `missing-user-field`, `hydra-envelope`, and `missing-questions`. The status set is exactly `401`, `403`, `404`, `409`, `422`, `429`, or `500`.
Control routes are local test instrumentation. They do not require product auth, do not call a nested service, and do not appear as product API evidence.

### Sanitized evidence schema

The evidence endpoint returns a shape equivalent to:

```json
{
  "seed": "applicant-assignment-0018",
  "requests": [
    {
      "method": "GET",
      "path": "/api/me/profile",
      "query": {},
      "status": 200,
      "auth": "bearer-present",
      "accept": "application/ld+json",
      "response": "user-profile",
      "body": {
        "kind": "object",
        "keys": [
          "id",
          "firstName",
          "lastName",
          "email",
          "phone",
          "department",
          "fieldOfStudy",
          "profilePhoto"
        ]
      }
    },
    {
      "method": "GET",
      "path": "/api/admin/applications",
      "query": {},
      "status": 200,
      "auth": "bearer-present",
      "accept": "application/ld+json",
      "response": "hydra-applications",
      "body": { "kind": "object", "keys": ["hydra:member", "hydra:totalItems"] }
    },
    {
      "method": "GET",
      "path": "/api/admin/users",
      "query": {},
      "status": 200,
      "auth": "bearer-present",
      "accept": "application/ld+json",
      "response": "plain-users",
      "body": { "kind": "object", "keys": ["activeUsers", "inactiveUsers"] }
    },
    {
      "method": "GET",
      "path": "/api/admin/interview-schemas",
      "query": {},
      "status": 200,
      "auth": "bearer-present",
      "accept": "application/ld+json",
      "response": "schema-array",
      "body": { "kind": "array", "keys": ["id", "name", "questions"] }
    },
    {
      "method": "POST",
      "path": "/api/admin/interviews/assign",
      "query": {},
      "status": 204,
      "auth": "bearer-present",
      "accept": "absent",
      "contentType": "application/json",
      "response": "void",
      "body": { "kind": "json", "keys": ["applicationId", "interviewerId", "schemaId"] }
    }
  ],
  "transitions": ["application-assigned:101:201:301"],
  "faults": []
}
```

The sample omits optional unrelated-parent observations. If one occurs, retain its actual loopback `/api/*` path, `status: 404`, `auth: "bearer-present"`, `accept: "application/ld+json"`, `response: "unlisted-api-404"`, and `body: { "kind": "empty" }`; do not treat it as an applicant contract request.

The implementation can add a bounded `revalidation` count or a `decode` label, but it must retain these fields and guarantees:

- request method, path, sanitized query, response status, auth presence, and response-shape label;
- JSON body key names only, never body values;
- the assignment transition using synthetic technical IDs only;
- no token, name, email, question text, raw response body, stack trace, cookie, or credential;
- no request to a non-loopback host;
- no unlisted applicant-seam product API path; an unrelated parent-prefetch `GET /api/*` receives the deterministic non-mutating `unlisted-api-404` response;
- no nested network call.

The browser journey must assert exact body values against the in-memory fixture before sanitization. The attached evidence records only the sanitized body shape. This separates exact contract evidence from sensitive payload retention.

### Malformed and typed fault fixtures

The stub must provide these deterministic bad responses:

- `applications-list` malformed Hydra member type, missing `hydra:member`, or unknown integer `applicationStatus`;
- `users-list` missing `activeUsers`, wrong `inactiveUsers` type, or a user missing a required field;
- `schemas-list` Hydra object instead of an array, or a schema missing `questions`;
- `assign` `422` with a violations body, `404`, `409`, `429`, or `500`. The SDK maps `500` to its typed `NetworkError`; no rejected-fetch simulator is required.

The route must not accept these values as rows, options, or success. The SDK remains the decoding and status authority. The fixture only supplies the input that makes a violation observable.

## Scope and owned paths

### Future mutable paths

The future writer may change exactly these paths:

1. `apps/dashboard/app/routes/dashboard.sokere._index.tsx` — remove route-local fixture/mock-success and duplicate wire casts; load typed applicants/options through the existing server client; map assignment form IDs; preserve delete behavior; expose typed errors; rely on revalidation.
2. `apps/dashboard/app/lib/applicant-view.ts` — optional new route-local pure projection/error helper. The writer must not add this file if the route remains clear without it.
3. `apps/dashboard/e2e/fixtures/applicant-api.ts` — new fixed-port synthetic loopback stub with readiness, reset, control, evidence, fault, and shutdown behavior defined above.
4. `apps/dashboard/e2e/applicant-assignment.spec.ts` — one deterministic non-fixture Playwright journey and its sanitized assertions.

No other implementation path is mutable. In particular, the route writer MUST NOT rewrite the delete flow in the shared route file.

### Read-only dependencies

- accepted `design-specs/0003-effect-v4-receipt-sdk-compatibility.md` and the complete `packages/sdk/**` source, package, generated output, tests, and `legacy-symfony-openapi.snapshot.json`;
- accepted `design-specs/0008-dashboard-receipt-sdk-consumer-seam.md` and its accepted Receipt implementation/evidence contract;
- accepted `design-specs/0010-dashboard-bun-sdk-resolution.md` and the integrated dashboard workspace boundary;
- `/srv/share/projects/vektorprogrammet/docs/product-lead-charter.md` and `docs/agentic-development-lifecycle.md`;
- root `package.json`, `bun.lock`, `turbo.json`, `.githooks/pre-commit`, and all root workspace manifests;
- `apps/dashboard/package.json`, `apps/dashboard/playwright.config.ts`, `apps/dashboard/app/lib/api.server.ts`, and `apps/dashboard/app/lib/auth.server.ts`;
- existing login and Receipt fixtures, existing e2e files, route manifests, root/layout/auth components, and unrelated dashboard routes;
- Symfony/server code, server tests, OpenAPI generation, database/migrations, provider/IaC files, deployment configuration, credentials, and data.

A future writer must not edit a read-only dependency to make this route pass. If an unrelated dependency prevents a cold browser run, record `Drift` and hand off to the owning whole-dashboard or predecessor lane.

## Explicit non-goals

This slice does **not** include:

- any SDK implementation, SDK schema, transport, error, export, package, dependency, or root-lock change;
- any server, Symfony, API Platform, OpenAPI, controller, serializer, authorization, persistence, database, migration, Worker, gateway, or route-manifest change;
- any applicant delete-flow rewrite, delete-error redesign, bulk-delete flow, applicant detail page, application-status redesign, interview scheduling, conducting, cancellation, or response flow;
- any new interview-assignment backend endpoint or claim that the existing backend accepts the request;
- any browser-side API client, raw API fetch, URL interpolation, browser Bearer construction, or token-refresh mechanism;
- any broad dashboard migration, unrelated route cleanup, `apiClient` migration outside the named route, package reconciliation, full-dashboard build/typecheck/lint/install claim, or dashboard deployment claim;
- any change to accepted Receipt paths, Receipt fixture behavior, login fixture behavior, or existing Playwright configuration;
- any domain-law change, tutor event cancellation, D1/event persistence, Doctrine replay, H1/H2/H3 security implementation, public content, scheduling UI, or Identity/authorization bounded-context replacement;
- any provider, Cloudflare, Alchemy, Wrangler, Railway, DNS, remote state, public route, credentials, production data, production traffic, publication, release, operator action, or route cutover;
- any source-rights, PII inventory, provider parity, performance, availability, retry, distributed-coordination, or production rollback claim;
- a new generic dashboard data layer, shared option cache, route-wide error framework, or other mechanism beyond this seam contract.

The broader dashboard cutover remains the accepted `0010` umbrella boundary. Reopening it to make this route pass is scope failure, not a valid fix.

## Dependencies, conflicts, and blocked alternatives

### Dependency graph

```text
product charter + lifecycle authority
  → accepted 0003 SDK Promise/Schema/error seam (read-only)
  → accepted 0008 consumer seam pattern (read-only)
  → accepted 0010 integrated Bun/workspace dashboard boundary (read-only)
  → historical SDK unknown-status dependency Drift `D-0018-SDK-1`, closed by accepted 0019 typed return and canonical 25e rerun
  → 0018 implementation, local browser evidence, visual evidence, and canonical 0019 return evidence complete; current lifecycle `Building` pending the frozen/open one-to-one PR gate
  → one route writer from base a8dafe618907dfd623718802fdaf5712d55f70d4
  → current applicant route + optional pure helper
  → fixed loopback stub + one Playwright journey
  → typed SSR, auth, decode, assignment, revalidation, and cleanup evidence
  → later independently specified backend or route cutover
```

### Dependency and conflict table

| Item                                                                      | State                                                                                                                                                                                                                                                                                                                                     | Required treatment                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted `0003` SDK seam                                                  | Accepted and immutable                                                                                                                                                                                                                                                                                                                    | Consume methods and schemas exactly. Do not add aliases or weaken decoding.                                                                                                                  |
| Accepted `0008` consumer pattern                                          | Accepted predecessor pattern                                                                                                                                                                                                                                                                                                              | Reuse SSR/auth/error/evidence boundaries. Do not edit Receipt paths.                                                                                                                         |
| Accepted `0010` cutover                                                   | Integrated umbrella authority                                                                                                                                                                                                                                                                                                             | Consume workspace/Bun resolution. Do not claim or reopen whole-dashboard success.                                                                                                            |
| Accepted `0010` residue and unknown status                                | 0010 has a separately recorded `Conforming` state; 0018 does not inherit it. The base route residue remains with the consumed 0010 capsule. The unknown raw status was a historical non-`SdkError` ordinary `Error`; accepted 0019 repaired the typed channel and the canonical 25e rerun preserved the visible fail-closed route result. | `D-0018-SDK-1` is **Closed**: owner and return completed by accepted 0019 through typed Promise/Effect evidence, canonical rerun, and product-lead disposition. Do not edit the SDK in 0018. |
| Root workspace, `bun.lock`, and app manifest                              | Shared read-only resources. Base lock is `ee978425937c78658cce31b76d667e01e8d082321b6d809cb09e64e217936514`; integrated accepted-0017 lock is `90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a`.                                                                                                                         | Only accepted 0017 changed the lock before/alongside integration. The 0018 chain changed no lock path; `E-0018-12` is satisfied for this boundary.                                           |
| `api.server.ts` and `auth.server.ts`                                      | Shared SSR/auth seam                                                                                                                                                                                                                                                                                                                      | Read-only. Do not duplicate or redesign it.                                                                                                                                                  |
| Login fixture `8788` and Receipt fixture `8787`                           | Existing unrelated fixtures                                                                                                                                                                                                                                                                                                               | Read-only. Applicant fixture uses `8789`.                                                                                                                                                    |
| Existing Playwright config                                                | Shared harness                                                                                                                                                                                                                                                                                                                            | Read-only. Do not add web servers, env mutation, or random ports.                                                                                                                            |
| Applicant route                                                           | This spec's only existing product path                                                                                                                                                                                                                                                                                                    | One writer owns it. Delete behavior remains outside the assignment change.                                                                                                                   |
| E2E fixture and spec paths                                                | New paths reserved for this slice                                                                                                                                                                                                                                                                                                         | No second applicant writer or overlapping fixture contract.                                                                                                                                  |
| 0017 D1 lane                                                              | Separate canonical persistence lane at the named 0017 spec and commits                                                                                                                                                                                                                                                                    | It does not share 0018 paths or lock ownership. Do not broaden this route seam or rename either live spec.                                                                                   |
| Tutor event, current-line security, public content, and persistence lanes | Separate lanes                                                                                                                                                                                                                                                                                                                            | They do not block this local route seam unless they claim a shared mutable path or their authority conflicts.                                                                                |
| Unrelated dashboard diagnostics or routes                                 | Existing integration drift may remain                                                                                                                                                                                                                                                                                                     | Do not edit them. If they block route startup, enter `Drift` and hand off.                                                                                                                   |

### Blocked alternatives

- Tutor `InterviewCancelled` is not this journey. Its current tracer is in-memory and not user-facing. A successor command, event, projection, and effect contract is not accepted here.
- Current-line security work remains owner- and operator-bound. This spec does not implement H1, H2, or H3 security decisions.
- Public content remains a separate source, rights, image, and access boundary. It does not provide applicant data authority.
- D1 or other persistence work requires a separate context decision and evidence. This spec changes no persistence.
- A new SDK seam is unnecessary. Accepted `0003` and `0010` already expose the required methods. Adding transport machinery would broaden the change without improving the felt journey.

## Verification and evidence plan

Every evidence item names one claim and one limit. The canonical implementation agents recorded the local browser evidence, and the visual reviewers accepted the complete artifact set. A future one-to-one PR may attach these artifacts after its frozen-spec gate; no PR exists now.

| ID          | Future artifact or scenario                                                             | Claim verified                                                                                                                                                                                                                                                             | Limit                                                                                |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `E-0018-0`  | Base, worktree, branch, and changed-path review                                         | Writer starts from exact base and mutates only the capsule                                                                                                                                                                                                                 | Does not prove unrelated repository cleanliness                                      |
| `E-0018-1`  | Missing-`API_URL` route preflight with zero stub requests                               | SSR configuration fails typed and visibly before transport                                                                                                                                                                                                                 | Does not prove any external service                                                  |
| `E-0018-2`  | Stub request evidence for initial load                                                  | Parent profile plus the three route loader calls use server-side SDK methods, Bearer auth, strict response shapes, and no browser API request                                                                                                                              | Does not prove backend authorization or parity                                       |
| `E-0018-3`  | Browser filter and stub query evidence                                                  | Existing `Nye` interaction triggers the SDK-backed status query                                                                                                                                                                                                            | Does not prove server filter semantics                                               |
| `E-0018-4`  | Browser option assertions and response-shape evidence                                   | Eligible active users and strict schema array reach the existing dialog                                                                                                                                                                                                    | Does not prove real user or schema records                                           |
| `E-0018-5`  | Assignment request evidence                                                             | SDK receives numeric IDs and sends exact `POST` body and `204` contract                                                                                                                                                                                                    | Does not prove assignment persistence or backend acceptance                          |
| `E-0018-6`  | Request sequence and browser row after assignment                                       | Route revalidation supplies the assigned interviewer                                                                                                                                                                                                                       | Does not prove distributed consistency or production runtime                         |
| `E-0018-7`  | Typed 401/403 and missing-cookie branches                                               | API expiry and missing-cookie redirects remain distinct                                                                                                                                                                                                                    | Does not prove an auth provider or refresh flow                                      |
| `E-0018-8`  | Typed 404/409/422/429/500/network/config/decode branches and unknown-status observation | Known malformed values remain visible and never become empty-success fallbacks. Accepted 0019 now returns typed Promise/Effect validation failures, and the canonical 25e rerun records the exact refined alert and zero rows with no raw value. `D-0018-SDK-1` is closed. | Does not prove retry or availability semantics                                       |
| `E-0018-9`  | Browser request log and source review                                                   | No browser raw product API fetch, URL interpolation, local wire cast, or fixture-mode success path remains in owned behavior                                                                                                                                               | Does not prove unrelated route cleanup                                               |
| `E-0018-10` | Sanitized `__applicant_stub/evidence` response                                          | Methods, paths, query, response shape, Bearer presence, body keys, transition, and cleanup are observable without secrets or PII                                                                                                                                           | Does not prove raw payload correctness beyond the fixture's exact internal assertion |
| `E-0018-11` | Stub shutdown, environment restoration, generated-output cleanup                        | Local journey is bounded and reversible                                                                                                                                                                                                                                    | Does not prove remote rollback because no remote action exists                       |
| `E-0018-12` | Final changed-path, lock, and Drift review                                              | The four 0018 paths are the only 0018-owned changes; base/integrated lock hashes are recorded; accepted 0017 alone changed the lock; accepted 0019 closed `D-0018-SDK-1`; no implementation-owned blocking Drift remains                                                   | Does not prove a full dashboard build or deployment                                  |

### Evidence destination

The canonical browser journey and local evidence are recorded by `agent://Canonical1718RuntimeVerify` at canonical `c46104776106cbdfe72789fec64a80d54c4d79d1`. `agent://ApplicantAssignmentRuntimeReverify0018` records the source-candidate browser/type evidence. `agent://ApplicantAssignmentFinalVerify0018` is scoped to the `3ab30e7` source-candidate fixture smoke, typecheck, and cleanup. `agent://ApplicationStatusRuntimeVerify0019` reran the unchanged 0018 branch at SDK head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`. Evidence includes the fixed loopback `127.0.0.1:8789`, configuration preflight, main assignment/revalidation journey, typed fault observations, forbidden browser product-path assertions, exact refined alert, zero rows, no raw value, zero product requests, and clean stub shutdown. The recorded typecheck has exactly six unrelated dashboard diagnostics and zero diagnostics in the four 0018 paths.

Visual evidence is retained at `/tmp/mono-web-dashboard-applicant-assignment-evidence-0018-20260811/`: before/after PNGs, `interaction.webm`, `manifest.json`, and `README.txt` with the byte sizes and SHA-256 values recorded in Metadata. `agent://ApplicantVisualUXReview0018` and `agent://ApplicantVisualArtifactReview0018` both passed. Media was captured against pre-closure spec SHA-256 `28eb520d125ede622011d684795357e73d0ecbd5d6fe128e78d1755a064c05ee`; 0019 did not change the four UI-owned paths.

Structured stub and trace evidence remains sanitized. It can contain methods, paths, sanitized queries, statuses, response-shape labels, body-key names, Bearer-presence booleans, and synthetic technical IDs only. It must not contain names, emails, token or cookie values, raw payloads, network headers or payloads, real PII, credentials, or production data.

**Product-lead-reviewed visual boundary:** before a one-to-one PR opens, attach before and after screenshots and a recording. Visuals may show only fixed synthetic fixture display labels and product labels, and may additionally show synthetic `@example.invalid` fixture addresses. Visuals must exclude real email addresses, token/cookie values, network headers/payloads, real PII, credentials, and production data.

Sanitized artifacts may remain in `/tmp/mono-web-dashboard-applicant-assignment-evidence-0018-20260811/` during handoff, then move to the one-to-one PR Evidence section. No raw token, cookie, PII, response payload, provider output, or generated browser cache enters the repository.

## Counterexamples and falsifiers

Any item below fails this slice even if the happy-path browser assertions pass:

1. The browser route or dialog directly calls raw `fetch` for `/api/me/profile`, `/api/admin/users`, `/api/admin/interview-schemas`, or another product API endpoint.
2. The browser constructs an API URL, a Bearer header, an SDK substitute, or route-owned API `FormData`.
3. A named product request receives no Bearer header, records the token, contacts a non-loopback host, performs nested fetch, or leaves an in-flight listener/timer after shutdown.
4. The loader keeps `isFixtureMode`, inline mock-success, a local wire type, an unchecked cast, or `catch → []` in the owned applicant behavior.
5. A malformed Hydra collection, unknown application status integer, malformed user, malformed schema array, or missing required field reaches a row, option, or successful action.
6. The route accepts a Hydra envelope for `/api/admin/interview-schemas` instead of consuming the accepted SDK array, or it weakens the SDK schema to fit OpenAPI drift.
7. `API_URL` is absent or invalid and the operation uses a default, Railway, browser URL, or another non-explicit destination.
8. A missing cookie does not redirect to `/login`, or API `401`/`403` does not redirect exactly to `/login?expired=true`.
9. Validation, conflict, not-found, rate-limit, network, configuration, or decode failure disappears into an empty table, empty option list, generic success, or unbounded retry.
10. The assignment uses the wrong method, path, field name, field type, or body; sends `interviewSchemaId` to the SDK instead of the accepted `schemaId` argument; parses a body from `204`; or invents a new SDK method.
11. The action reports success but React Router does not revalidate the applicant loader, or the changed interviewer exists only in optimistic local state.
12. Existing Norwegian labels, route URL, status filters, dialog controls, table columns, or successful interaction change without a product-lead-reviewed intent.
13. The writer changes the delete flow, SDK, server, OpenAPI, root lock, app manifest, Playwright config, Receipt/login fixtures, unrelated routes, or provider files.
14. Evidence includes a token, cookie, real or unnecessary PII, raw payload, stack trace, credential, production host, provider output, or an unbounded external effect.
15. The future PR claims a full dashboard build, broad typecheck, backend/API parity, provider/deployment success, production data, route cutover, or production acceptance.
16. A writer resolves a source or shared-resource conflict by editing the easiest file instead of entering `Drift`.

## Definition of done

The one future implementation PR is done only when all conditions below are objectively recorded:

1. The writer started from `a8dafe618907dfd623718802fdaf5712d55f70d4` after this spec passed independent review and product-lead acceptance. The final changed-path set contains only the current applicant route, optional pure helper, applicant stub, and applicant Playwright spec.
2. The accepted SDK, server helper, auth helper, OpenAPI, root package/lock, Playwright config, Receipt/login fixtures, delete flow, and unrelated routes remain read-only.
3. The route has no owned `isFixtureMode` applicant success path, inline mock rows, duplicate SDK wire type, unchecked cast, raw API URL, browser product fetch, or `catch → []` behavior.
4. The loader uses `API_URL`, the existing cookie auth helper, `admin.applications.list(status?)`, `admin.users.list()`, and `admin.interviews.schemas()`. A missing or invalid configuration fails visibly before any request.
5. SDK response decoding remains strict for Hydra applications, plain users, and the schema array. Eligible active roles render. Inactive and ineligible users do not render. Malformed or unknown values remain visible typed failures.
6. The existing `Søkere` route, Norwegian product text, filters, table, dialog, form intent, and successful interaction remain intact.
7. The action parses numeric IDs and calls only `admin.interviews.assign(applicationId, interviewerId, schemaId)`. The stub observes exact `POST /api/admin/interviews/assign`, exact numeric body, Bearer presence, and bodyless `204`.
8. A successful assignment triggers route revalidation. The browser observes a subsequent applicant list request and sees `Intervjuer Test` in the revalidated row.
9. API `401`/`403` redirects exactly to `/login?expired=true`. Missing-cookie `/login`, configuration, validation, conflict, not-found, rate-limit, network, and decode failures are visibly distinct from empty success.
10. One cold non-fixture Chromium journey runs against fixed loopback `127.0.0.1:8789`, after readiness, with `CI=1`, retries `0`, synthetic auth, reset/control/evidence calls, no browser raw API fetch, deterministic fault branches, and bounded shutdown.
11. Sanitized evidence records methods, paths, query, response status/shape, Bearer presence, body keys, assignment transition, and cleanup. It contains no token, cookie, names, emails, question text, raw payload, PII, credentials, provider output, or production host.
12. The future PR makes no SDK, backend, provider, deployment, production, persistence, broad-dashboard, or full-build claim. No implementation-owned blocking Drift remains. `D-0018-SDK-1` is closed by accepted 0019; 0018 does not re-claim the consumed 0010 capsule.

## Rollout, rollback, and cleanup

### No rollout

This spec has no release, deployment, route cutover, or operating phase. It produces local consumer evidence only. A later accepted spec owns backend replacement, route cutover, operator authority, rollout, and production rollback.

### Rollback

- If rollback is required, discard or revert only the named applicant route/helper/stub/e2e changes in the implementation branch. Do not touch SDK, server, root lock, Receipt, login, or unrelated paths.
- If a config, auth, SDK boundary, browser, typed-error, decode, assignment, or revalidation observation fails, stop and record `Drift`. Do not broaden the capsule to repair the SDK, backend, or dashboard.
- The stub assignment mutates only in-memory synthetic state. Reset it, stop the process, await in-flight requests, and remove local output. No remote data cleanup exists.
- If an operator or runtime effect is discovered, stop before the effect and request product-lead/operator disposition. This spec grants no standing authority.
- A later production or route rollback belongs to the later accepted route or backend spec. This slice is not rollback authority for a deployed system.

## Lifecycle gates and Drift

- **Specified — prior authoring state.** This spec named one felt journey, current behavior, intended boundary, exact authority paths and hashes, dependencies, conflicts, owned paths, non-goals, evidence, falsifiers, rollback, and future capsule.
- **Ready — historical and completed.** Independent review and product-lead intent acceptance were recorded at the reviewed HEAD before implementation.
- **`Building` — current.** The four-path implementation, local browser evidence, visual evidence, and canonical 0019 return rerun are complete at canonical final head `ab95b5d36f515d1b60945b9d77a17a7519281493` plus SDK head `25eeb27b7f2f4c35760d8c3fb1c6fa5f86bf854f`; `D-0018-SDK-1` is closed. No frozen/open one-to-one PR exists.
- **Experienceable — not entered.** It requires the lifecycle authority's frozen/open one-to-one PR and complete objective evidence attached to that PR.
- **Conforming — not entered and not claimed.** It is forbidden without the PR gate and blind-first independent verification.
- **Release-ready / Operating — not entered and not implied.** No deployment, public route, route cutover, production data, provider action, or operator authority belongs to this slice.

### Drift log

| ID             | Observation                                                                                                                                                                                                                                   | Owner and return path                                                                                                                                                                                       | Lifecycle effect                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `D-0018-SDK-1` | Historical pre-0019 observation: `packages/sdk/src/adapter/status.ts` exposed a non-`SdkError` ordinary `Error` for an unknown `applicationStatus` integer; the 0018 route failed closed with the visible list error and zero applicant rows. | **Owner and return completed:** accepted 0019 typed the Promise/Effect channels, canonical 25e reran the unchanged 0018 branch at SDK `25e`, and product-lead disposition accepted closure on `2026-08-12`. | **Closed.** No open implementation or dependency Drift remains. A new authority or runtime disagreement creates a new Drift entry. |

### Drift path

A new conflict among this spec, accepted `0003`, accepted `0008`, accepted `0010`, lifecycle, charter, SDK source, route source, OpenAPI, fixture observation, dependency resolution, or browser runtime is recorded with:

1. the conflicting paths and frozen hashes;
2. the exact observation and scenario;
3. the owner of the conflicting authority;
4. the evidence that would resolve it;
5. a proposed return to `Specified` for intent change or `Building` for implementation-only correction.

The writer notifies the product lead and feature lead. The writer does not edit an authority to remove the conflict.

## Historical future task capsule and current handoff

The table below is the historical bounded implementation capsule. Its four-path implementation and local browser evidence are complete on canonical `ab95b5d36f515d1b60945b9d77a17a7519281493`, but no frozen/open one-to-one PR exists.

| Capsule field                | Current handoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spec ID/path                 | `0018`; `design-specs/0018-dashboard-applicant-assignment-sdk-seam.md`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Role/objective               | Historical `ApplicantAssignmentConsumerImplementer` capsule: migrate only the `Søkere` assignment seam to accepted server-side SDK methods and produce one local non-fixture browser journey with typed auth/config/decode/error/revalidation evidence.                                                                                                                                                                                                                                                |
| Source/canonical provenance  | Source candidate `3ab30e7f2e304e228a89b9108da50d078e8bd603` (parent `89f3b0cfe080ef196d89ae55e4f70eb6fa619619`) → canonical integration `c46104776106cbdfe72789fec64a80d54c4d79d1` (parent `2d8e8a6c4435a7fb627f45e65ce178979f7688dd`) → final `ab95b5d36f515d1b60945b9d77a17a7519281493` (parent `beff9154e8efb94c641b6cd6f8d65384ae0110f8`).                                                                                                                                                         |
| Base/worktree                | Exact base `a8dafe618907dfd623718802fdaf5712d55f70d4`; historical worktree `/tmp/mono-web-dashboard-applicant-assignment-impl-0018-20260811`; branch `impl/0018-dashboard-applicant-assignment-sdk-seam`.                                                                                                                                                                                                                                                                                              |
| Changed paths                | Exactly `apps/dashboard/app/routes/dashboard.sokere._index.tsx`, `apps/dashboard/app/lib/applicant-view.ts`, `apps/dashboard/e2e/fixtures/applicant-api.ts`, and `apps/dashboard/e2e/applicant-assignment.spec.ts`. The final `ab95` commit changes only the fixture terminal newline.                                                                                                                                                                                                                 |
| Forbidden paths              | SDK source/package/tests/generated output/OpenAPI, server/OpenAPI, auth helpers, root/app manifests, `bun.lock`, Playwright config, login/Receipt fixtures, delete behavior, unrelated routes, provider/IaC, credentials, data, and deployment files.                                                                                                                                                                                                                                                  |
| Lock disposition             | Base `bun.lock` SHA-256 `ee978425937c78658cce31b76d667e01e8d082321b6d809cb09e64e217936514`; integrated accepted-0017 SHA-256 `90b279eea3909c0ab0d32f2097a4f6f1055472007b72f096bd4185c11e10d70a`. Only accepted 0017 changed the lock before/alongside integration; 0018 changed no lock path.                                                                                                                                                                                                          |
| Drift disposition            | `D-0018-SDK-1` is **Closed** through accepted 0019 typed return, canonical 25e rerun, independent review, integration mapping, and product-lead acceptance. The exact refined alert, zero rows, and no-raw-value result remain recorded; no open implementation-owned Drift remains.                                                                                                                                                                                                                   |
| Browser evidence             | PASS at fixed loopback `127.0.0.1:8789`: canonical browser journey and local evidence by `agent://Canonical1718RuntimeVerify` at `c46104776106cbdfe72789fec64a80d54c4d79d1`; source-candidate browser/type evidence by `agent://ApplicantAssignmentRuntimeReverify0018`; source-candidate fixture smoke/typecheck/cleanup by `agent://ApplicantAssignmentFinalVerify0018`.                                                                                                                             |
| Review evidence              | PASS: `agent://ApplicantAssignmentCodeRecheck0018` and `agent://Canonical1718CodeReview`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Typecheck boundary           | Exactly six unrelated dashboard diagnostics remain; zero diagnostics occur in the four 0018 paths. This is not a full-dashboard typecheck claim.                                                                                                                                                                                                                                                                                                                                                       |
| Structured evidence boundary | Stub/trace evidence contains only sanitized methods, paths, queries, statuses, response shapes, body keys, Bearer presence, and synthetic technical IDs. It excludes names, emails, token/cookie values, raw payloads, network headers/payloads, real PII, credentials, and production data.                                                                                                                                                                                                           |
| Visual evidence              | PASS — complete artifact set at `/tmp/mono-web-dashboard-applicant-assignment-evidence-0018-20260811/`, with `before.png`, `after.png`, `interaction.webm`, `manifest.json`, and `README.txt` identities and hashes recorded in Metadata; visual review PASS by `agent://ApplicantVisualUXReview0018` and `agent://ApplicantVisualArtifactReview0018`. Captured against pre-closure spec SHA-256 `28eb520d125ede622011d684795357e73d0ecbd5d6fe128e78d1755a064c05ee`; UI-owned paths unchanged by 0019. |
| Operator authorization       | None needed or permitted. Any external effect requires a separate lifecycle-scoped operator record and a new accepted scope.                                                                                                                                                                                                                                                                                                                                                                           |

### Required handoff contents

Before the one-to-one PR opens, the feature lead receives a sanitized record containing:

1. the docs/spec commit, source candidate, canonical integration, final head, parents, base, branch, and worktree;
2. the exact four-path changed set and proof that `bun.lock` remained unchanged by 0018;
3. the configuration preflight, fixed viewport and loopback port, readiness, main/failure outcomes, and clean shutdown;
4. the sanitized stub evidence and local browser evidence agents;
5. the six unrelated typecheck diagnostics and zero diagnostics in 0018 paths;
6. the closed `D-0018-SDK-1` entry, the completed accepted-0019 owner/return path, canonical 25e rerun, and fail-closed unknown-status observation;
7. the before/after screenshots and recording, limited to fixed synthetic fixture display labels, product labels, and synthetic `@example.invalid` fixture addresses;
8. explicit no-SDK, no-server, no-lock, no-provider, no-remote, no-credential, no-PII, no-production, no-deployment, and no-route-cutover changes.

The current lifecycle remains `Building` until the feature lead freezes the spec and opens the one-to-one PR. It is not `Experienceable` or `Conforming`; no future PR evidence may claim those states before their lifecycle gates.

## Authoring boundary

This spec commit changes only `design-specs/0018-dashboard-applicant-assignment-sdk-seam.md`. It records implementation, local browser evidence, completed visual evidence, canonical 0019 return evidence, and `D-0018-SDK-1` closure at named canonical commits, but grants no provider, remote, credential, deployment, backend, PII, production, `Experienceable`, or `Conforming` authority.
