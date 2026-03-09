# API Platform Guard Parity Design

## Goal

Bring all API Platform processors/providers in `apps/server` to full behavioral parity with their corresponding monolith Twig controllers. Fix security gaps, missing preconditions, missing side effects, validation gaps, and auth level mismatches — without touching the Twig controllers.

## Context

The Symfony 3.4 → 6.4 migration retained all Twig controllers as faithful 1:1 ports and added a parallel API Platform JSON/JWT layer. The API Platform layer has systematic divergences documented in [`docs/migration/server-comparison.md`](../migration/server-comparison.md):

- **12+ guard downgrades** (TEAM_LEADER/ADMIN → TEAM_MEMBER)
- **5+ domains missing department scoping**
- **6+ missing controller-level guards** (`loggedInUserCanSeeInterview`, `ensureAccess`, self-interview block, etc.)
- **DTO validation gaps** (entity constraints not replicated on DTOs)
- **Missing side effects** (events not dispatched, fields not updated)
- **3 auth escalations** (API stricter than monolith — needs relaxing)

## Approach

### Principle: single source of truth for business rules

Where the missing guard logic exists as a service method (e.g., `InterviewManager::loggedInUserCanSeeInterview`), the processor calls it directly.

Where the guard logic is inline in a controller (e.g., `SurveyController::ensureAccess()`), extract it into the appropriate service first, then call from the processor. This prevents future drift between controllers and processors.

### Service extractions

| Logic | Source | Target service | Method signature |
|-------|--------|---------------|-----------------|
| Department + confidentiality access check | `SurveyController::ensureAccess()` (private) | `AccessControlService` | `assertSurveyAccess(Survey $survey, User $user): void` |
| Department access check (reusable) | Various controllers (inline) | `AccessControlService` | `assertDepartmentAccess(Department $dept, User $user): void` |

All other guards either already exist as service methods or are simple entity-method calls (e.g., `$team->getAcceptApplicationAndDeadline()`) that don't need extraction.

### Work by domain

#### Interview (6 processor changes)

| Processor | Fix | Type |
|-----------|-----|------|
| `InterviewConductProcessor` | Add `InterviewManager::loggedInUserCanSeeInterview()` call | Missing guard |
| `InterviewConductProcessor` | Add self-interview block (`$actor === $application->getUser()`) | Missing guard |
| `InterviewConductProcessor` | Add `$interview->setCancelled(false)` | Missing effect |
| `InterviewConductProcessor` | Add draft-save path (save without `interviewed=true` when flag absent) | Missing feature |
| `InterviewScheduleProcessor` | Add `InterviewManager::loggedInUserCanSeeInterview()` call | Missing guard |
| `InterviewAssignInput` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `InterviewBulkAssignInput` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `InterviewDeleteResource` | Change security to `ROLE_ADMIN` | Guard downgrade |

#### Team / Membership / Executive Board (8 resource + processor changes)

