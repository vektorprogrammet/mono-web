# Guard Parity Batches A–D — Design Spec

## Goal

Close 25 independent guard parity items identified in the API-guard-parity audit. All items are self-contained fixes (DB constraints, small logic bugs, missing guards, DTO field gaps). Batch E (6 blocked/architecture-dependent items) is explicitly deferred.

## Scope

- **In:** Batches A–D (25 items) — DB constraints, logic fixes, small guards, DTO fields
- **Out:** Batch E (AUTH-2 default-deny, AUTH-6 JWT revocation, AUTH-7 role hierarchy, TEAM-4 suspended leader, DATA-6 FK cascades, DATA-12 FK cascades, INTERVIEW-5 response code expiry)

## Approach

Each item is independent — no shared state, no ordering dependency. Parallelism target: 5–8 items per worker. Each item follows the same micro-cycle: read affected file → write failing test → apply fix → verify fixtures still load.

---

## Batch A: Trivial DB/Validation Fixes (10 items)

### A1 — DATA-3: SchoolCapacity unique constraint

**File:** `src/App/Scheduling/Infrastructure/Entity/SchoolCapacity.php`
**Fix:** Add `#[UniqueConstraint]` on `(school, semester)` columns and a corresponding `#[Assert\Unique]` or DB-level enforcement.
**Test:** Integration — insert two `SchoolCapacity` rows with the same school+semester, assert a `UniqueConstraintViolationException` is thrown.

### A2 — DATA-4: AssistantHistory unique constraint

**File:** `src/App/Operations/Infrastructure/Entity/AssistantHistory.php`
**Fix:** Add `#[UniqueConstraint]` on `(user, school, semester)`.
**Test:** Integration — duplicate insert must throw; single insert must succeed.

### A3 — DATA-7: AdmissionPeriod date order validation

**File:** `src/App/Admission/Infrastructure/Entity/AdmissionPeriod.php`
**Fix:** Add `#[Assert\LessThan(propertyPath: "endDate")]` on `startDate` (or a class-level `#[Assert\Expression]`).
**Test:** Unit — construct an `AdmissionPeriod` with `startDate >= endDate`, run the validator, assert a violation is returned.

### A4 — DATA-9: SchoolCapacity negative value guard

**File:** `src/App/Scheduling/Infrastructure/Entity/SchoolCapacity.php`
**Fix:** Add `#[Assert\PositiveOrZero]` (or `#[Assert\GreaterThanOrEqual(0)]`) on the capacity integer field.
**Test:** Unit — set capacity to `-1`, validate, assert violation.

### A5 — INTERVIEW-9: InterviewScore range constraints

**File:** `src/App/Interview/Infrastructure/Entity/InterviewScore.php`
**Fix:** Add `#[Assert\Range(min: 0, max: 10)]` on the three numeric score fields (`explanatoryPower`, `roleModel`, `suitability`). Confirm the accepted range from existing data before hardcoding 10. Note: `suitableAssistant` does NOT need `Assert\Range` — it is validated via the `Suitability` enum.
**Test:** Unit — score of `11` and `-1` each produce a violation on a numeric field; score of `5` produces none.

### A6 — RECEIPT-2: Receipt.visualId DB unique constraint

**File:** `src/App/Operations/Infrastructure/Entity/Receipt.php`
**Fix:** Add `unique: true` to the `#[Column]` on `visualId` (already a logical unique; make it a DB constraint).
**Test:** Integration — insert two receipts with the same `visualId`, assert unique violation.

### A7 — TEAM-7: TeamMembership unique (user, team, semester)

**File:** `src/App/Organization/Infrastructure/Entity/TeamMembership.php`
**Fix:** Add `#[UniqueConstraint]` on `(user, team, semester)`.
**Test:** Integration — duplicate membership insert must throw.

### A8 — DATA-11: 'Medlem' position existence guard

**File:** `src/App/Organization/Api/State/AdminTeamMemberAddProcessor.php`
**Fix:** Before creating a membership, query the `Position` repository for a row with name `'Medlem'`. If not found, throw a `\RuntimeException` or return a 422 with a descriptive message — do not silently create a broken membership.
**Test:** Unit — mock the repository to return `null` for `'Medlem'`, assert the processor throws/returns 422.

### A9 — DATA-14: Password reset expiration check

