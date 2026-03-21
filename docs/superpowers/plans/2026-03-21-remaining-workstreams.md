# Remaining Workstreams — Sequential Execution Plan

> **For agentic workers:** Execute these sequentially. Each workstream is self-contained.

**Context:** Session 2026-03-21 completed receipt admin, application review, guard parity A-D, and SDK redesign. These are the remaining items.

---

## Workstream 1: Interview Scheduling UI

**Goal:** Upgrade the bare interview list page into a full scheduling workflow with schedule, reschedule, and conduct dialogs.

**Prerequisites:**
- `POST /api/admin/interviews/{id}/schedule` endpoint is built and tested
- SDK method `client.admin.interviews.schedule(id, input)` exists
- Application review page with "Assign Interview" dialog is complete (existing)
- Interview state machine understood: `NO_CONTACT → PENDING → ACCEPTED → conducted` with reschedule cycle `PENDING ↔ REQUEST_NEW_TIME`

**Tasks:**

1. **Enhance interview list page** (`dashboard.intervjuer._index.tsx`). Upgrade the bare DataTable to show status badges (`NO_CONTACT`, `PENDING`, `ACCEPTED`, `REQUEST_NEW_TIME`, `CANCELLED`) with colour coding. Add filters by status and admission period. Load interviewer names from `GET /api/admin/users`. Each row links to an interview detail view.

2. **Schedule dialog** (new component, reused for initial schedule and reschedule). Fields: date/time picker, room (text), campus (text), map link (optional), interviewer selection (user lookup), co-interviewer (optional), confirmation message. On submit: call `client.admin.interviews.schedule(id, input)` → status transitions to `PENDING`. The reschedule flow is identical but triggered from a `REQUEST_NEW_TIME` interview — no separate component needed.

3. **Interview detail view** (drawer or dedicated route). Show all interview fields, current status, reminder count (`numAcceptInterviewRemindersSent`). If status is `ACCEPTED` and `interviewed = false`: show Conduct button. If `isDraft` (`interviewed = false` and score non-null): show resume-draft button. Conduct form: four score fields (`explanatoryPower`, `roleModel`, `suitability`, `suitableAssistant`), one answer textarea per schema question; save-draft and submit-final actions. Call `POST /api/admin/interviews/{id}/conduct` on final submit.

4. **Bulk assign from application list** (enhancement to `dashboard.sokere._index.tsx`). Add a checkbox column and "Assign interviews" bulk action that calls `POST /api/admin/interviews/bulk-assign`. Requires interviewer selection for the batch. This removes the need to visit the interview list for initial assignment.

**Implementation notes:**
- `responseCode` is for email links only — never render it in the UI.
- `conducted` timestamp set in constructor is a legacy artifact; treat `interviewed = true` as the authoritative completion signal.
- The reschedule cycle (`PENDING → REQUEST_NEW_TIME → PENDING`) can repeat — the UI must not assume a single pass.
- Draft state is `interviewed = false AND interviewScore != null` — check `isDraft()` semantics before rendering draft indicators.

**Estimated complexity:** High. Most complex dashboard feature. State machine has 5 statuses × 2 completion dimensions. Plan for ~3 sub-sessions: list/detail view, schedule/conduct dialogs, bulk assign.

**Dependencies on other workstreams:** None (backend already built). Workstream 4 (test infrastructure) should cover dialogs once that is in place.

---

## Workstream 2: Homepage Connection

**Goal:** Connect the homepage application form to the SDK so applicants can submit through the React app instead of the Symfony monolith.

**Prerequisites:**
- SDK public methods exist: `client.public.departments()`, `.sponsors()`, `.teams()`, `.fieldOfStudies()`
- `POST /api/applications` endpoint exists and accepts unauthenticated submissions (verify — application submission may require auth)
- `GET /api/admission_periods` public variant exists or can be exposed (currently `GET /api/admin/admission-periods` is admin-only — check if a public endpoint exists)
- Dashboard admission periods route (Workstream 1 prerequisite 1.1) is complete or at minimum the API endpoint is functional

**Tasks:**