| Resource/Processor | Fix | Type |
|-------------------|-----|------|
| `AdminTeamWriteResource` (Post) | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminTeamWriteResource` (Put) | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminTeamDeleteResource` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminTeamMemberInput` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminTeamMembershipWriteResource` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminExecutiveBoardMemberDeleteResource` | Change security to `ROLE_ADMIN` | Guard downgrade |
| `AdminTeamWriteResource` DTO | Add `Assert\Email`, `@VektorEmail`, `@UniqueCompanyEmail` on email; `Assert\Length(max: 125)` on shortDescription; add `acceptApplication`, `deadline`, `active` fields | Validation gap + missing fields |
| `TeamApplicationProcessor` | Add `$team->getAcceptApplicationAndDeadline()` check | Missing precondition |
| Team entity `ApiResource` | Add provider that filters inactive teams for anonymous/non-TEAM_MEMBER users | Missing guard |

#### Admission / Application (4 processor changes)

| Processor | Fix | Type |
|-----------|-----|------|
| `AdminApplicationListProvider` | Add department scoping via `AccessControlService::assertDepartmentAccess()` | Missing guard |
| `AdminApplicationCreateProcessor` | Add ASSISTANT role assignment for new users | Missing effect |
| `AdminApplicationCreateProcessor` | Add department check on `admissionPeriodId` (must match user's dept or require ADMIN) | Missing guard |
| `AdmissionSubscriberProcessor` | Add duplicate handling — check existing subscriber, throw on duplicate (match monolith) | Behavioral change |

#### User / Auth / Profile (6 changes)

| Resource/Processor | Fix | Type |
|-------------------|-----|------|
| `ProfileProcessor` | Add `UserEvent::EDITED` dispatch | Missing effect |
| `ProfileResource` + `ProfileProcessor` | Add `accountNumber` and `fieldOfStudy` fields to DTO and processor | Missing fields |
| `PartnersProvider` | Add `$user->isActive()` check | Missing guard |
| `PartnersProvider` | Add day and bolk/group filtering (match monolith logic) | Missing filter |
| `AdminUserListResource` | Change security to `ROLE_TEAM_MEMBER` | Auth escalation |
| `AdminUserListProvider` | Default to current user's department (not first by PK) | Behavioral fix |
| `AdminReceiptDashboardResource` | Change security to `ROLE_TEAM_MEMBER` | Auth escalation |
| `AdminReceiptStatusInput` | Change security to `ROLE_TEAM_MEMBER` | Auth escalation |

#### Survey (4 changes, 1 service extraction)

| Resource/Processor | Fix | Type |
|-------------------|-----|------|
| `AccessControlService` | Extract `assertSurveyAccess()` from `SurveyController::ensureAccess()` | Service extraction |
| `AdminSurveyEditProcessor` | Call `AccessControlService::assertSurveyAccess()` | Missing guard |
| `AdminSurveyDeleteProvider` | Call `AccessControlService::assertSurveyAccess()` | Missing guard |
| `AdminSurveyCopyProvider` | Call `AccessControlService::assertSurveyAccess()` | Missing guard |
| `AdminSurveyCreateProcessor` | Restrict `departmentId` override to ADMIN only | Missing guard |
| `SurveyRespondProcessor` | Add required-field validation against `SurveyQuestion::getOptional()` | Validation gap |

#### Scheduling (1 change)

| Resource | Fix | Type |
|----------|-----|------|
| `AdminSchedulingAssistantResource` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |
| `AdminSchedulingSchoolResource` | Change security to `ROLE_TEAM_LEADER` | Guard downgrade |

#### Content (2 changes)

| Processor | Fix | Type |
|-----------|-----|------|
| `AdminStaticContentEditProcessor` | Support `htmlId` lookup alongside numeric ID; add auto-create | Missing feature |
| `ContactMessageProcessor` | Use `SupportTicketCreatedEvent` dispatch instead of direct email | Missing architecture |

## Out of scope

- Refactoring Twig controllers to delegate to the same service methods (follow-up)
- Missing API endpoints for Twig-only features (CSV export, certificate PDF, position CRUD, sponsor CRUD)
- Bulk delete API for interviews
- `heardAboutFrom` field collection (functionally equivalent at `[]` vs `null`)
- `previousParticipation` guard on application detail (likely intentional removal)
- Duplicate application check for new public applicants (monolith also lacks this)

## Testing strategy

Each fix should be verified against the existing test suite (`composer test` — 1011 tests). For guard changes (security attribute updates), the existing functional tests cover role-based access. For new service methods, add unit tests covering the extracted logic.

## Success criteria

Every API Platform endpoint behaves identically to its corresponding Twig controller in terms of:
1. Who can access it (auth level + department scoping)
2. What preconditions are checked before execution
3. What side effects occur (events, emails)
4. What validation is applied to input
5. What fields are accepted and returned
