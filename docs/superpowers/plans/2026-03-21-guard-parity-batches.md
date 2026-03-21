# Guard Parity Batches A-D Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Fix 25 independent guard parity items across 4 batches.
**Architecture:** Each item is independent — read file, write failing test, apply fix, verify. Parallelizable.
**Tech Stack:** Symfony 6.4, PHPUnit, Doctrine ORM
**Spec:** docs/superpowers/specs/2026-03-21-guard-parity-batches-design.md

---

## Parallelism Overview

| Worker | Items | Fixture risk? |
|--------|-------|---------------|
| 1 | A1, A2, A3, A4, A5 | Yes — verify fixtures after each |
| 2 | A6, A7, A8, A9, A10 | Yes — verify fixtures after each |
| 3 | B1, B2, B3, B4 | No |
| 4 | B5, B6, B7, C1 | No |
| 5 | C2, C3, C4, C5 | No |
| 6 | D1, D2, D3 | No |

All workers run independently. Workers 1–2 must run the fixture check after every DB constraint item:

```bash
APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction
```

If this exits non-zero, the constraint is too strict for existing fixture data. Fix the fixture or relax the constraint before proceeding.

---

## Worker 1 — Items A1, A2, A3, A4, A5

### A1 — DATA-3: SchoolCapacity unique constraint

**File:** `apps/server/src/App/Scheduling/Infrastructure/Entity/SchoolCapacity.php`
**Fix:** Add `#[ORM\UniqueConstraint]` on `(school_id, semester_id)` columns at the class level.
**Test file:** `apps/server/tests/App/Scheduling/Infrastructure/Entity/SchoolCapacityUniqueConstraintTest.php`
**Test approach:** KernelTestCase + real SQLite. Insert two SchoolCapacity rows with the same school and semester, wrap in try/catch, assert `UniqueConstraintViolationException`.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(scheduling): add unique constraint on SchoolCapacity(school, semester) [A1]`

---

### A2 — DATA-4: AssistantHistory unique constraint

**File:** `apps/server/src/App/Operations/Infrastructure/Entity/AssistantHistory.php`
**Fix:** Add `#[ORM\UniqueConstraint]` on `(user_id, school_id, semester_id)` at the class level.
**Test file:** `apps/server/tests/App/Operations/Infrastructure/Entity/AssistantHistoryUniqueConstraintTest.php`
**Test approach:** KernelTestCase. Duplicate insert must throw; single insert must succeed.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(operations): add unique constraint on AssistantHistory(user, school, semester) [A2]`

---

### A3 — DATA-7: AdmissionPeriod date order validation

**File:** `apps/server/src/App/Admission/Infrastructure/Entity/AdmissionPeriod.php`
**Fix:** Add `#[Assert\LessThan(propertyPath: "endDate")]` on `startDate`. Import `Symfony\Component\Validator\Constraints as Assert`.
**Test file:** `apps/server/tests/App/Admission/Infrastructure/Entity/AdmissionPeriodValidationTest.php`
**Test approach:** Unit — instantiate `ValidatorInterface`, construct an `AdmissionPeriod` with `startDate >= endDate`, assert a violation is returned with the `startDate` path.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(admission): add date order validation on AdmissionPeriod [A3]`

---

### A4 — DATA-9: SchoolCapacity negative value guard

**File:** `apps/server/src/App/Scheduling/Infrastructure/Entity/SchoolCapacity.php`
**Fix:** Add `#[Assert\PositiveOrZero]` on each of the five day-capacity integer fields (`monday`, `tuesday`, `wednesday`, `thursday`, `friday`).
**Test file:** `apps/server/tests/App/Scheduling/Infrastructure/Entity/SchoolCapacityValidationTest.php`
**Test approach:** Unit — set one field to `-1`, validate, assert violation. Set to `0`, validate, assert no violation.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(scheduling): add PositiveOrZero constraints on SchoolCapacity day fields [A4]`

---

### A5 — INTERVIEW-9: InterviewScore range constraints

**File:** `apps/server/src/App/Interview/Infrastructure/Entity/InterviewScore.php`
**Fix:** Add `#[Assert\Range(min: 0, max: 10)]` on `explanatoryPower`, `roleModel`, and `suitability`. Do NOT add Range to `suitableAssistant` — it is validated via the `Suitability` enum in the setter.
**Test file:** `apps/server/tests/App/Interview/Infrastructure/Entity/InterviewScoreValidationTest.php`
**Test approach:** Unit — value of `11` and `-1` each produce a violation on a numeric field; value of `5` produces none.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(interview): add Range(0,10) constraints on InterviewScore numeric fields [A5]`

---

### Representative example for Batch A (A5 — complete code)

**Failing test:**

```php
<?php