**File:** `src/App/Identity/Infrastructure/Entity/User.php`
**Fix:** In the password-reset token validation method, add an expiry check (compare token creation timestamp against a configured TTL, e.g. 24 h). Return `false` (or throw) if expired.
**Test:** Unit — token created 25 h ago must fail; token created 1 h ago must pass.

### A10 — TEAM-8: Post-remove entity access in subscriber

**File:** `src/App/Organization/Api/State/AdminTeamMembershipDeleteProcessor.php`
**Fix:** The processor (or its subscriber) accesses the deleted entity after removal. Capture all needed data (IDs, denormalized fields) before calling `EntityManager::remove()` / `flush()`.
**Test:** Unit — delete a membership, assert no doctrine "entity is detached" or null-access error occurs; assert any side-effect (email, event) still fires correctly.

---

## Batch B: Small Logic Fixes (7 items)

### B1 — INTERVIEW-3: Legacy accept endpoint skips state validation

**File:** `src/App/Interview/Api/Controller/InterviewController.php`
**Fix:** The legacy `accept` action sets `interview.accepted = true` directly, bypassing the state machine. Replace with a call to the canonical status-transition method (same one the non-legacy path uses).
**Test:** Unit — call the accept action on an interview already in a terminal state; assert an exception or 422, not a silent override.

### B2 — INTERVIEW-8: setCancelled(false) silently forces ACCEPTED

**File:** `src/App/Interview/Infrastructure/Entity/Interview.php`
**Fix:** Two-part fix requiring a call-site audit: (a) change `setCancelled(false)` so it does not call `acceptInterview()` — the uncancellation must not unconditionally force `ACCEPTED` status; (b) review whether the `NO_CONTACT → ACCEPTED` transition in `setInterviewStatus()` should be removed entirely, since that transition is not a valid state progression. Audit all call sites of `setCancelled` and `setInterviewStatus` before removing any transition to confirm no legitimate path depends on it.
**Test:** Unit — call `setCancelled(false)` on an interview with status `NO_CONTACT`; assert status does not silently become `ACCEPTED`.

### B3 — TEAM-6: Wrong department in getActiveTeamMemberships

**File:** `src/App/Organization/Infrastructure/Entity/Team.php`
**Fix:** The PHP collection filter derives the department from `$wh->getUser()->getDepartment()` (the work history user's department) instead of `$this->getDepartment()` (the team's own department). Replace `$wh->getUser()->getDepartment()` with `$this->getDepartment()` in the filter logic.
**Test:** Unit — create two teams in different departments; assert `getActiveTeamMemberships()` for a user returns only memberships from the correct department.

### B4 — DATA-10: RoleManager.userIsGranted only checks first role

**File:** `src/App/Identity/Infrastructure/RoleManager.php`
**Fix:** The method iterates user roles but returns after checking only the first one. Fix the loop to check all roles before returning `false`.
**Test:** Unit — user with roles `['ROLE_TEAM_MEMBER', 'ROLE_TEAM_LEADER']` queried for `ROLE_TEAM_LEADER` must return `true`; currently returns `false` if `ROLE_TEAM_MEMBER` is index 0. Use only constants present in `RoleHierarchy::ROLES` (e.g., `ROLE_ASSISTANT`, `ROLE_TEAM_MEMBER`, `ROLE_TEAM_LEADER`, `ROLE_ADMIN`).

### B5 — DATA-13: Department comparison by object identity vs ID

**File:** Multiple authorization files (identify via grep on `$department ===` or `$department ==`)
**Fix:** Replace object-identity comparisons (`===`) with ID comparisons (`$a->getId() === $b->getId()`). Doctrine proxies are not reference-equal to the same entity fetched separately.
**Test:** Unit — fetch the same department entity twice from the repository; assert the authorization check correctly identifies them as the same department.

### B6 — INTERVIEW-11: conducted timestamp set in constructor

**File:** `src/App/Interview/Infrastructure/Entity/Interview.php`
**Fix:** `conducted` is set in the constructor, so every new interview has a non-null conducted timestamp even before it is conducted. Set it to `null` in the constructor; only assign it when the interview is actually conducted.
**Test:** Unit — construct a new `Interview`; assert `conducted` is `null`.

### B7 — DATA-8: AssistantHistory format validation

**File:** `src/App/Operations/Infrastructure/Entity/AssistantHistory.php`
**Fix:** Add `#[Assert\Regex]` constraints on `bolk`, `day`, and `workdays` fields to enforce their expected formats (confirm accepted format from existing data/docs before writing the pattern).
**Test:** Unit — invalid format strings must produce violations; valid ones must not.