1. **Wire admission period check** (`_home.assistenter.tsx`). Replace the hardcoded `cityApplicationOpen` record with a loader that calls `GET /api/admission_periods?department=<id>&active=true`. Map department slugs (`trondheim`, `bergen`, `aas`) to department IDs via `client.public.departments()`. Show "applications open" and the real deadline when an active period exists; show "applications closed" otherwise.

2. **Complete the application form** (still in `_home.assistenter.tsx`, `CityApplyCard` component). The form UI exists but is unconnected. Wire city/department selection to the active admission period. Add the missing domain fields required by `POST /api/applications`: availability (weekday checkboxes), substitute preference (boolean), double position (boolean), preferred school (select from `GET /api/admin/scheduling/schools` — needs a public variant or use department info instead). Connect the submit button to a React Router action that calls `client.public.applications.create(input)`. Show success confirmation or server-side validation errors inline.

3. **Registration/auth decision** (required before the form can be wired end-to-end). `POST /api/applications` likely requires an authenticated user. Three options — (A) build registration in the homepage, (B) redirect to dashboard login then return, (C) defer the form to the monolith. Per `docs/migration/homepage.md`, option C is currently recommended. Make the decision explicit and either implement the chosen option or document the deferral with a TODO in the route file so the form is clearly marked incomplete rather than silently broken.

4. **Admission status on `/assistenter`** (lower priority). Once tasks 1–2 are done, verify the "Disse avdelingene har opptak nå" section shows real data. This is the only other dynamic content gap on this page.

**Implementation notes:**
- The application form UI (`CityApplyCard`) already has name, email, phone, field-of-study, gender, and grade fields. The missing fields (availability, substitute preference, double position) need to be appended before the submit button.
- A public `GET /api/admission_periods` endpoint may need to be added to the Symfony backend if one does not exist — check OpenAPI spec before assuming.
- `GET /api/admin/scheduling/schools` is admin-only. If the form requires a school preference, either expose a public variant or make the field free-text for now.

**Estimated complexity:** Medium. UI structure exists; main work is the loader wiring, missing form fields, and the auth decision. Auth decision is a blocker for full end-to-end.

**Dependencies on other workstreams:** Soft dependency on dashboard admission period management (Workstream 1 prerequisite) being functional, since test data depends on it.

---

## Workstream 3: Guard Parity Batch E

**Goal:** Resolve the 6 deferred guard parity items, each requiring an explicit architecture decision before implementation.

**Prerequisites:**
- Guard parity batches A–D are merged
- Batch E items documented in `docs/superpowers/specs/2026-03-21-guard-parity-batches-design.md`

**Items:**

### E1 — AUTH-2: Default-deny in AccessControlService

**What it is:** `AccessControlService` currently defaults to allow (permissive). The correct security posture is default-deny: reject unless an explicit rule permits the request. An attempt was made and reverted (see commit `a55be14`).

**Why deferred:** Enabling default-deny requires every existing route to have a matching `AccessRule`. Without a complete rule inventory, enabling it silently breaks all unregistered routes.

**Decision needed:** Audit all admin routes to produce a complete `AccessRules` map before toggling the default. Decide the implementation order: rules first, then toggle — or toggle with a feature flag and add rules incrementally.

**Proposed approach:** (1) Run a script or grep to enumerate all API Platform operations and their current security annotations. (2) For each operation without an explicit `AccessRule`, add one matching the existing annotation. (3) Once all routes are covered, re-apply the default-deny toggle. (4) Run full test suite — any route that now 403s unexpectedly reveals a missing rule.

---

### E2 — AUTH-6: JWT revocation for demoted/deactivated users

**What it is:** A user deactivated or demoted mid-session retains their JWT until it expires naturally. There is no revocation mechanism.

**Why deferred:** JWT revocation requires either a token blacklist (stateful, adds DB read on every request) or a short TTL (stateless, but increases re-auth friction). Neither is a drop-in change.

**Decision needed:** Choose strategy — blacklist vs short TTL vs session-based (opaque tokens). Each has different ops and UX tradeoffs.