namespace App\Tests\App\Interview\Infrastructure\Entity;

use App\Interview\Infrastructure\Entity\InterviewScore;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Validator\Validation;

class InterviewScoreValidationTest extends TestCase
{
    private function makeScore(int $explanatoryPower, int $roleModel, int $suitability): InterviewScore
    {
        $score = new InterviewScore();
        $score->setExplanatoryPower($explanatoryPower);
        $score->setRoleModel($roleModel);
        $score->setSuitability($suitability);
        $score->setSuitableAssistant('ja');
        return $score;
    }

    public function testScoreAboveMaxProducesViolation(): void
    {
        $validator = Validation::createValidatorBuilder()->enableAttributeMapping()->getValidator();
        $score = $this->makeScore(11, 5, 5);

        $violations = $validator->validate($score);

        $this->assertGreaterThan(0, count($violations));
        $paths = array_map(fn($v) => $v->getPropertyPath(), iterator_to_array($violations));
        $this->assertContains('explanatoryPower', $paths);
    }

    public function testScoreBelowMinProducesViolation(): void
    {
        $validator = Validation::createValidatorBuilder()->enableAttributeMapping()->getValidator();
        $score = $this->makeScore(5, -1, 5);

        $violations = $validator->validate($score);

        $this->assertGreaterThan(0, count($violations));
        $paths = array_map(fn($v) => $v->getPropertyPath(), iterator_to_array($violations));
        $this->assertContains('roleModel', $paths);
    }

    public function testValidScoreProducesNoViolation(): void
    {
        $validator = Validation::createValidatorBuilder()->enableAttributeMapping()->getValidator();
        $score = $this->makeScore(5, 7, 3);

        $violations = $validator->validate($score);

        $this->assertCount(0, $violations);
    }
}
```

**Fix (add to each of the three integer fields in InterviewScore.php):**

```php
#[ORM\Column(type: 'integer')]
#[Assert\NotBlank(groups: ['interview'], message: 'Dette feltet kan ikke være tomt.')]
#[Assert\Range(min: 0, max: 10)]
protected $explanatoryPower;
```

Apply identically to `$roleModel` and `$suitability`. Leave `$suitableAssistant` unchanged.

---

## Worker 2 — Items A6, A7, A8, A9, A10

### A6 — RECEIPT-2: Receipt.visualId DB unique constraint

**File:** `apps/server/src/App/Operations/Infrastructure/Entity/Receipt.php`
**Fix:** Find the `$visualId` column mapping and add `unique: true` to its `#[ORM\Column]` attribute.
**Test file:** `apps/server/tests/App/Operations/Infrastructure/Entity/ReceiptUniqueVisualIdTest.php`
**Test approach:** KernelTestCase. Insert two receipts with the same `visualId`, assert `UniqueConstraintViolationException`.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(operations): add DB unique constraint on Receipt.visualId [A6]`

---

### A7 — TEAM-7: TeamMembership unique (user, team, semester)

**File:** `apps/server/src/App/Organization/Infrastructure/Entity/TeamMembership.php`
**Fix:** Add `#[ORM\UniqueConstraint]` on `(user_id, team_id, semester_id)` at the class level.
**Test file:** `apps/server/tests/App/Organization/Infrastructure/Entity/TeamMembershipUniqueConstraintTest.php`
**Test approach:** KernelTestCase. Duplicate membership insert must throw; distinct insert must succeed.