---

## Batch C: Small Guards & Events (5 items)

### C1 — INTERVIEW-1: InterviewCounter crashes on null score

**File:** `src/App/Interview/Api/State/InterviewConductProcessor.php`
**Fix:** Before incrementing/reading the score counter, null-check the score. If null, skip the counter update or throw a descriptive 422 rather than crashing.
**Test:** Unit — conduct an interview with no score set; assert no unhandled exception.

### C2 — INTERVIEW-4: Department scoping on interview conduct/assign/schedule

**Files:** 4 processor files under `src/App/Interview/Api/State/`: `ConductProcessor`, `AssignProcessor`, `ScheduleProcessor`, and `InterviewBulkAssignProcessor.php` (confirm exact names). All four must be scoped.
**Fix:** Each processor must verify the interview's department matches the acting user's department via `AccessControlService::assertDepartmentAccess()`. Currently any `ROLE_TEAM_MEMBER` can conduct/assign/schedule interviews across departments.
**Test:** Unit per processor — acting user from department A attempts to operate on an interview belonging to department B; assert 403.

### C3 — Missing ProfileProcessor event dispatch

**File:** `src/App/Identity/Api/State/ProfileProcessor.php`
**Fix:** After a successful profile update, dispatch the appropriate domain event. Before creating a new event class: (1) check if the event class already exists in `Domain/Events/`; (2) if not, check what the legacy Controller dispatched — it may be a Symfony event, a custom domain event, or a direct mailer call — and replicate that behaviour rather than inventing a new event.
**Test:** Unit — update a profile; assert the event is dispatched exactly once with the correct payload.

### C4 — Missing TeamApplicationProcessor event dispatch

**File:** `src/App/Organization/Api/State/TeamApplicationProcessor.php`
**Fix:** After a successful team application (create/update), dispatch the appropriate domain event. Before creating a new event class: (1) check if the event class already exists in `Domain/Events/`; (2) if not, check what the legacy Controller dispatched — it may be a Symfony event, a custom domain event, or a direct mailer call — and replicate that behaviour rather than inventing a new event.
**Test:** Unit — submit a team application; assert the event is dispatched.

### C5 — Survey access guard extraction

**Files:** `src/App/Survey/Api/State/` (identify relevant providers/processors)
**Fix:** If survey access is not already scoped by department, add `AccessControlService::assertDepartmentAccess()` to survey read/write operations. If already scoped, document that this item is resolved.
**Test:** Unit — user from department A attempts to access a survey owned by department B; assert 403.

---

## Batch D: DTO Field Gaps (3 items)

### D1 — ProfileResource missing accountNumber, fieldOfStudy

**File:** `src/App/Identity/Api/Resource/ProfileResource.php`
**Fix:** Add `$accountNumber` and `$fieldOfStudy` public properties (nullable). Populate them in the corresponding provider from the `User` entity.
**Test:** Unit — provider maps a `User` with non-null `accountNumber` and `fieldOfStudy`; assert both appear in the resource.

### D2 — Team fields gap in CreateTeamResource

**File:** `src/App/Organization/Api/Resource/AdminTeamWriteResource.php`
**Fix:** Identify which Team entity fields are missing from the write DTO (compare entity fields against DTO properties). Add the missing ones. Confirm field names from the entity before writing.
**Test:** Unit — submit a create-team request with the previously missing fields; assert they are persisted.

### D3 — Static content htmlId lookup

**Files:** `src/App/Content/Api/` (identify provider/processor)
**Fix:** Static content items are fetched or referenced by `htmlId` but the lookup may be missing or using the wrong field. Verify the provider queries by `htmlId`; fix if it is querying by `id` or not at all.
**Test:** Unit — fetch static content by a known `htmlId`; assert the correct item is returned.

---

## Batch E: Deferred (6 items)

Not in scope. Requires architecture decisions before implementation.

| ID | Reason deferred |
|----|----------------|
| AUTH-2 | Default-deny reverted (see revert commit); needs policy decision |
| AUTH-6 | JWT revocation requires token blacklist or short-TTL strategy decision |
| AUTH-7 | Role hierarchy changes carry regression risk to existing permission checks |
| TEAM-4 | Suspended leader batch integration — depends on batch job design |
| DATA-6 | FK cascade policies — need data migration plan |
| DATA-12 | FK cascade policies — need data migration plan |
| INTERVIEW-5 | Response code expiry — needs TTL policy decision |

