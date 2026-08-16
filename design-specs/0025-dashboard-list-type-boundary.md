# Design spec 0025 — dashboard list type boundary

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0025` |
| Goal | Goal-1 root type-gate coverage and six dashboard list-loader repairs |
| Status | **Specified** — frozen for one implementation journey; no implementation or parity claim |
| Created | `2026-08-16` |
| Exact base | `71c3f9934abf52772faeaa98293b4c374a98fa89` |
| Specification worktree | `/tmp/mono-web-type-gate-spec-0025` |
| Specification branch | `spec/0025-dashboard-list-type-boundary` |
| Maintainer journey | One clean-checkout maintainer journey |
| Implementation worktree | `/tmp/mono-web-type-gate-impl-0025` |
| Implementation branch | `impl/0025-dashboard-list-type-boundary` |
| Provider authority | None |
| Production authority | None |
| Acceptance authority | The product lead and the lifecycle records; this specification makes no acceptance claim |
| Mutable implementation paths | Eleven paths: six list routes, three package manifests, the live dashboard README, and one focused behavior test in §6 |
| Out-of-capsule authorities | SDK and domain source, root manifest, root lock, Turbo graph, 0024 inventory until its C1/C3 capability exists, provider configuration, production data, historical specs, and unrelated dashboard routes |

This specification freezes one bounded Goal-1 problem. It does not implement the problem.
It does not change the SDK, domain package, API, backend, provider, production data, route ownership, or parity inventory.
It does not claim that the dashboard matches the legacy application.

The implementation writer must use the exact base and branch above. The writer must use one clean checkout.
A passing type gate proves TypeScript coverage only. A synthetic browser result proves only the named local view journey.
Neither result proves functional parity, authorization parity, backend parity, release readiness, deployment, or production behavior.

## 1. Frozen problem and observed failures

The repository has one root task named `check-types`:

```json
"check-types": "turbo check-types"
```

The Turbo task runs package scripts with the same name. Turbo does not discover a package script named `typecheck`.
React Router route modules also require generated `+types` declarations before `tsc` can type-check them.

The following observations are the current baseline evidence. The specification writer does not rerun them.

### 1.1 Root type-gate failure

After a clean frozen install, the observed command was:

```sh
bun run check-types
```

The command failed in `@monoweb/homepage` because `apps/homepage/package.json` contains:

```json
"check-types": "tsc --noEmit"
```

The command does not run `react-router typegen` first. The generated route declarations do not exist in a fresh checkout.
The observed TypeScript failures are the missing generated modules imported by these homepage route modules:

```text
apps/homepage/src/routes/_home.kontakt.$department.tsx
  TS2307: Cannot find module './+types/_home.kontakt.$department' or its corresponding type declarations.

apps/homepage/src/routes/_home.team.$department.tsx
  TS2307: Cannot find module './+types/_home.team.$department' or its corresponding type declarations.
