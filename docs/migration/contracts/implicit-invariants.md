# Implicit Invariants Audit

Business rules enforced by caller convention rather than by DB constraints, entity validation, or framework guards. These are the rules that silently break when a new code path forgets to check them.

Organized by severity. Each entry documents the rule, where it's (not) enforced, and what breaks.

---

## Critical

Rules where violation causes crashes, data corruption, or security bypass.

### AUTH-1: Deactivated users can use the API

| | |
|---|---|
| **Rule** | `user.isActive = false` must lock the user out of all routes |
| **Enforced** | `UserChecker` is configured on `admin_area` and `secured_area` firewalls, but NOT on `api` or `api_login` firewalls (`security.yaml:34-51`) |
| **Fix** | Add `user_checker: App\Security\UserChecker` to `api` and `api_login` firewalls |
| **If violated** | Deactivated user with valid JWT (1h TTL) retains full API access. Can even obtain a new JWT via `/api/login`. |

### AUTH-2: Access control is default-allow for unknown routes

| | |
|---|---|
| **Rule** | Routes without an AccessRule should be denied by default |
| **Enforced** | `AccessControlSubscriber.php:119` returns `true` when no matching rule exists. Unmatched routes are logged to `UnhandledAccessRule` but not blocked. |
| **Fix** | Default-deny: return `false` when no AccessRule matches |
| **If violated** | Any new API endpoint is open to all authenticated users until someone manually creates an AccessRule in the database. |

### AUTH-3: AssistantHistory delete auth check never throws

| | |
|---|---|
| **Rule** | Only authorized users can delete assistant histories |
| **Enforced** | `AssistantHistoryController.php:30` calls `$this->createAccessDeniedException()` but does NOT `throw` it. The exception is created and discarded. |
| **Fix** | Add `throw` keyword |
| **If violated** | Any authenticated user can delete any assistant history from any department. |

### AUTH-4: No department scoping on ~10 admin API endpoints

| | |
|---|---|
| **Rule** | Non-admin users should only access/modify data within their own department |
| **Enforced** | Inconsistently. Some providers check (e.g., `AdminInterviewListProvider`), most do not. |
| **Unscoped endpoints** | `AdminApplicationListProvider`, `AdminSurveyListProvider`, `AdminUserListProvider`, `MailingListProvider`, `AdmissionStatisticsProvider`, `AdminAdmissionPeriodCreateProcessor`, `AdminSchoolCreateProcessor`, `AdminTeamMemberAddProcessor`, `AdminSocialEventCreateProcessor` |
| **Fix** | Centralized department-scoping voter or middleware |
| **If violated** | A team member in Trondheim can view applications, user lists, email lists, and statistics for Bergen. |

### AUTH-5: Destructive operations require only ROLE_TEAM_MEMBER

| | |
|---|---|
| **Rule** | Deleting teams, admission periods, and similar should require elevated roles |
| **Enforced** | API Platform `security` attributes set to `ROLE_TEAM_MEMBER` on: `AdminTeamDeleteResource`, `AdminAdmissionPeriodDeleteResource`, `AdminAdmissionPeriodWriteResource` |
| **Fix** | Require `ROLE_TEAM_LEADER` or `ROLE_ADMIN` |
| **If violated** | Any team member can delete any team or admission period across the entire organization. |

### APP-1: Application uniqueness — 3 of 4 creation paths skip the check

| | |
|---|---|
| **Rule** | At most one application per user per admission period |
| **Enforced** | `ApplicationEmailValidator` (only in `admission` validation group), `ExistingUserApplicationProcessor` (checks). NOT checked by: `AdminApplicationCreateProcessor`, `AdmissionAdminController::createApplicationAction`, `ApplicationProcessor` (API). |
| **Fix** | DB unique constraint on `(user_id, admission_period_id)` |
| **If violated** | Duplicate applications. Interview scheduling and statistics double-count. |

### APP-2: Application can be persisted without admission period