**After fix:** Run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction`

**Commit:** `fix(organization): add unique constraint on TeamMembership(user, team, semester) [A7]`

---

### A8 — DATA-11: 'Medlem' position existence guard

**File:** `apps/server/src/App/Organization/Api/State/AdminTeamMemberAddProcessor.php`
**Fix:** Before creating a membership, query the `Position` repository for `name = 'Medlem'`. If not found, throw `\RuntimeException` or return a 422 `UnprocessableEntityHttpException` with a descriptive message.
**Test file:** `apps/server/tests/App/Organization/Api/State/AdminTeamMemberAddProcessorTest.php`
**Test approach:** Unit with mocked repository. Mock returning `null` for `'Medlem'` — assert 422 or exception is thrown, not a broken membership.

**Commit:** `fix(organization): guard against missing Medlem position in AdminTeamMemberAddProcessor [A8]`

---

### A9 — DATA-14: Password reset expiration check

**File:** `apps/server/src/App/Identity/Infrastructure/Entity/User.php`
**Fix:** In the password-reset token validation method, compare the token creation timestamp against a 24h TTL. Return `false` (or throw) if the token is expired. Read the existing method signature before writing — do not assume the method name.
**Test file:** `apps/server/tests/App/Identity/Infrastructure/Entity/UserPasswordResetTest.php`
**Test approach:** Unit — token created 25h ago must fail; token created 1h ago must pass.

**Commit:** `fix(identity): add expiry check to password reset token validation [A9]`

---

### A10 — TEAM-8: Post-remove entity access in subscriber

**File:** `apps/server/src/App/Organization/Api/State/AdminTeamMembershipDeleteProcessor.php`
**Fix:** Capture all needed data (IDs, denormalized fields) from the entity before calling `EntityManager::remove()` / `flush()`. Do not access the entity after removal. Read the processor and any related subscriber before making changes.
**Test file:** `apps/server/tests/App/Organization/Api/State/AdminTeamMembershipDeleteProcessorTest.php`
**Test approach:** Unit — delete a membership, assert no "entity is detached" or null-access error; assert any side-effect (email, event) still fires with correct data.

**Commit:** `fix(organization): capture entity data before removal in AdminTeamMembershipDeleteProcessor [A10]`

---

## Worker 3 — Items B1, B2, B3, B4

### B1 — INTERVIEW-3: Legacy accept endpoint skips state validation

**File:** `apps/server/src/App/Interview/Api/Controller/InterviewController.php`
**Fix:** The legacy `accept` action sets `interview.accepted = true` directly. Replace with a call to the canonical status-transition method used by the non-legacy path.
**Test file:** `apps/server/tests/App/Interview/Api/Controller/InterviewControllerAcceptTest.php`
**Test approach:** Unit — call accept on an interview already in a terminal state; assert exception or 422, not a silent override.

**Commit:** `fix(interview): route legacy accept endpoint through state machine [B1]`

---

### B2 — INTERVIEW-8: setCancelled(false) silently forces ACCEPTED

**File:** `apps/server/src/App/Interview/Infrastructure/Entity/Interview.php`
**Fix:** Two parts: (a) change `setCancelled(false)` so it does not call `acceptInterview()`; (b) audit whether the `NO_CONTACT → ACCEPTED` transition in `setInterviewStatus()` should be removed — grep all call sites of `setCancelled` and `setInterviewStatus` before removing any transition. Do not remove the transition if any legitimate path depends on it.
**Test file:** `apps/server/tests/App/Interview/Infrastructure/Entity/InterviewCancelledTest.php`
**Test approach:** Unit — call `setCancelled(false)` on an interview with status `NO_CONTACT`; assert status does not silently become `ACCEPTED`.

**Commit:** `fix(interview): setCancelled(false) must not force ACCEPTED status [B2]`

---

### B3 — TEAM-6: Wrong department in getActiveTeamMemberships

**File:** `apps/server/src/App/Organization/Infrastructure/Entity/Team.php`
**Fix:** In the PHP collection filter inside `getActiveTeamMemberships()`, replace `$wh->getUser()->getDepartment()` with `$this->getDepartment()`. The comparison must use the team's department, not the work history user's department.
**Test file:** `apps/server/tests/App/Organization/Infrastructure/Entity/TeamGetActiveMembershipsTest.php`
**Test approach:** Unit — create two teams in different departments; assert `getActiveTeamMemberships()` for a user returns only memberships from the team's own department.

**Commit:** `fix(organization): use team department not user department in getActiveTeamMemberships [B3]`

---

### B4 — DATA-10: RoleManager.userIsGranted only checks first role

**File:** `apps/server/src/App/Identity/Domain/Rules/RoleHierarchy.php`
**Fix:** The bug is in `RoleHierarchy::userIsGranted()`. The method takes `$userRoles[0]` and ignores any additional roles. Fix the loop to check all roles — if any role satisfies the required access level, return `true`. Note: `RoleManager::userIsGranted` already delegates to `RoleHierarchy::userIsGranted`, so the fix belongs in `RoleHierarchy`.
**Test file:** `apps/server/tests/App/Identity/Domain/Rules/RoleHierarchyTest.php`
**Test approach:** Unit — user with roles `['ROLE_TEAM_MEMBER', 'ROLE_TEAM_LEADER']` queried for `ROLE_TEAM_LEADER` must return `true`; currently returns `false` because `ROLE_TEAM_MEMBER` is index 0. Only use constants from `RoleHierarchy::ROLES` (e.g., `ROLE_ASSISTANT`, `ROLE_TEAM_MEMBER`, `ROLE_TEAM_LEADER`, `ROLE_ADMIN`).

**Commit:** `fix(identity): RoleHierarchy.userIsGranted must check all roles not just first [B4]`

---

### Representative example for Batch B (B4 — complete code)

**Failing test:**

```php
<?php