```

This is a package-script ordering failure. It is not permission to commit generated route types.
Both homepage and dashboard `tsconfig.json` files already use `noEmit: true`.

### 1.2 Turbo discovery failure

The observed dashboard manifest contains:

```json
"typecheck": "react-router typegen && tsc"
```

It does not contain a `check-types` script. The root `bun run check-types` therefore skips `@monoweb/dashboard`.
A green root result under this manifest would not cover the dashboard.

The required cutover is a script-key rename, not an alias. The dashboard must expose one `check-types` script and must not retain `typecheck`.

### 1.3 Six direct dashboard diagnostics

The observed direct command was:

```sh
bun run --cwd apps/dashboard typecheck
```

It reported diagnostics in exactly these six list route modules:

| Route module | Observed source mismatch | SDK-owned fact that must replace it |
|---|---|---|
| `dashboard.assistenter._index.tsx` | The local row requires `school` and `phone`. The loader returns the scheduling collection result. | `admin.scheduling.assistants()` returns `{ items, totalItems }` with `SchedulingAssistant` fields. |
| `dashboard.epostliste._index.tsx` | The local row has one invented `email` field per list entry. | `admin.mailingLists()` returns an array of `{ name, emails: string[] }`. |
| `dashboard.intervjuer._index.tsx` | The local row requires `applicant`, `interviewer`, `date`, and `status`. The loader receives a paginated result. | `admin.interviews.list()` returns `{ items, totalItems }` with `Interview` fields. |
| `dashboard.skoler._index.tsx` | The local row requires scalar `capacity` and `assistantCount`. | `admin.scheduling.schools()` returns `{ items, totalItems }`; each school has `capacity: Array<Record<string, number>>`. |
| `dashboard.teaminteresse._index.tsx` | The loader calls nonexistent `admin.teamInterest()` and the local row requires `semester`. | `admin.teams.interest()` returns `{ items, totalItems }` with `TeamInterest` fields `userName` and `teamName`. |
| `dashboard.vikarer._index.tsx` | The local row requires `phone` and fabricated `status`. | `admin.scheduling.substitutes()` returns `{ items, totalItems }` with email, year, language, and weekday facts. |

The six diagnostics are not a reason to use a broad array guard. The accepted source object `ac316022d0c92615645986e8fe9a4c521f22b186` used the following unsafe pattern in these routes:

```ts
Array.isArray(response) ? response : response.items
```

That pattern is forbidden here. It widens two different response contracts and can conceal a row-shape mismatch.
A successful compile after this pattern is not evidence that the view uses the SDK schema honestly.

The same source object changed team interest to `admin.teams.list()` and wrote `semester: "fixture"`.
That patch is also forbidden. The team-interest method is `admin.teams.interest()`, and the SDK has no semester field for this row.

The current routes also catch failures and return `null`, then pass `null ?? []` to the table.
That turns a typed failure into an empty success. The implementation must remove that behavior.

### 1.4 SDK declaration edge

The current `packages/sdk/package.json` exports `dist` declarations and runtime files.
It has `build: tsc -b`, but it has no `check-types` script.
The root Turbo task depends on `^check-types`, so the SDK has no declared type-gate edge before its consumers.
The final root task must create the SDK `dist` output through the SDK package `check-types` task.
The writer must not pre-build or assume an existing SDK `dist` directory.

## 2. Goal and non-goals

### 2.1 Goal

Make the root `check-types` task cover both React Router applications from a clean checkout.
Repair the six named list routes so that each loader and view uses the current SDK result without unsafe widening or fabricated fields.

The route boundary must use the existing authenticated Promise client from `app/lib/api.server.ts`.
The route owns the view projection. The SDK owns transport, decoding, pagination containers, status conversion, and typed failures.

### 2.2 Non-goals

The implementation must not:

- change `packages/sdk/src/**`, `packages/domain/**`, or any SDK schema, domain, transport, endpoint, status mapping, or error type;
- change `packages/sdk/package.json` except adding the exact `check-types: tsc -b` script in §4.1;
- change the root `package.json`, `bun.lock`, `turbo.json`, or React Router configuration;
- edit the 0024 parity inventory in this capsule; §5 is the frozen 0025 accounting record and names a downstream 0024 obligation;
- edit historical specifications, including 0010 and 0018, to rewrite their recorded evidence; only the live dashboard README is in this capsule;
- claim final legacy parity or remove legacy expectations;
- repair unrelated dashboard routes or old type errors;
- add a browser raw API client, a second data source, a second route owner, or a compatibility alias;
- use a provider, production host, credential, database, remote state, or production data;
- fix Playwright-wide flakiness or change the browser harness;
- publish, deploy, release, or perform another external action.

## 3. Authority map

| Concern | Sole authority | Required use | Forbidden substitute |
|---|---|---|---|
| Available row facts | Current SDK schemas under `packages/sdk/src/schemas/**` and the named SDK domain methods | Use the exact decoded fields and result containers | Legacy row types, stale mocks, OpenAPI-only guesses, casts, or inferred fields |
| Collection containers | The return types of `admin.scheduling.assistants`, `admin.scheduling.schools`, `admin.scheduling.substitutes`, `admin.interviews.list`, and `admin.teams.interest` | Read `.items` from the typed page result | `Array.isArray`, union widening, or treating a page as an array |
| Mailing-list shape | `packages/sdk/src/schemas/common.ts:MailingList` and `admin.mailingLists()` | Flatten each actual `emails[]` member | One invented email, first-email selection, or an empty synthetic member |
| Team-interest method | `packages/sdk/src/domains/admin/teams.ts:AdminTeamsDomain.interest` | Call `client.admin.teams.interest()` | `client.admin.teams.list()`, nonexistent `admin.teamInterest()`, or a fixture semester |
| View projection | Each named route module | Map only accepted source facts to visible row fields | Reusing a legacy row type that demands unavailable fields |
| Legacy parity expectations | The frozen 0025 accounting record in §5; after 0024 C1 API rows and C3 coverage capability exist, the 0024 owner derives its own rows | Preserve every missing legacy fact as `uncovered` in the downstream inventory | Treating omission from this view as parity, or editing 0024 from this capsule |
| SDK type edge | `packages/sdk/package.json` and Turbo's `^check-types` dependency | Run the SDK `check-types: tsc -b` task before the dashboard consumes its `dist` exports | A manually pre-built `dist`, a direct app command, or a second SDK build authority |
| Type-gate task name | Root `package.json`, `turbo.json`, and the three package manifests | Keep the root task `check-types` and expose that key in SDK, homepage, and dashboard | A package-only `typecheck` task, alias, or root task change |
| Generated route declarations | React Router `typegen` invoked by each app's `check-types` script | Generate declarations before each app's `tsc` in the disposable worktree | Committed generated output or a pre-generated checkout assumption |
| Local browser observation | The one named focused behavior test and its loopback synthetic fixture | Observe the six URLs through the SDK with schema-shaped synthetic data | Fixture-only array shortcuts, real data, external hosts, or a browser-side second transport |
| External effects | A separate operator authority record | Stop before any provider, production, credential, or remote action | This specification, a test, or an implementation assumption |

The SDK and the 0024 inventory have different authority roles.
The SDK says which facts are available now. The inventory says which legacy expectations still require accounting.
Neither authority can silently replace the other.

## 4. Exact contract

### 4.1 Package-script cutover

The implementation must make these exact manifest changes.

#### Homepage

In `apps/homepage/package.json`, replace the current value:

```json
"check-types": "tsc --noEmit"
```

with this single command:

```json
"check-types": "react-router typegen && tsc"
```

Keep the existing homepage `tsconfig.json` with `noEmit: true`.
Do not add a separate `typegen` script or a second type-check script.

#### Dashboard

In `apps/dashboard/package.json`, rename the current key:

```json
"typecheck": "react-router typegen && tsc"
```

into this exact key and value:

```json
"check-types": "react-router typegen && tsc"
```

Delete the `typecheck` key. Do not add a `typecheck` alias.

#### SDK package

In `packages/sdk/package.json`, add this one package task:

```json
"check-types": "tsc -b"
```

The SDK `check-types` task is the only new SDK type-gate entry.
Keep the existing SDK `build` script and all SDK source unchanged.
Turbo's existing `^check-types` dependency must run this task before the dashboard task consumes the SDK exports.
The task writes disposable `dist` output for the workspace exports.

#### Root task

Keep the root command unchanged:

```json
"check-types": "turbo check-types"
```

Turbo must schedule `@vektorprogrammet/sdk` through `^check-types` before the dashboard consumes its `dist` exports, then discover and run both `@monoweb/homepage` and `@monoweb/dashboard` through their shared `check-types` task.
No root graph, lock, dependency, or generated-file change is part of this contract.

### 4.2 Loader failure rule

Every named loader must preserve a typed SDK failure as a visible route failure.
The loader must not catch a failure and return `null`, `[]`, mock rows, a generic success object, or another empty table.

A nullable field in a successful SDK row remains nullable. The view can show an explicit unavailable state for that field.
That display state is not a value and must not be used to claim success, availability, a person, a date, a status, a phone number, or a semester.

The implementation must not use:

- `Array.isArray` to accept both page and array responses;
- `as any`, `as unknown as`, or a cast from an SDK result into a legacy row;
- a local duplicate schema that weakens an SDK field;
- `?? []` or `?? null` as a failure path;
- a fallback fixture that renders after a real SDK error;
- a fabricated string such as `"fixture"` for an absent field.

### 4.3 View-row mappings

The following mappings are frozen. A row can omit an accepted field only as a deliberate display choice.
It must never display a field that is absent from the named SDK result.

#### Assistants — `/dashboard/assistenter`

| Item | Contract |
|---|---|
| SDK call | `client.admin.scheduling.assistants()` |
| SDK result | `{ items: SchedulingAssistant[]; totalItems: number }` |
| Row source | Use the typed `result.items`. Do not accept a raw array branch. |
| Row fields | `id`, `name`, `email`, `doublePosition`, `preferredGroup`, `availability`, `score`, `suitability`, `previousParticipation`, and `language` |
| Display rule | Preserve nullable values and the boolean record `availability`. Use no school, phone, assistant status, or inferred placement field. |
| Forbidden fields | `school`, `phone`, and any value derived from a legacy assistant mock |

`availability` is a `Record<string, boolean>`. If the view summarizes it, sort actual keys and display actual boolean values.
Do not convert the record into a fabricated availability label.

#### Mailing lists — `/dashboard/epostliste`

| Item | Contract |
|---|---|
| SDK call | `client.admin.mailingLists()` |
| SDK result | `readonly MailingList[]`, where each entry has `name` and `emails: string[]` |
| Row source | Flatten each list member into one row `{ name, email }`. Preserve source order. |
| Empty list | Produce zero member rows. Do not create an empty email, a placeholder member, or a success row. |
| Display rule | Display the actual list name beside each actual email. |
| Forbidden fields | A singular source `email` field, a guessed owner, a guessed member, or a fabricated email |

The flatten operation is a typed projection. It is not a response-shape guard.

#### Interviews — `/dashboard/intervjuer`

| Item | Contract |
|---|---|
| SDK call | `client.admin.interviews.list()` |
| SDK result | `{ items: Interview[]; totalItems: number }` |
| Row source | Use the typed `result.items`. Keep `id` only when a stable technical row key is needed. |
| Display fields | `applicationId`, `interviewerName`, `interviewTime`, and `schedulingStatus` |
| Nullable rule | Preserve `interviewerName` and `interviewTime` null values as explicit unavailable states. Do not invent a person or date. |
| Forbidden fields | `applicant`, `applicantLabel`, invented `interviewer`, invented `date`, and an untyped legacy `status` |

The non-assigned `Interview` result does not provide an applicant label.
The view must not borrow `AssignedInterview.applicantLabel` or another route's fixture to fill that gap.
The `schedulingStatus` value is the SDK-decoded `InterviewSchedulingStatus`.

#### Schools — `/dashboard/skoler`

| Item | Contract |
|---|---|
| SDK call | `client.admin.scheduling.schools()` |
| SDK result | `{ items: SchedulingSchool[]; totalItems: number }` |
| Row source | Use the typed `result.items`. |
| Row fields | `id`, `name`, and the actual `capacity` records |
| Deterministic summary | For each capacity record, sort entries by key, render each actual `key=value`, preserve the source record order, and join records with a fixed separator. |
| Empty capacity | Show an explicit zero-record state or an empty summary. Do not invent a scalar capacity. |
| Forbidden fields | `assistantCount`, an invented scalar `capacity`, an inferred assistant total, or a capacity record not in the SDK result |

The summary is a deterministic rendering of `Array<Record<string, number>>`.
It is not a domain calculation and must not add totals or assistant counts.

#### Team interest — `/dashboard/teaminteresse`

| Item | Contract |
|---|---|
| SDK call | `client.admin.teams.interest()` |
| SDK result | `{ items: TeamInterest[]; totalItems: number }` |
| Row source | Use the typed `result.items`. |
| Row fields | `id`, `userName`, and `teamName` |
| Display rule | Render the actual `userName` and `teamName`. |
| Forbidden fields | `admin.teamInterest()`, `admin.teams.list()`, `name`, `team`, `semester`, and `semester: "fixture"` |

No current `TeamInterest` schema field identifies a semester.
The missing semester is a parity gap, not a reason to add a fixture value.

#### Substitutes — `/dashboard/vikarer`

| Item | Contract |
|---|---|
| SDK call | `client.admin.scheduling.substitutes()` |
| SDK result | `{ items: Substitute[]; totalItems: number }` |
| Row source | Use the typed `result.items`. |
| Row fields | `id`, `name`, `email`, `yearOfStudy`, `language`, `monday`, `tuesday`, `wednesday`, `thursday`, and `friday` |
| Nullable rule | Preserve nullable year, language, and weekday values. Display unavailable values as unavailable. |
| Forbidden fields | `phone`, fabricated `status`, inferred availability status, or any legacy substitute mock field |

Weekday values are actual nullable booleans. They must not become a fabricated one-word status.

## 5. Frozen gap accounting and downstream parity handoff

The current legacy routes and templates contain facts that the SDK does not provide.
This table is the frozen 0025 accounting record for those facts.
It is part of the implementation handoff and does not edit the 0024 inventory.

| Current route | Legacy authority and exact facts | Current SDK authority | Legacy facts not supplied by the current SDK | Proposed 0024 API-operation/route relation |
|---|---|---|---|---|
| `/dashboard/assistenter` | Legacy route `vektorprogrammet/app/config/routing.yml:406-409`; controller `vektorprogrammet/src/AppBundle/Controller/ParticipantHistoryController.php:17-37`; table `vektorprogrammet/app/Resources/views/participant_history/index.html.twig:83-147` | `packages/sdk/src/domains/admin/scheduling.ts:6-19`; `packages/sdk/src/schemas/scheduling.ts:3-14` | `school.name`, `semester.name`, `department.shortname`, `bolk`, and `day`. The current route's `phone` is a stale local mock field, not a legacy field in this table. | Legacy `participanthistory_show` ↔ `admin.scheduling.assistants()` / `/api/admin/scheduling/assistants`; proposed route/API mismatch with missing fields marked `uncovered`. |
| `/dashboard/epostliste` | Legacy route family `vektorprogrammet/app/config/routing.yml:1251-1278`; controller `vektorprogrammet/src/AppBundle/Controller/MailingListController.php:18-103`; output `vektorprogrammet/app/Resources/views/mailing_list/mailinglist_show.html.twig:1` | `packages/sdk/src/domains/admin/misc.ts:6-15`; `packages/sdk/src/schemas/common.ts:52-55` | Legacy `Assistent`, `Team`, and `Alle` selection plus department/semester filtering and user-based source ownership. The legacy output has actual email values; the SDK supplies those values as `emails[]`, but does not supply the legacy selection operation. | Legacy `generate_mail_lists` and its three generated routes ↔ `admin.mailingLists()` / `/api/admin/mailing-lists`; proposed operation/route mismatch for selection and ownership, with uncovered legacy expectations retained. |
| `/dashboard/intervjuer` | Legacy route `vektorprogrammet/app/config/routing.yml:555-561`; controller `vektorprogrammet/src/AppBundle/Controller/AdmissionAdminController.php:117-144`; parent context `vektorprogrammet/app/Resources/views/admission_admin/layout.html.twig:240-279`; interview table `vektorprogrammet/app/Resources/views/admission_admin/interviewed_applications_table.html.twig:10-110` | `packages/sdk/src/domains/admin/interviews.ts:35-38,97-102`; `packages/sdk/src/schemas/interview.ts:105-160` | `application.user` name, email, and phone; `doublePosition`; `preferredGroup`; `language`; `interviewScore.sum`; `suitableAssistant`; `specialNeeds`; and controller-selected `department` and `semester` context rendered by the parent layout, not by the interview table. | Legacy `applications_show_interviewed` ↔ `admin.interviews.list()` / `/api/admin/interviews`; proposed route/API mismatch with missing applicant and interview facts marked `uncovered`. |
| `/dashboard/skoler` | Legacy route `vektorprogrammet/app/config/routing.yml:881-886`; controller `vektorprogrammet/src/AppBundle/Controller/SchoolAdminController.php:126-137`; parent context and tabs `vektorprogrammet/app/Resources/views/school_admin/index.html.twig:11-56`; school table `vektorprogrammet/app/Resources/views/school_admin/school_table.html.twig:1-56` | `packages/sdk/src/domains/admin/scheduling.ts:6-26`; `packages/sdk/src/schemas/scheduling.ts:16-20` | `contactPerson`, `phone`, `email`, and `international`, plus active/inactive tabs and department context rendered by the parent index and its include, not by the school table. `assistantCount` and scalar capacity are stale local projection fields, not legacy facts in this table. | Legacy `schooladmin_filter_schools_by_department` ↔ `admin.scheduling.schools()` / `/api/admin/scheduling/schools`; proposed route/API mismatch with missing contact facts marked `uncovered`. |
| `/dashboard/teaminteresse` | Legacy route `vektorprogrammet/app/config/routing.yml:589-595`; controller `vektorprogrammet/src/AppBundle/Controller/AdmissionAdminController.php:307-338`; table `vektorprogrammet/app/Resources/views/admission_admin/teamInterest.html.twig:29-120` | `packages/sdk/src/domains/admin/teams.ts:6-19`; `packages/sdk/src/schemas/common.ts:34-38` | `department.shortname`; `semester.semestertime` and `semester.year`; aggregate interested count; applicant first name, last name, email, and phone; interview-versus-stand source; and potential-team aggregation. | Legacy `admissionadmin_team_interest` ↔ `admin.teams.interest()` / `/api/admin/team-interest`; proposed route/API mismatch with semester and applicant facts marked `uncovered`. |
| `/dashboard/vikarer` | Legacy route `vektorprogrammet/app/config/routing.yml:1158-1164`; controller `vektorprogrammet/src/AppBundle/Controller/SubstituteController.php:22-43`; table `vektorprogrammet/app/Resources/views/substitute/index.html.twig:51-139` | `packages/sdk/src/domains/admin/scheduling.ts:6-33`; `packages/sdk/src/schemas/scheduling.ts:22-33` | `phone`; `fieldOfStudy`; `preferredGroup`; interview score; suitability; and semester/department context. The current route's `status` is a stale local projection field, not a legacy field in this table. | Legacy `substitute_show` ↔ `admin.scheduling.substitutes()` / `/api/admin/substitutes`; proposed route/API mismatch with missing substitute facts marked `uncovered`. |

The current six route projections must not fabricate any of the missing facts in this table.
They must also not remove these facts from Goal-1 accounting.
The implementation handoff must repeat this table or link it without changing its source references.

The downstream 0024 obligation starts only after 0024 C1 has produced exact API-operation rows and 0024 C3 has a working journey-coverage resolver.
At that point, the 0024 owner must map each proposed legacy route/API operation relation, preserve the source references above, and emit each missing fact as `uncovered`.
That downstream inventory work is not an acceptance criterion for 0025 and does not grant this capsule permission to edit 0024.
Until C1 and C3 provide that capability, §5 is the authoritative 0025 accounting record and the handoff must state that the downstream obligation is pending.

A route that removes an unavailable column has not proved parity.
A route that renders an unavailable marker has not proved parity.
A clean type gate has not proved parity.
No field may disappear from Goal-1 accounting because this slice cannot provide it.

## 6. Mutable path capsule

The future implementation may change only these eleven paths:

| Path | Allowed change |
|---|---|
| `apps/dashboard/app/routes/dashboard.assistenter._index.tsx` | Remove the fixture short-circuit and stale mock; use the typed page unwrap and accepted assistant projection from §4.3. |
| `apps/dashboard/app/routes/dashboard.epostliste._index.tsx` | Remove the fixture short-circuit and stale mock; flatten the typed mailing-list result from §4.3. |
| `apps/dashboard/app/routes/dashboard.intervjuer._index.tsx` | Remove the fixture short-circuit and stale mock; use the typed page unwrap and four-field interview projection from §4.3. |
| `apps/dashboard/app/routes/dashboard.skoler._index.tsx` | Remove the fixture short-circuit and stale mock; use the typed page unwrap and deterministic capacity-record summary from §4.3. |
| `apps/dashboard/app/routes/dashboard.teaminteresse._index.tsx` | Remove the fixture short-circuit and stale mock; call `admin.teams.interest()` and use the accepted row projection from §4.3. |
| `apps/dashboard/app/routes/dashboard.vikarer._index.tsx` | Remove the fixture short-circuit and stale mock; use the typed page unwrap and accepted substitute projection from §4.3. |
| `apps/homepage/package.json` | Exact homepage `check-types` command in §4.1. |
| `apps/dashboard/package.json` | Exact dashboard script-key rename in §4.1. |
| `packages/sdk/package.json` | Add only `"check-types": "tsc -b"`; do not change SDK exports, dependencies, or source. |
| `apps/dashboard/README.md` | Change the live dashboard command from `bun run --cwd apps/dashboard typecheck` to `bun run --cwd apps/dashboard check-types`; do not rewrite historical specs. |
| `apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts` | One focused browser behavior test with an inline Node HTTP fixture on `127.0.0.1:8791` for these six routes only. |

The six route-local `isFixtureMode` imports, branches, and stale mock arrays are removed.
The browser fixture reaches the same SDK-shaped loader path as a non-fixture request.
No route retains a second fixture projection.
The test path is the only new test path named by this specification.
The implementation must not change `playwright.config.ts`, another test, a fixture helper, a route outside the six modules, a package lock, a source package, or a historical design spec.
The focused test must not become a general dashboard suite.

Any changed path outside this table is a falsifier.
A change that looks mechanical but changes an SDK method, field meaning, auth boundary, route owner, or error outcome is semantic and is also a falsifier.

## 7. One maintainer journey

The current specification writer does not run this journey.
The future implementation writer runs it once from the exact clean checkout.
The writer records commands and sanitized outcomes, but does not commit generated output or raw browser data.

### Step 1 — Enter the exact clean checkout

Create the implementation worktree and branch from the exact base:

```sh
git worktree add -b impl/0025-dashboard-list-type-boundary \
  /tmp/mono-web-type-gate-impl-0025 \
  71c3f9934abf52772faeaa98293b4c374a98fa89
```

Confirm all of these before a source change:

```sh
git -C /tmp/mono-web-type-gate-impl-0025 rev-parse HEAD
git -C /tmp/mono-web-type-gate-impl-0025 status --porcelain=v1 --untracked-files=all
git -C /tmp/mono-web-type-gate-impl-0025 diff --cached --exit-code
git -C /tmp/mono-web-type-gate-impl-0025 diff --exit-code
```

The first command must print `71c3f9934abf52772faeaa98293b4c374a98fa89`.
The status and both diff commands must report a clean checkout.
Do not copy `.serena/`, `.env`, `.dev.vars`, generated route types, credentials, ignored state, or user files into the worktree.

### Step 2 — Install before route type generation

From the clean worktree, run this command before any type-generation command:

```sh
bun install --frozen-lockfile
```

The install must use the existing root lock. It must not rewrite `bun.lock`.
Do not run a package script before this install.

### Step 3 — Record the baseline from no generated route types

Start from the fresh worktree with no `.react-router/types` output in either app and no `packages/sdk/dist` output.
Record the existing baseline command and its known failure:

```sh
bun run check-types
```

The baseline must show the homepage generated-route failure, the missing dashboard discovery edge, and the missing SDK `check-types` edge from §1.
Do not treat this known red baseline as a reason to widen the capsule.
Do not pre-generate route types or SDK `dist` to make the baseline green.

### Step 4 — Apply the bounded source change

Edit only the eleven paths in §6.
Apply the exact SDK, homepage, and dashboard package-script changes before the final type gate.
Update the one live README command from `typecheck` to `check-types`.
For each route, remove the fixture short-circuit and stale mock, then apply the mapping in §4.3.
Keep SDK errors visible. Do not add a cast, array guard, fallback row, or fixture semester.

Before the final type gate, use a fresh checkout state or remove only ignored generated route output.
The final gate must start with no generated route types or SDK `dist` and must generate both through the package tasks.

### Step 5 — Run the root type gate

The normal operational root command remains:

```sh
bun run check-types
```

For the final no-generated-output verification, run the root command with Turbo's cache bypass:

```sh
bun run check-types --force
```

The `--force` argument must reach Turbo.
The observed task output must show `@vektorprogrammet/sdk`, `@monoweb/homepage`, and `@monoweb/dashboard` executed in this invocation, not replayed from cache.
The SDK task must run `tsc -b` through `check-types` and create disposable `dist` output.
Each app must run `react-router typegen` before `tsc`.
The command must complete without TypeScript diagnostics in the root task.

Generated `.react-router` output and SDK `dist` are disposable.
They must remain ignored and must not appear in the commit.
The writer must not replace the normal command with a direct `tsc`, a package-only command, a manually pre-built SDK, or a command that relies on pre-generated files.

### Step 6 — Run the focused route observation

Run only the named behavior test after the root type gate.
Unset both fixture-mode variables and point both SDK URL variables at the inline loopback fixture:

```sh
env -u API_MODE -u VITE_API_MODE \
  API_URL=http://127.0.0.1:8791 \
  VITE_API_URL=http://127.0.0.1:8791 \
  bun run --cwd apps/dashboard e2e:test -- dashboard-list-type-boundary.spec.ts --project=chromium
```

The named test must start one inline Node HTTP server on `127.0.0.1:8791` before any dashboard navigation.
The server must accept the synthetic `Authorization: Bearer fixture-jwt-0025` header and serve these exact paths:

| Path | Synthetic wire contract |
|---|---|
| `/api/me/profile` | One `UserProfile` object with synthetic IDs and `example.invalid` email; nullable fields remain `null` where the schema allows them. |
| `/api/admin/scheduling/assistants` | Hydra collection envelope with `SchedulingAssistant` members and `hydra:totalItems`. |
| `/api/admin/mailing-lists` | A direct `MailingList[]` response with one two-member list and one empty list. |
| `/api/admin/interviews` | Hydra collection envelope with `Interview` raw members and an integer `schedulingStatus` accepted by `InterviewFromRaw`. |
| `/api/admin/scheduling/schools` | Hydra collection envelope with `SchedulingSchool` members and actual capacity record arrays. |
| `/api/admin/team-interest` | Hydra collection envelope with `TeamInterest` members containing only actual `id`, `userName`, and `teamName` facts. |
| `/api/admin/substitutes` | Hydra collection envelope with `Substitute` members and nullable year, language, and weekday facts. |

The test must seed the synthetic `jwt_token=fixture-jwt-0025` cookie before navigation.
The fixture must reset its request ledger before the six-route sequence.
The fixture must not call Symfony, a provider, a database, a remote API, or a production host.
The route loaders must reach the SDK path because `API_MODE` and `VITE_API_MODE` are unset.

The test must assert the following route observations:

| URL | Synthetic observation |
|---|---|
| `/dashboard/assistenter` | The table shows the synthetic assistant name, email, language, and accepted scheduling facts. It has no school or phone column. |
| `/dashboard/epostliste` | A list with two actual emails produces two rows. An empty list produces no synthetic email row. |
| `/dashboard/intervjuer` | The table shows the synthetic application ID and decoded scheduling status. Null interviewer and time remain unavailable. No applicant label appears. |
| `/dashboard/skoler` | The table shows the school name and a stable summary of the actual capacity records. It has no assistant count. |
| `/dashboard/teaminteresse` | The table shows the actual synthetic `userName` and `teamName`. It has no semester column and no fixture semester. |
| `/dashboard/vikarer` | The table shows name, email, year, language, and weekday facts. It has no phone or fabricated status. |

The synthetic values must be technical and non-personal.
Use addresses under `example.invalid` if an email-shaped value is required.
The test evidence must record route, method, status, response-shape keys, row count, and visible field names only.
Do not retain raw payloads, cookies, authorization headers, tokens, screenshots with personal data, or fixture logs.

The focused test must also exercise one typed failure for a named route.
The page must show a failure state rather than an empty successful table.
A failure that produces `null`, `[]`, mock rows, or a generic success message is a falsifier.
### Step 7 — Close the capsule

Inspect the changed path list and the commit before handoff:

```sh
git status --short
git diff --name-only 71c3f9934abf52772faeaa98293b4c374a98fa89..HEAD
git diff --name-only --cached
git status --porcelain=v1 --untracked-files=all
```

The implementation commit must contain only the paths in §6.
It must contain no generated route declarations, report, trace, screenshot, video, fixture log, lock change, or temporary file.
The worktree must be clean after cleanup.

## 8. Acceptance criteria

The implementation is accepted only when every item passes:

1. The implementation starts at `71c3f9934abf52772faeaa98293b4c374a98fa89` in the named clean worktree and uses one maintainer journey.
2. `packages/sdk/package.json` contains exactly one new type-gate entry, `"check-types": "tsc -b"`, and SDK source and exports remain unchanged.
3. Turbo's existing `^check-types` dependency schedules the SDK type gate before the dashboard type gate, without a pre-built `dist` assumption; the homepage type gate also runs in the root graph.
4. `apps/homepage/package.json` contains exactly `"check-types": "react-router typegen && tsc"` and no duplicate type-generation authority.
5. `apps/dashboard/package.json` contains exactly `"check-types": "react-router typegen && tsc"`; the `typecheck` key is absent.
6. `apps/dashboard/README.md` uses `bun run --cwd apps/dashboard check-types` for the live type-check command; historical specifications remain unchanged.
7. The normal root command remains `bun run check-types`; the final clean-checkout verification runs `bun run check-types --force` from no generated route types or SDK `dist`, and its output shows SDK, homepage, and dashboard tasks executed rather than replayed from cache.
8. The six loaders call the exact SDK methods in §4.3, remove all six `isFixtureMode` short-circuits and stale mocks, and use `.items` only for typed page results.
9. No changed route uses `Array.isArray` to widen a collection response, a broad cast, `any`, or an unknown-to-row assertion.
10. Assistant rows use only `SchedulingAssistant` facts and do not expose school or phone.
11. Mailing-list rows flatten actual `emails[]` values and do not create a synthetic member for an empty list.
12. Interview rows use `applicationId`, `interviewerName`, `interviewTime`, and `schedulingStatus` without an applicant label.
13. School rows summarize actual capacity records deterministically and do not expose `assistantCount` or an invented scalar capacity.
14. Team-interest rows call `admin.teams.interest()`, use `userName` and `teamName`, and do not expose semester or `"fixture"`.
15. Substitute rows use only name, email, year, language, and weekday facts. They do not expose phone or fabricated status.
16. Typed SDK failures remain visible failures. No loader converts a failure into `null`, `[]`, mock success, or an empty successful table.
17. The §5 gap table and exact source references are repeated or linked in the implementation handoff. The downstream 0024 `uncovered` obligation is recorded as pending until C1 API rows and C3 coverage capability exist; it is not claimed as 0025 acceptance.
18. The focused browser observation uses the exact unset/set environment in §7, the inline fixture paths in §7, and the synthetic cookie before navigation.
19. The focused browser observation records the six route observations in §7 and performs no external effect.
20. The committed changed path set is a subset of the eleven paths in §6. Generated route output, SDK `dist`, and disposable evidence are absent from the commit.
21. The final worktree is clean, and the handoff reports the exact base, implementation branch, implementation HEAD, changed paths, and clean status.
22. The handoff makes no final parity, release, deployment, provider, production, or route-cutover claim.
## 9. Falsifiers and `Drift` behavior

Any one of the following fails this specification, even if a page renders:

- the implementation starts from another base, branch, worktree, or dirty checkout;
- frozen install runs after route type generation, or the root lock changes;
- the no-generated-output final verification uses `bun run check-types` without `--force`, or accepts cache-replayed tasks instead of executed SDK and app tasks;
- Turbo does not schedule the SDK `check-types` task before the dashboard consumer, or the dashboard relies on a manually pre-built `dist`;
- homepage `check-types` omits `react-router typegen`;
- dashboard retains `typecheck`, adds a `typecheck` alias, or uses a different command;
- `apps/dashboard/README.md` keeps the live `run typecheck` command, or a historical specification is edited to rewrite evidence;
- root Turbo still skips SDK, homepage, or dashboard;
- any route retains an `isFixtureMode` short-circuit or stale local mock array;
- any route uses `Array.isArray` to accept both a page and an array;
- any route uses `as any`, `as unknown as`, a broad cast, or a local weakened schema;
- a collection result is treated as an array without reading its typed `.items` field;
- a typed SDK failure becomes `null`, `[]`, a mock row, an empty successful table, or a generic success message;
- assistants display `school`, `phone`, or another unavailable field;
- mailing lists invent an email, collapse `emails[]` to an unowned singular value, or create an empty-list member;
- interviews display an applicant label, invented interviewer, invented date, or legacy status field;
- schools display `assistantCount`, an invented scalar capacity, or a derived assistant total;
- team interest calls `teams.list()`, calls nonexistent `teamInterest()`, displays semester, or writes `semester: "fixture"`;
- substitutes display phone, fabricated status, or inferred availability status;
- the §5 accounting table or its exact source references are changed without a new specification;
- the 0024 inventory is edited from this capsule, or a downstream `uncovered` obligation is claimed before C1 API rows and C3 coverage capability exist;
- the focused observation does not unset `API_MODE` and `VITE_API_MODE`, does not set both API URLs to `127.0.0.1:8791`, or does not seed the synthetic cookie before navigation;
- the inline fixture omits `/api/me/profile` or one of the six SDK endpoint paths, returns a non-schema-shaped response, or does not exercise the SDK loader path;
- the focused observation uses a real person, production host, credential, remote API, provider, database, or non-loopback fixture;
- a test, config, fixture helper, route, package, lock, generated file, or historical spec outside §6 changes;
- generated `.react-router` output, SDK `dist`, raw payloads, credentials, screenshots with personal data, logs, traces, or reports enter the commit;
- the implementation claims a clean type gate as functional parity or changes lifecycle state without the required authority.

When a falsifier occurs, stop the journey. Preserve only sanitized command and path evidence.
Record the conflict as `Drift` and return to the relevant authority owner.
Do not repair a falsifier with a cast, alias, fallback, fixture field, unrelated route edit, inventory edit, or scope expansion.
## 10. Rollback and cleanup

This is a local source change with no provider or production rollback.
If the implementation fails before handoff, revert the one implementation commit or discard the isolated implementation worktree.
Do not perform a partial rollback that restores `typecheck` while leaving only one app on the new gate.
The SDK manifest edge, the two app scripts, the README command, and the six route projections must roll back together.

If the downstream 0024 owner cannot represent the §5 table after C1 and C3 provide their capabilities, record `Drift` and return to `Specified`.
Do not edit 0024 from this capsule, delete a missing field, or add a fabricated SDK field.
If the SDK schema or domain method changes during the journey, stop and create a new specification.
Do not change SDK source from this capsule.

Before handoff, stop the inline fixture and dashboard processes.
Remove generated route output, SDK `dist`, and disposable browser evidence.
Confirm that only the eleven paths in §6 changed and that the implementation worktree is clean.
No external resource, provider state, credential, or production rollback is authorized by this specification.
## 11. Lifecycle and no-parity boundary

This specification remains `Specified` until the product lead accepts the intent and a separate implementation record opens the `Building` state.
A future implementation record must distinguish `Building`, local experience evidence, conformance review, release readiness, and operation.
A branch name, commit, passing type gate, browser screenshot, or synthetic fixture result cannot enter those states by itself.

This slice has one boundary:

```text
SDK schemas and methods own available facts
        |
        v
six typed route projections + root check-types discovery
        |
        v
synthetic local browser observations

0024 legacy/domain inventory remains a separate parity-accounting authority
```

A green root type gate establishes that both React Router applications and the named route consumers type-check after generation.
It does not establish that the SDK matches the backend, that the backend matches the legacy application, or that any user journey has functional parity.
A synthetic browser fixture establishes only that the named projections render the supplied schema-shaped facts.
It does not establish production data correctness, authorization, deployment, or route cutover.

Missing legacy fields are not silently removed from Goal-1.
They enter the 0024 inventory as `uncovered` until a separately authorized parity decision provides an authoritative source or disposition.
No final parity claim is permitted from this specification.