| | |
|---|---|
| **Rule** | Every application must have an admission period |
| **Enforced** | Caller convention. `AdminApplicationCreateProcessor` conditionally sets it (`if ($admissionPeriod !== null)`). No `NotNull` on entity. |
| **Fix** | `#[Assert\NotNull]` on entity + `nullable: false` in ORM |
| **If violated** | `Application::getSemester()` and `getDepartment()` crash with null dereference. |

### INTERVIEW-1: `InterviewCounter::count()` crashes on null score

| | |
|---|---|
| **Rule** | Conducted interviews must have scores |
| **Enforced** | `InterviewConductProcessor` sets `interviewed = true` regardless of whether score input was provided. Legacy controller uses form validation. |
| **Fix** | Guard in processor: reject if score fields are null when `interviewed = true` |
| **If violated** | `InterviewCounter.php:30` — `$interview->getInterviewScore()->getSuitableAssistant()` null pointer crash. |

### INTERVIEW-2: `isInterviewer()` crashes on null interviewer

| | |
|---|---|
| **Rule** | Interviewer must be non-null before calling `isInterviewer()` |
| **Enforced** | Not enforced. `interviewer` has `onDelete: SET NULL`. `isInterviewer()` at `Interview.php:369` calls `getInterviewer()->getId()` without null check. |
| **Fix** | Null guard in method, or change to `onDelete: RESTRICT` |
| **If violated** | Deleting an interviewer user crashes `InterviewManager::loggedInUserCanSeeInterview()`. |

### TEAM-1: `getLatestAdmissionPeriod()` crashes on empty collection

| | |
|---|---|
| **Rule** | Department must have admission periods before calling temporal methods |
| **Enforced** | `Department.php:129-146` — `current()` returns `false` on empty array, then `false->getSemester()` crashes. |
| **Fix** | Early return null on empty collection |
| **If violated** | Any department without admission periods crashes `TeamMembership::isActive()`, `Team::getActiveTeamMemberships()`, and all callers. |

### TEAM-2: `User::getDepartment()` crashes on null fieldOfStudy

| | |
|---|---|
| **Rule** | User must have a fieldOfStudy to derive department |
| **Enforced** | Partially by form validation groups. `fieldOfStudy` has `onDelete: SET NULL` — deleting a FieldOfStudy silently nulls the FK. |
| **Fix** | Null guard in `getDepartment()`, or `onDelete: RESTRICT` |
| **If violated** | Fatal error in dozens of call sites that chain `$user->getDepartment()`. |

### DATA-1: Semester uniqueness — race condition in auto-create

| | |
|---|---|
| **Rule** | Each (semesterTime, year) pair must be unique |
| **Enforced** | Application-layer query in `SemesterRepository::findOrCreateCurrentSemester()` (find, then create without lock). No DB unique constraint. |
| **Fix** | `#[ORM\UniqueConstraint]` on `(semesterTime, year)` |
| **If violated** | `NonUniqueResultException` crash. All semester-based lookups break. |

### DATA-2: AdmissionPeriod uniqueness — no DB constraint

| | |
|---|---|
| **Rule** | One admission period per department per semester |
| **Enforced** | Application-layer query only (TOCTOU race possible). |
| **Fix** | `#[ORM\UniqueConstraint]` on `(department_id, semester_id)` |
| **If violated** | `NonUniqueResultException` crash. Multiple active admission periods cause double-counting. |

### DATA-3: SchoolCapacity uniqueness — no DB constraint

| | |
|---|---|
| **Rule** | One capacity record per school per semester per department |
| **Enforced** | `findBySchoolAndSemester` uses `getSingleResult()` — crashes on duplicates. No creation guard. |
| **Fix** | `#[ORM\UniqueConstraint]` on `(school_id, semester_id, department_id)` |
| **If violated** | `NonUniqueResultException` crash on scheduling page. |

---

## High

Rules where violation causes wrong business logic, authorization gaps, or silent data corruption.