namespace App\Tests\App\Identity\Domain\Rules;

use App\Identity\Domain\Roles;
use App\Identity\Domain\Rules\RoleHierarchy;
use App\Identity\Infrastructure\Entity\User;
use PHPUnit\Framework\TestCase;

class RoleHierarchyTest extends TestCase
{
    private RoleHierarchy $hierarchy;

    protected function setUp(): void
    {
        $this->hierarchy = new RoleHierarchy();
    }

    public function testUserIsGrantedChecksAllRolesNotJustFirst(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getRoles')->willReturn([Roles::TEAM_MEMBER, Roles::TEAM_LEADER]);

        $result = $this->hierarchy->userIsGranted($user, Roles::TEAM_LEADER);

        $this->assertTrue($result, 'userIsGranted should return true when any role satisfies the required level');
    }

    public function testUserIsGrantedReturnsFalseWhenNoRoleSuffices(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getRoles')->willReturn([Roles::ASSISTANT]);

        $result = $this->hierarchy->userIsGranted($user, Roles::TEAM_LEADER);

        $this->assertFalse($result);
    }

    public function testUserWithSingleHighRoleIsGranted(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getRoles')->willReturn([Roles::ADMIN]);

        $result = $this->hierarchy->userIsGranted($user, Roles::TEAM_MEMBER);

        $this->assertTrue($result);
    }
}
```

**Fix (replace `userIsGranted` in `RoleHierarchy.php`):**

```php
public function userIsGranted(User $user, string $role): bool
{
    $userRoles = $user->getRoles();
    if (count($userRoles) === 0) {
        return false;
    }

    $roleAccessLevel = array_search($role, self::ROLES, true);
    if ($roleAccessLevel === false) {
        return false;
    }

    foreach ($userRoles as $userRole) {
        $userAccessLevel = array_search($userRole, self::ROLES, true);
        if ($userAccessLevel !== false && $userAccessLevel >= $roleAccessLevel) {
            return true;
        }
    }

    return false;
}
```

---

## Worker 4 — Items B5, B6, B7, C1

### B5 — DATA-13: Department comparison by object identity vs ID

**Files:** Multiple authorization files. First grep for `$department ===` and `$department ==` across `apps/server/src/`.
**Fix:** Replace object-identity comparisons (`===`, `==`) with ID comparisons (`$a->getId() === $b->getId()`). Doctrine proxies are not reference-equal to the same entity fetched via different queries.
**Test file:** `apps/server/tests/App/Identity/Infrastructure/DepartmentComparisonTest.php` (or alongside each affected file)
**Test approach:** Unit — fetch the same department twice (second as a mock with same ID); assert the authorization check correctly identifies them as the same department.

**Commit:** `fix(identity): replace object identity department comparisons with ID comparisons [B5]`

---

### B6 — INTERVIEW-11: conducted timestamp set in constructor

**File:** `apps/server/src/App/Interview/Infrastructure/Entity/Interview.php`
**Fix:** Find the `conducted` property assignment in the constructor and remove it (set to `null`). Only assign it when the interview is actually conducted (in `setConducted()` call sites, which is already handled in `InterviewConductProcessor`).
**Test file:** `apps/server/tests/App/Interview/Infrastructure/Entity/InterviewConstructorTest.php`
**Test approach:** Unit — `new Interview()` must have `conducted === null`.

**Commit:** `fix(interview): set conducted to null in constructor not DateTime [B6]`

---

### B7 — DATA-8: AssistantHistory format validation

**File:** `apps/server/src/App/Operations/Infrastructure/Entity/AssistantHistory.php`
**Fix:** Add `#[Assert\Regex]` constraints on `bolk`, `day`, and `workdays` fields. Before writing the pattern, read the entity and look at existing data in fixtures to confirm accepted format. Do not guess the format.
**Test file:** `apps/server/tests/App/Operations/Infrastructure/Entity/AssistantHistoryValidationTest.php`
**Test approach:** Unit — invalid format strings produce violations; valid ones do not.