---

## Testing Strategy

**DB constraint items (A1–A4, A6, A7):** Use `KernelTestCase` + a real SQLite test database. Insert a violating row, wrap in `try/catch`, assert `UniqueConstraintViolationException`. Run `doctrine:fixtures:load` after each constraint addition to verify no fixture data violates the new constraint.

**Validation items (A3–A5, B7):** Use `ValidatorInterface` from the DI container (or instantiate directly). No DB needed.

**Logic fixes (B1–B6, C1–C5):** Unit tests with mocked dependencies where possible. Use `WebTestCase` only when the full request lifecycle is needed (e.g., 403 response codes for department scoping checks).

**DTO field gaps (D1–D3):** Unit test the provider's mapping logic directly — construct an entity, call the provider's `provide()` method with a mocked operation, assert the output resource has the expected fields populated.

---

## Risks

**DB constraints breaking fixture loading.** Any new `UniqueConstraint` or `NotNull` constraint can cause `doctrine:fixtures:load` to fail if existing fixture data violates it. After each constraint item in Batch A: run `APP_ENV=test php bin/console doctrine:fixtures:load` and confirm it exits 0. A fixture failure cascades into 600+ silent test failures (tests pass vacuously against an empty DB).

**Object identity vs proxy.** Batch B5 touches authorization comparisons. After fixing, run the full auth test suite to catch any regression where the old identity comparison was accidentally load-bearing.

**setCancelled side effects (B2).** The `Interview` entity's `setCancelled` may be called from multiple sites. After changing its behavior, grep all call sites and verify none relied on the old implicit `ACCEPTED` assignment.

---

## Parallelism

All 25 items are independent. Suggested dispatch groups (5–6 per worker):

| Worker | Items |
|--------|-------|
| 1 | A1, A2, A3, A4, A5 |
| 2 | A6, A7, A8, A9, A10 |
| 3 | B1, B2, B3, B4 |
| 4 | B5, B6, B7, C1 |
| 5 | C2, C3, C4, C5 |
| 6 | D1, D2, D3 |

Workers 1–2 must verify fixture loading after each DB constraint addition. Workers 3–6 have no fixture risk.

---

## Files Affected

### Modified (representative list — confirm exact paths before dispatch)

| File | Batch item(s) |
|------|--------------|
| `apps/server/src/App/Scheduling/Infrastructure/Entity/SchoolCapacity.php` | A1, A4 |
| `apps/server/src/App/Operations/Infrastructure/Entity/AssistantHistory.php` | A2, B7 |
| `apps/server/src/App/Admission/Infrastructure/Entity/AdmissionPeriod.php` | A3 |
| `apps/server/src/App/Interview/Infrastructure/Entity/InterviewScore.php` | A5 |
| `apps/server/src/App/Operations/Infrastructure/Entity/Receipt.php` | A6 |
| `apps/server/src/App/Organization/Infrastructure/Entity/TeamMembership.php` | A7 |
| `apps/server/src/App/Organization/Api/State/AdminTeamMemberAddProcessor.php` | A8 |
| `apps/server/src/App/Identity/Infrastructure/Entity/User.php` | A9 |
| `apps/server/src/App/Organization/Api/State/AdminTeamMembershipDeleteProcessor.php` | A10 |
| `apps/server/src/App/Interview/Api/Controller/InterviewController.php` | B1 |
| `apps/server/src/App/Interview/Infrastructure/Entity/Interview.php` | B2, B6 |
| `apps/server/src/App/Organization/Infrastructure/Entity/Team.php` | B3 |
| `apps/server/src/App/Identity/Infrastructure/RoleManager.php` | B4 |
| Multiple authorization files | B5 |
| `apps/server/src/App/Interview/Api/State/InterviewConductProcessor.php` | C1 |
| 4× `src/App/Interview/Api/State/` processors (incl. `InterviewBulkAssignProcessor.php`) | C2 |
| `apps/server/src/App/Identity/Api/State/ProfileProcessor.php` | C3 |
| `apps/server/src/App/Organization/Api/State/TeamApplicationProcessor.php` | C4 |
| `apps/server/src/App/Survey/Api/State/` (TBD) | C5 |
| `apps/server/src/App/Identity/Api/Resource/ProfileResource.php` | D1 |
| `apps/server/src/App/Organization/Api/Resource/AdminTeamWriteResource.php` | D2 |
| `apps/server/src/App/Content/Api/` (TBD) | D3 |