### AUTH-6: No JWT revocation mechanism

| | |
|---|---|
| **Rule** | Deactivated/demoted users should lose access immediately |
| **Enforced** | JWT has 1h TTL, no blacklist. Combined with AUTH-1, deactivation doesn't lock out API users at all. |
| **If violated** | Demoted user retains old privileges for up to 1 hour (or indefinitely if AUTH-1 isn't fixed). |

### AUTH-7: AccessControlService ignores Symfony role hierarchy

| | |
|---|---|
| **Rule** | `TEAM_LEADER` includes `TEAM_MEMBER` permissions |
| **Enforced** | `AccessControlService.php:207-218` does literal `in_array()` string match, not `RoleHierarchyInterface::getReachableRoleNames()`. |
| **If violated** | TEAM_LEADER denied access to resources that require TEAM_MEMBER but don't separately list TEAM_LEADER. |

### INTERVIEW-3: Legacy accept endpoint skips state validation

| | |
|---|---|
| **Rule** | Accept should only work from PENDING state |
| **Enforced** | API processor checks `isPending()`. Legacy `InterviewController::acceptByResponseCodeAction` does not. |
| **If violated** | A cancelled interview can be re-accepted via the legacy route. |

### INTERVIEW-4: No department-scoped auth on interview API endpoints

| | |
|---|---|
| **Rule** | Team members should only manage interviews in their department |
| **Enforced** | API resources check `ROLE_TEAM_MEMBER` only. No department check in `InterviewConductProcessor`, `InterviewAssignProcessor`, etc. |
| **If violated** | Any team member can conduct, schedule, or assign interviews across all departments. |

### INTERVIEW-5: Response codes never expire

| | |
|---|---|
| **Rule** | Interview response codes should have a time limit |
| **Enforced** | 24-char hex token, no expiry, no rate limiting, no invalidation after use. |
| **If violated** | Leaked response codes allow permanent unauthenticated interview status changes. |

### INTERVIEW-6: `initializeInterviewAnswers()` crashes on null schema

| | |
|---|---|
| **Rule** | Interview must have an interviewSchema before answers can be initialized |
| **Enforced** | `InterviewManager.php:62` calls `$interview->getInterviewSchema()->getInterviewQuestions()` without null check. Schema is nullable. |
| **If violated** | Fatal error when conducting an interview with no schema assigned. |

### TEAM-3: `isActive()` does not check `isSuspended`

| | |
|---|---|
| **Rule** | Suspended members should not be considered active |
| **Enforced** | `TeamMembership::isActive()` and `isActiveInSemester()` only check temporal range. Callers must check `isSuspended` independently. |
| **If violated** | Suspended users appear active in `getActiveTeamMemberships()`, retain role-based access via `AccessControlService`, keep TEAM_LEADER privileges. |

### TEAM-4: Suspended team leader retains role between batch runs

| | |
|---|---|
| **Rule** | `isTeamLeader = true` implies active and not suspended |
| **Enforced** | `RoleManager::userIsInATeam()` checks `isActiveInSemester()` and `isTeamLeader()` but NOT `isSuspended()`. Roles update only when `updateUserRole()` is triggered. |
| **If violated** | Suspended leader retains TEAM_LEADER role until next batch run. |

### TEAM-5: Team/position null dereference after SET NULL cascade

| | |
|---|---|
| **Rule** | `deletedTeamName` must be set before team FK becomes null |
| **Enforced** | Set in `TeamAdminController` and `AdminTeamDeleteProcessor`. NOT set when deletion cascades from Department (`cascade: ['remove']` on teams). |
| **If violated** | `TeamMembership::isActive()` crashes (`$this->team->getDepartment()` on null). `getPositionName()` crashes similarly. |

### TEAM-6: `Team::getActiveTeamMemberships()` uses wrong department

| | |
|---|---|
| **Rule** | Active semester should be determined from the team's department |
| **Enforced** | `Team.php:306` uses `$wh->getUser()->getDepartment()` (user's department via fieldOfStudy), not the team's department. |
| **If violated** | Cross-department team members have inconsistent active/inactive status depending on which code path checks. |

### DATA-4: AssistantHistory duplicate prevention — not enforced

| | |
|---|---|
| **Rule** | No duplicate (user, school, semester) assignments |
| **Enforced** | Neither API nor legacy controller checks before creating. |
| **Fix** | DB unique constraint on `(user_id, school_id, semester_id)` |
| **If violated** | Statistics double-count. Scheduling shows same person twice. |

### DATA-5: AssistantHistory is fully mutable and deletable — no audit trail

| | |
|---|---|
| **Rule** | Historical records should be append-only or at least audit-logged |
| **Enforced** | Legacy `AssistantHistoryController::deleteAction` logs via `LogService`. API delete processor and `SchoolAdminController::removeUserFromSchoolAction` do not log. |
| **If violated** | Historical data disappears silently. Certificates and statistics become retroactively wrong. |

### DATA-6: Semester/school deletion orphans records via SET NULL

| | |
|---|---|
| **Rule** | Don't delete semesters or schools with existing references |
| **Enforced** | No pre-delete check. `AssistantHistory.semester` and `AssistantHistory.school` both have `onDelete: SET NULL`. |
| **If violated** | Records lose their semester/school reference. `getSemester()` / `getSchool()` calls crash with null dereference. |

---

## Medium

Rules where violation causes wrong UI, incorrect statistics, or minor authorization issues.

### INTERVIEW-7: `setStatus()` allows arbitrary state transitions

| | |
|---|---|
| **Rule** | Status transitions should follow the state machine |
| **Enforced** | `Interview.php:556-563` validates range 0-4 only. Any valid integer can be set from any state. |
| **If violated** | Conducted interview reset to NO_CONTACT. Cancelled interview silently un-cancelled. |

### INTERVIEW-8: `setCancelled(false)` silently forces ACCEPTED

| | |
|---|---|
| **Rule** | Reversal should be context-dependent |
| **Enforced** | `Interview.php:303-309` — `setCancelled(false)` unconditionally calls `acceptInterview()`. |
| **If violated** | Calling on a PENDING interview overwrites status to ACCEPTED, losing the applicant's response. |

### INTERVIEW-9: Score fields have no range constraints

| | |
|---|---|
| **Rule** | `explanatoryPower`, `roleModel`, `suitability` should have valid ranges |
| **Enforced** | No `Assert\Range`. API processor uses `?? 0` fallback. |
| **If violated** | Negative or enormous scores. Rankings and comparisons produce wrong results. |

### INTERVIEW-10: `suitableAssistant` is a free-form string

| | |
|---|---|
| **Rule** | Must be one of `'Ja'`, `'Kanskje'`, `'Nei'` |
| **Enforced** | `InterviewScore.php:31` is an unconstrained string. `InterviewConductProcessor` uses `?? ''` fallback. |
| **If violated** | `InterviewCounter::count()` silently ignores non-matching values. Statistics are wrong. |

### INTERVIEW-11: `conducted` timestamp set in constructor

| | |
|---|---|
| **Rule** | Should be null until interview is actually conducted |
| **Enforced** | `Interview.php:114` sets `$this->conducted = new DateTime()` in constructor. |
| **If violated** | Any code checking `conducted !== null` as a proxy for "was conducted" gets false positives. |

### INTERVIEW-12: API always sends email — no draft/save-only option

| | |
|---|---|
| **Rule** | Legacy had separate "save" and "save and send" buttons |
| **Enforced** | `InterviewScheduleProcessor.php:64-67` always dispatches email event. `InterviewConductProcessor` always sets `interviewed = true`. |
| **If violated** | Every schedule update emails the applicant, even for minor corrections. No draft-save API path. |

### RECEIPT-1: No state machine — any status can be set from any status

| | |
|---|---|
| **Rule** | Only `pending -> refunded` and `pending -> rejected` should be allowed |
| **Enforced** | `AdminReceiptStatusInput` validates the value is one of the three statuses. No transition logic. |
| **If violated** | Refunded receipt moved back to pending. Rejected receipt marked refunded. `refundDate` not cleared on reversal. |

### RECEIPT-2: `visualId` not DB-unique

| | |
|---|---|
| **Rule** | Each receipt should have a unique display ID |
| **Enforced** | Generated from millisecond timestamp. No DB unique constraint. |
| **If violated** | Concurrent requests in same millisecond produce duplicate IDs. |

### DATA-7: AdmissionPeriod `startDate < endDate` not validated

| | |
|---|---|
| **Rule** | Start must precede end |
| **Enforced** | Not validated anywhere — entity, form, DTO, or processor. |
| **If violated** | `hasActiveAdmission()` never returns true. Applications become impossible. |

### DATA-8: `bolk`, `day`, `workdays` on AssistantHistory are free-form strings

| | |
|---|---|
| **Rule** | Should be controlled vocabulary |
| **Enforced** | Only `#[Assert\NotBlank]`. `activeInGroup()` does `str_contains($this->bolk, "Bolk $group")` — expects specific format. |
| **If violated** | Scheduling algorithm silently excludes assistants with non-standard bolk values. |

### DATA-9: SchoolCapacity accepts negative values

| | |
|---|---|
| **Rule** | Day capacities should be non-negative |
| **Enforced** | No validation constraints on capacity fields. |
| **If violated** | Scheduling algorithm receives negative capacity, undefined behavior. |

### DATA-10: `RoleManager.userIsGranted` only checks first role

| | |
|---|---|
| **Rule** | Should consider all assigned roles |
| **Enforced** | `RoleManager.php:94` — `$user->getRoles()[0]`. Works by convention since `setUserRole` replaces all roles, but `addRole()` exists with no guard. |
| **If violated** | User with multiple roles may have lower effective permissions than intended. |

### DATA-11: Position 'Medlem' must exist in database

| | |
|---|---|
| **Rule** | Default position for new team members |
| **Enforced** | Seed-data convention. `findOneBy(['name' => 'Medlem'])` in two processors. |
| **If violated** | Membership saved with null position. `getPositionName()` crashes later. |

---

## Low

Maintenance hazards unlikely to cause immediate issues.

### INTERVIEW-13: Reminder counter has no entity-level bounds

`numAcceptInterviewRemindersSent` can be set to any value via public setter. Cap of 3 enforced only in `InterviewManager::sendAcceptInterviewReminders()`.

### INTERVIEW-14: `isDraft()` is a phantom state

Defined in entity (`Interview.php:439-442`) but never used to gate any operation. No code path checks it.

### INTERVIEW-15: `InterviewAnswer` FK has no ON DELETE behavior

Deleting an interview question with existing answers will either fail with FK constraint or leave orphans depending on DB engine config.

### TEAM-7: No duplicate membership guard (same user, same team)

No unique constraint or application check on `(user_id, team_id, start_semester_id)`. Admin UI would show duplicate entries.

### TEAM-8: Post-remove entity access in subscriber

`AdminTeamMembershipDeleteProcessor` calls `em->remove()` then dispatches event. Subscriber accesses detached entity associations — fragile under lazy loading.

### DATA-12: User deletion cascades to interview deletion

`Interview.user` has `onDelete: CASCADE`. Deleting a user silently destroys their interviews, scores, and answers with no audit trail.

### DATA-13: Department comparison by object identity

Authorization checks like `$this->getUser()->getDepartment() !== $department` use PHP `!==` (identity) instead of comparing IDs. Fragile under entity detachment.

### DATA-14: Password reset has no expiration enforcement in entity

`resetTime` field exists but no `isExpired()` method. Expiration must be checked by caller.