**Commit:** `fix(operations): add format validation constraints on AssistantHistory fields [B7]`

---

### C1 — INTERVIEW-1: InterviewCounter crashes on null score

**File:** `apps/server/src/App/Interview/Api/State/InterviewConductProcessor.php`
**Fix:** In the score-handling block (`if ($data->interviewScore !== [])`), the counter update (if any) reads from the score. Add a null-check before accessing the score for counter purposes. If no `InterviewCounter` is involved, re-read the processor to confirm where the null crash originates and fix accordingly.
**Test file:** `apps/server/tests/App/Interview/Api/State/InterviewConductProcessorNullScoreTest.php`
**Test approach:** Unit — conduct an interview with `interviewScore = []` (no score); assert no unhandled exception is thrown.

**Commit:** `fix(interview): guard against null score in InterviewConductProcessor [C1]`

---

### Representative example for Batch C (C1 — complete code)

**Failing test:**

```php
<?php

namespace App\Tests\App\Interview\Api\State;

use ApiPlatform\Metadata\Put;
use App\Interview\Api\Resource\InterviewConductInput;
use App\Interview\Api\State\InterviewConductProcessor;
use App\Interview\Infrastructure\Entity\Interview;
use App\Interview\Infrastructure\InterviewManager;
use App\Identity\Infrastructure\Entity\User;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityRepository;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;

class InterviewConductProcessorNullScoreTest extends TestCase
{
    public function testConductWithNoScoreDoesNotThrow(): void
    {
        $interview = $this->createMock(Interview::class);
        $interview->method('getInterviewScore')->willReturn(null);
        $interview->method('getInterviewAnswers')->willReturn([]);
        $interview->method('getApplication')->willReturn(null);

        $repo = $this->createMock(EntityRepository::class);
        $repo->method('find')->willReturn($interview);

        $em = $this->createMock(EntityManagerInterface::class);
        $em->method('getRepository')->willReturn($repo);

        $interviewManager = $this->createMock(InterviewManager::class);
        $interviewManager->method('loggedInUserCanSeeInterview')->willReturn(true);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($this->createMock(User::class));

        $dispatcher = $this->createMock(EventDispatcherInterface::class);

        $processor = new InterviewConductProcessor($em, $interviewManager, $dispatcher, $security);

        $input = new InterviewConductInput();
        $input->answers = [];
        $input->interviewScore = [];

        // Must not throw
        $processor->process($input, new Put(), ['id' => 1]);
        $this->assertTrue(true);
    }
}
```