**Proposed approach:** Short TTL (15 min) + refresh token pattern is the standard mitigation that keeps JWTs stateless. If the session overhead is acceptable, opaque tokens with server-side sessions are simpler. Recommend short TTL + refresh: set `lexik_jwt_authentication.token_ttl` to 900, add a refresh endpoint (`/api/token/refresh` via `gesdinet/jwt-refresh-token` bundle), update the SDK to auto-refresh before expiry. Deactivation check fires at refresh time — a deactivated user's refresh token is invalidated.

---

### E3 — AUTH-7: AccessControlService ignores Symfony role hierarchy

**What it is:** `AccessControlService` compares roles as plain strings without applying Symfony's role hierarchy (e.g., `ROLE_ADMIN` implicitly grants `ROLE_TEAM_LEADER`). A user with `ROLE_ADMIN` can be denied access to routes that only check for `ROLE_TEAM_LEADER`.

**Why deferred:** Changing the comparison carries regression risk — tests that rely on the current broken behaviour (checking exact role match) would silently pass the wrong thing.

**Decision needed:** Whether to inject Symfony's `AuthorizationCheckerInterface` or `RoleHierarchyInterface` into `AccessControlService`, and how to update tests to reflect the corrected semantics.

**Proposed approach:** Inject `Symfony\Component\Security\Core\Authorization\AuthorizationCheckerInterface` and replace manual role string comparison with `$authChecker->isGranted($role)`. This delegates hierarchy resolution to Symfony. Update unit tests to mock the checker correctly (not the role string). Run `composer test` after — any newly-passing permission checks that were previously failing may surface untested code paths.

---

### E4 — TEAM-4: Suspended leader retains role between batch runs

**What it is:** When a team leader is suspended, their `ROLE_TEAM_LEADER` role is not immediately revoked. Role downgrade happens only during the next scheduled batch run.

**Why deferred:** Depends on the batch job design — it is unclear whether the batch should be the only mechanism or whether suspension should trigger an immediate role update.

**Decision needed:** Should suspension trigger synchronous role downgrade, or is the eventual-consistency batch acceptable? The batch interval determines the window of exposure.

**Proposed approach:** Synchronous downgrade is correct. In `TeamMembership::suspend()` (or the processor that calls it), add a call to `RoleManager::removeLeaderRole($user)` immediately. The batch job becomes a consistency sweep (idempotent), not the primary mechanism. Add a test: suspend a leader, assert their roles no longer contain `ROLE_TEAM_LEADER` before the next batch.

---

### E5 — DATA-6 / DATA-12: FK cascade policies for Semester, School, and User deletion

**What it is:** Deleting a `Semester`, `School`, or `User` entity leaves orphaned FK references in related tables (`AdmissionPeriod`, `AssistantHistory`, `TeamMembership`, etc.) — or the delete fails with a FK constraint violation.

**Why deferred:** Cascade deletes are destructive and hard to reverse. The correct policy (cascade delete vs restrict vs nullify) differs per relationship and requires a data migration plan.

**Decision needed:** For each FK: cascade delete (remove child rows), restrict (prevent parent delete while children exist), or set-null (nullify FK on child). The decision depends on whether the child data has standalone value.

**Proposed approach:**
- `Semester` deletion: restrict — never delete a semester with attached periods/histories; instead archive/deactivate via a status field.
- `School` deletion: restrict — schools have historical value in `AssistantHistory`; require manual reassignment first.
- `User` deletion: soft-delete preferred (add `deletedAt` column, filter in queries). Hard delete: cascade for `TeamMembership`, `AssistantHistory` (via ON DELETE CASCADE in Doctrine); nullify for `Interview.interviewer` (nullable FK).

Implement as a Doctrine migration. Run `APP_ENV=test php bin/console doctrine:fixtures:load` after each cascade change to verify fixtures still load.

---

### E6 — INTERVIEW-5: Response code expiry

**What it is:** The `responseCode` embedded in confirmation emails has no expiry. An old confirmation link remains valid indefinitely, allowing an applicant to accept/reject an interview weeks or months after it was sent.

**Why deferred:** Requires a TTL policy decision and a mechanism to check expiry without storing a separate expiry timestamp (or by adding one).

**Decision needed:** What is the TTL for a response code? How is expiry enforced — add `responseCodeSentAt` timestamp, or compute from `lastScheduleChanged`?