The fix is already present in `InterviewConductProcessor` — the `if ($data->interviewScore !== [])` guard skips score logic when no score is provided. If a crash still occurs, read the processor to identify which specific counter or access causes the null-pointer and add a targeted null check.

---

## Worker 5 — Items C2, C3, C4, C5

### C2 — INTERVIEW-4: Department scoping on interview conduct/assign/schedule

**Files:** `apps/server/src/App/Interview/Api/State/` — the four processors: `InterviewConductProcessor.php`, `InterviewAssignProcessor.php` (confirm name), `InterviewScheduleProcessor.php` (confirm name), `InterviewBulkAssignProcessor.php`. Confirm exact filenames by listing the directory.
**Fix:** Each processor must call `AccessControlService::assertDepartmentAccess()` to verify the interview's department matches the acting user's department. Import `AccessControlService` from `App\Identity\Infrastructure\AccessControlService`.
**Test file:** One test class per processor, e.g. `tests/App/Interview/Api/State/InterviewConductProcessorDeptTest.php`
**Test approach:** Unit per processor — acting user from department A attempts to operate on an interview belonging to department B; assert `AccessDeniedHttpException`.

**Commit:** `fix(interview): add department scoping to conduct/assign/schedule processors [C2]`

---

### C3 — Missing ProfileProcessor event dispatch

**File:** `apps/server/src/App/Identity/Api/State/ProfileProcessor.php`
**Fix:** After a successful profile update, dispatch the appropriate domain event. Before creating anything new: (1) check if the event class already exists in `Domain/Events/`; (2) if not, check what the legacy Controller dispatched and replicate that behavior. Do not invent a new event class.
**Test file:** `apps/server/tests/App/Identity/Api/State/ProfileProcessorTest.php`
**Test approach:** Unit — update a profile; assert the event is dispatched exactly once with the correct payload.

**Commit:** `fix(identity): dispatch domain event after profile update in ProfileProcessor [C3]`

---

### C4 — Missing TeamApplicationProcessor event dispatch

**File:** `apps/server/src/App/Organization/Api/State/TeamApplicationProcessor.php`
**Fix:** After a successful team application (create/update), dispatch the appropriate domain event. Same lookup procedure as C3 — check existing events and legacy Controller before creating anything new.
**Test file:** `apps/server/tests/App/Organization/Api/State/TeamApplicationProcessorTest.php`
**Test approach:** Unit — submit a team application; assert the event is dispatched.

**Commit:** `fix(organization): dispatch domain event after team application in TeamApplicationProcessor [C4]`

---

### C5 — Survey access guard extraction

**Files:** `apps/server/src/App/Survey/Api/State/` — list the directory, identify relevant providers/processors.
**Fix:** If survey read/write operations are not already scoped by department, add `AccessControlService::assertDepartmentAccess()`. If already scoped, document the finding as a comment and mark the item resolved with no code change needed.
**Test file:** `apps/server/tests/App/Survey/Api/State/SurveyDepartmentScopingTest.php`
**Test approach:** Unit — user from department A attempts to access a survey owned by department B; assert 403.

**Commit:** `fix(survey): add department scoping guard to survey access [C5]`

---

## Worker 6 — Items D1, D2, D3

### D1 — ProfileResource missing accountNumber, fieldOfStudy

**File:** `apps/server/src/App/Identity/Api/Resource/ProfileResource.php`
**Fix:** Add `public ?string $accountNumber = null;` and `public ?string $fieldOfStudy = null;` properties. Also update the corresponding provider (`ProfileProvider`) to populate these from the `User` entity. Verify the field names on the entity before writing.
**Test file:** `apps/server/tests/App/Identity/Api/State/ProfileProviderMappingTest.php`
**Test approach:** Unit — provider maps a `User` with non-null `accountNumber` and `fieldOfStudy`; assert both appear in the `ProfileResource` output.