**Proposed approach:** Add `responseCodeIssuedAt: ?\DateTimeImmutable` to the `Interview` entity. Set it when `SendConfirmation` is called (i.e., when status transitions to `PENDING`). Reset it when rescheduled. In `AcceptInterview()` and `RequestNewTime()`, check `responseCodeIssuedAt + TTL > now()`; return 410 Gone if expired. TTL recommendation: 14 days (two weeks covers typical interview scheduling windows). Add a Symfony `ParameterBag` config key `interview.response_code_ttl_days` to make it configurable without a code change.

---

**Estimated complexity:** High overall, but each item is bounded. E1 and E3 are medium (auditing + refactor). E2 is medium-high (infra change to JWT config + new bundle). E4 is low (one synchronous call). E5 is medium (migrations + policy decisions). E6 is low (one field + one check).

**Dependencies on other workstreams:** None. Independent of frontend workstreams. E1 should be executed last within this batch — it has the widest blast radius.

---

## Workstream 4: Frontend Test Infrastructure

**Goal:** Establish a vitest + React Testing Library baseline in the dashboard so all future UI work has a testable foundation.

**Prerequisites:**
- Dashboard app builds and runs (`turbo -F @monoweb/dashboard dev`)
- SDK mock pattern is clear (see SDK redesign completed in session 2026-03-21)
- At least one complete route exists (receipt pages are simplest — CRUD + status transitions)

**Tasks:**

1. **Install and configure test runner.** Add `vitest`, `@testing-library/react`, `@testing-library/user-event`, and `happy-dom` as dev dependencies in `apps/dashboard`. Add a `vitest.config.ts` that sets `environment: 'happy-dom'`, configures path aliases to match `tsconfig.json` (`@/*`), and excludes `node_modules`. Add a `test` script to `package.json` and wire it into the `turbo test` pipeline via `turbo.json`.

2. **Establish SDK mock pattern.** Create `apps/dashboard/test/mocks/sdk.ts` that exports a `createMockClient()` factory. Use `vitest`'s `vi.fn()` to stub each SDK method. Expose a `mockResolvedValue` helper per method for test-local overrides. Document the pattern in a comment block — this is the reference for all future tests. The mock must match the `createClient` interface so it can be passed directly to components/loaders that accept a client parameter.

3. **Write first tests: receipt pages.** Target `dashboard.utlegg._index.tsx` (list) and `dashboard.utlegg.$id.tsx` (detail). Test cases: (a) loader returns correct data shape → list renders receipt rows with status badges; (b) admin approves a receipt → action calls `client.admin.receipts.updateStatus(id, 'refunded')`; (c) admin rejects → calls with `'rejected'`. Use React Router's `createMemoryRouter` + `renderRouter` (or `createStaticHandler` for loaders) to test the full route module. These tests verify the contract (data flows from loader to component, actions call the right SDK methods), not implementation details.

4. **Document patterns and add to CI.** Write a `apps/dashboard/test/README.md` (brief — 20 lines) covering: how to run tests, the mock client pattern, and when to use `createMemoryRouter` vs shallow rendering. Verify `turbo test` runs dashboard tests in CI (GitHub Actions PHP+TS job). Fix any path or environment issues that surface in CI but not locally.

**Implementation notes:**
- Dashboard uses React Router v7 (framework mode with file-based routing). Test the route module interface (loader, action, default component) not the internal component tree.
- Happy-dom is preferred over jsdom for this stack — faster and sufficient for non-browser-API tests.
- Do not test SDK internals or type shapes — the TypeScript compiler owns those. Test only behaviour: "given this mock response, does the component render the expected output?"
- Start with receipt pages because they have the simplest state machine (3 statuses, no cycles) and the backend is already complete and tested.

**Estimated complexity:** Low-medium. Infrastructure setup is mechanical. The receipt test cases are straightforward. The main risk is React Router v7's test utilities being poorly documented — verify against the RR v7 changelog and testing docs before writing boilerplate.

**Dependencies on other workstreams:** None. Can be started independently. Ideally completed before Workstream 1 (interview scheduling) so new dialogs can be tested as they are built.