**Commit:** `feat(identity): add accountNumber and fieldOfStudy to ProfileResource [D1]`

---

### D2 — Team fields gap in CreateTeamResource

**File:** `apps/server/src/App/Organization/Api/Resource/AdminTeamWriteResource.php`
**Fix:** Compare the `Team` entity's fields against the write DTO properties. Add any missing ones. Read both files before writing — do not guess field names.
**Test file:** `apps/server/tests/App/Organization/Api/Resource/AdminTeamWriteResourceTest.php`
**Test approach:** Unit — submit a create-team request with the previously missing fields; assert they are persisted to the entity.

**Commit:** `feat(organization): add missing fields to AdminTeamWriteResource [D2]`

---

### D3 — Static content htmlId lookup

**Files:** `apps/server/src/App/Content/Api/` — list the directory, identify provider/processor for static content.
**Fix:** Verify the provider queries by `htmlId`. If it queries by `id` or not at all, fix the lookup. Read the provider and the entity before writing.
**Test file:** `apps/server/tests/App/Content/Api/State/StaticContentProviderTest.php`
**Test approach:** Unit — fetch static content by a known `htmlId`; assert the correct item is returned.

**Commit:** `fix(content): ensure static content provider queries by htmlId [D3]`

---

### Representative example for Batch D (D1 — complete code)

**File to modify — ProfileResource.php (add two properties):**

```php
// Add after the existing $profilePhoto property:
public ?string $accountNumber = null;

public ?string $fieldOfStudy = null;
```

**Failing test:**

```php
<?php

namespace App\Tests\App\Identity\Api\State;

use ApiPlatform\Metadata\Get;
use App\Identity\Api\Resource\ProfileResource;
use App\Identity\Api\State\ProfileProvider;
use App\Identity\Infrastructure\Entity\User;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;

class ProfileProviderMappingTest extends TestCase
{
    public function testProviderMapsAccountNumberAndFieldOfStudy(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getId')->willReturn(42);
        $user->method('getFirstName')->willReturn('Kari');
        $user->method('getLastName')->willReturn('Nordmann');
        $user->method('getUsername')->willReturn('karinord');
        $user->method('getEmail')->willReturn('kari@example.com');
        $user->method('getPhone')->willReturn(null);
        $user->method('getGender')->willReturn(null);
        $user->method('getAccountNumber')->willReturn('1234.56.78901');
        $user->method('getFieldOfStudy')->willReturn(null); // may be an entity — adjust if needed
        $user->method('getProfilePicture')->willReturn(null);
        $user->method('getRoles')->willReturn(['ROLE_USER']);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($user);

        $provider = new ProfileProvider($security);
        /** @var ProfileResource $resource */
        $resource = $provider->provide(new Get(), []);

        $this->assertSame('1234.56.78901', $resource->accountNumber);
    }
}
```

Note: `ProfileProvider`'s actual constructor signature may differ. Read the file before writing the test — adjust the mock and constructor call to match. The point of this test is to verify the field is populated, not to test the constructor.

---

## Shared Workflow for All Workers

For each item:

1. Read the target file(s) before writing any code.
2. Write the failing test. Run it to confirm it fails for the right reason.
3. Apply the fix.
4. Run the test again. Confirm it passes.
5. For Workers 1–2 only: run `APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction` after each DB-constraint item.
6. Run the targeted test file one more time to guard against stale cache issues.
7. Commit with the message shown for each item.

**Test run command pattern:**

```bash
cd apps/server && php -d memory_limit=512M bin/phpunit tests/path/to/TheTest.php --no-coverage
```

**After all items in a worker are complete, run the full suite:**

```bash
cd apps/server && php -d memory_limit=512M bin/phpunit --no-coverage > /tmp/phpunit-worker-N.txt 2>&1
tail -5 /tmp/phpunit-worker-N.txt
```

If >50% of tests fail, suspect a fixture loading or config error — do not hunt individual test bugs. Check `doctrine:fixtures:load` first.
