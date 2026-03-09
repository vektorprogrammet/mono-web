# Server Comparison: Monolith (Sf 3.4) vs apps/server (Sf 6.4)

Comparison of the monolith (`v1/monolith/`, branch `master`, Symfony 3.4) against the migrated server (`apps/server/`, Symfony 6.4). The monolith is the source of truth.

**Scope:** API surface — controllers, API Platform resources, entity contracts, guards/effects/constraints.

**Architecture change:** The migration retains all Twig controllers as 1:1 ports (PHP 8 attributes instead of annotations, constructor DI instead of container) and adds a parallel API Platform JSON/JWT layer under `/api/*`. The Twig layer is faithful; the API Platform layer is where divergences occur.

**Methodology:** Initial analysis by 6 parallel agents (one per domain), then verified by 6 independent agents re-reading actual code. Findings marked with evidence quality.

## Cross-Cutting Patterns

Three systematic issues repeat across every domain:

### 1. Auth guard downgrades

The monolith uses `security.yaml` access_control rules with path-pattern matching (e.g., `^/kontrollpanel/intervju/fordel` requires `ROLE_TEAM_LEADER`). The API Platform resources use per-resource `security` attributes, and many are set to `ROLE_TEAM_MEMBER` where the monolith required `ROLE_TEAM_LEADER` or `ROLE_ADMIN`.

| Domain | Monolith guard | API guard | Endpoints affected |
|--------|---------------|-----------|-------------------|
| Interview | TEAM_LEADER | TEAM_MEMBER | assign, bulk assign |
| Interview | ADMIN | TEAM_MEMBER | delete |
| Team | TEAM_LEADER | TEAM_MEMBER | create, edit, delete |
| Team membership | TEAM_LEADER | TEAM_MEMBER | add member, edit membership |
| Executive board | ADMIN | TEAM_LEADER | remove member |
| Scheduling | TEAM_LEADER | TEAM_MEMBER | assistant/school lists |

Note: Team membership *delete* is a special case — the monolith had this route's TEAM_LEADER rule commented out (with a TODO about crashes), so it fell through to the catch-all TEAM_MEMBER. The migration's TEAM_MEMBER for delete matches the monolith's effective behavior.

### 2. Department scoping removed

The monolith controllers check that the logged-in user belongs to the same department as the resource they're accessing (or is ADMIN for cross-department access). Most API Platform endpoints drop this check entirely — any authenticated user at the required role level can access any department's data.

Affected: application list, interview list, survey CRUD (except results), team interest, statistics, admin application create.

### 3. Event dispatch wrapped in try/catch

Monolith controllers dispatch domain events synchronously — if an event handler throws, the operation rolls back. API Platform processors wrap `$eventDispatcher->dispatch()` in try/catch, logging failures but allowing persistence to succeed. Side effects (emails, Slack notifications, Google Workspace sync) can silently fail without the caller knowing.

Affected: team CRUD, user creation (activation email), receipt creation.

## Entity Changes

**Zero database schema breaks.** All ORM column types, nullable flags, lengths, and relation cardinalities are preserved. The only PHP-level default change is `Role::$role` defaulting to `''` (empty string) instead of null via constructor promotion.

| Entity | Severity | Change |
|--------|----------|--------|
| User | **Breaking** | `getRoles()` returns `string[]` instead of `Role[]` (required by Sf6 `UserInterface`). New `getRoleEntities()` provides old behavior. `AdvancedUserInterface` removed (deprecated Sf4). `Serializable` replaced with `__serialize()`/`__unserialize()`. `getPassword()` gains `?string` return type. |
| Role | **Breaking** | No longer extends `SymfonyRole` (removed Sf5). `__toString()` returns `getRole()` (e.g. `ROLE_ADMIN`) instead of `getName()` (e.g. `Admin`). Constructor promoted with default `''`. |
| Team, TeamMembership, Department, Semester, AdmissionPeriod, Article, StaticContent, ChangeLogItem, Position | **Additive** | `#[ApiResource]` and `#[Groups]` attributes added — creates new public/admin JSON endpoints. No field changes. |
| Interview, Application, Receipt, Survey*, AssistantHistory, ExecutiveBoard* | **Cosmetic** | Annotation → attribute syntax only. `switch` → `match`, `strpos` → `str_contains`. |

## Domain Comparisons

### Interview

**Twig controllers:** Perfect 1:1 port. Zero changes across all 20 endpoints.

**API Platform endpoints (17 new):**

| Endpoint | Category | Detail |
|----------|----------|--------|
| `POST /api/admin/interviews/assign` | **Guard downgrade** | TEAM_LEADER → TEAM_MEMBER. Verified: monolith `security.yml` has `^/kontrollpanel/intervju/fordel` → `ROLE_TEAM_LEADER`. |
| `POST /api/admin/interviews/bulk-assign` | **Guard downgrade** | TEAM_LEADER → TEAM_MEMBER. Also: more flexible input (per-application interviewer/schema vs single for all). |
| `DELETE /api/admin/interviews/{id}` | **Guard downgrade** | ADMIN → TEAM_MEMBER (two-level downgrade). No API endpoint for bulk delete (monolith has one). |
| `POST .../conduct` | **Guard removed** | Monolith checks `loggedInUserCanSeeInterview` (only assigned interviewer, co-interviewer, or admin can conduct) AND blocks self-interview. API: any TEAM_MEMBER can conduct any interview. Also: **no draft-save** — always marks `interviewed=true` and dispatches event. Monolith has "Lagre kladd" (save draft) vs "Lagre og send kvittering" (save and send). Also: **missing `setCancelled(false)`** — monolith un-cancels the interview on conduct; API leaves cancelled flag unchanged. |
| `POST .../schedule` | **Guard removed** | Monolith checks `loggedInUserCanSeeInterview`. API: any TEAM_MEMBER. Both always send email when saving (~~monolith has save-vs-send~~ — corrected: monolith schedule only has `saveAndSend` + `preview`, no plain save). |
| `PUT .../status` | Same guard | TEAM_MEMBER on both sides. |
| `DELETE .../interview-schemas/{id}` | **Improvement** | API checks for linked interviews (409 Conflict). Monolith catches generic DB exceptions. |
| `POST .../accept` | **Improvement** | API adds `isPending` check. Monolith accepts without state check. |

### Admission / Application

**Twig controllers:** Perfect 1:1 port.

**API Platform endpoints:**

| Endpoint | Category | Detail |
|----------|----------|--------|
| `POST /api/applications` | **Not a regression** | No duplicate application check — but monolith's public flow also lacks this check for new applicants. `userHasAlreadyApplied()` is correctly used in `ExistingUserApplicationProcessor` (matching monolith). |
| `POST /api/applications` | **Behavioral** | Existing assistant bypass: monolith redirects returning assistants to dedicated `/eksisterendeopptak` flow (which sets `previousParticipation=true` and attaches last interview). API silently reuses the user without this flow — returning assistants get `previousParticipation=false`. |
| `POST /api/applications` | **Low** | `heardAboutFrom` initialized to `[]` vs monolith's `null`. Functionally equivalent — both populated later during interview phase. |
| `GET /api/admin/applications` | **Dept scoping removed** | Any TEAM_MEMBER can pass `?department=X` for any department. Monolith checks same-department or TEAM_LEADER. |
| `GET /api/admin/applications/{id}` | **Guard removed** | Monolith gates on `previousParticipation=true` (only returning assistants viewable via this endpoint). API shows any application. May be intentional improvement. |
| `POST /api/admin/applications` | **Missing effect** | Does not assign ASSISTANT role to newly created users (monolith's `setCorrectUser()` does). Also: accepts any `admissionPeriodId` without department check (monolith forces user's own department). Gender hardcoded to `0`. |
| `POST /api/admission_subscribers` | **Behavioral** | ~~Bypasses AdmissionNotifier~~ Corrected: confirmation emails ARE sent via `ApplicationCreatedEvent` → `ApplicationSubscriber`. However, duplicate handling differs: monolith's `AdmissionNotifier::createSubscription()` throws on duplicates; API silently succeeds (201). |

### Team / Membership / Executive Board

**Twig controllers:** Perfect 1:1 port.

**API Platform endpoints:**

| Endpoint | Category | Detail |
|----------|----------|--------|
| `POST /api/admin/teams` | **Guard downgrade + validation gap** | TEAM_LEADER → TEAM_MEMBER. DTO only validates `name` NotBlank. Entity constraints (`Assert\Email`, `@VektorEmail`, `@UniqueCompanyEmail`, shortDescription max 125) exist but are **never triggered** because API Platform validates the DTO, not the entity. Custom validators are present in `src/App/Validator/Constraints/` but not referenced on the DTO. |
| `PUT /api/admin/teams/{id}` | **Guard downgrade + missing fields** | TEAM_LEADER → TEAM_MEMBER. `acceptApplication`, `deadline`, `active` not on DTO — cannot be changed via API. |
| `DELETE /api/admin/teams/{id}` | **Guard downgrade** | TEAM_LEADER → TEAM_MEMBER. |
| `POST .../teams/{id}/members` | **Guard downgrade** | TEAM_LEADER → TEAM_MEMBER. Any team member can add any user to any team. |
| `DELETE /api/admin/executive-board/members/{id}` | **Guard downgrade** | ADMIN → TEAM_LEADER. |
| `POST /api/team_applications` | **Missing precondition** | Does not check `$team->getAcceptApplicationAndDeadline()` — accepts applications to closed teams. Monolith checks this in controller and throws 404. |
| `GET /api/teams/{id}` | **Behavioral** | Public endpoint exposes inactive teams. Monolith returns 404 for inactive unless TEAM_MEMBER. |

### User / Auth / Profile / Receipt

**Twig controllers:** Perfect 1:1 port. Rate limiting added to password reset form (improvement).

**API Platform endpoints:**

| Endpoint | Category | Detail |
|----------|----------|--------|
| `PUT /api/me` | **Missing side effects + fields** | Does not dispatch `UserEvent::EDITED` — Google Workspace sync (`GSuiteSubscriber::updateGSuiteUser()`) will not fire. Missing fields: `accountNumber` and `fieldOfStudy` (monolith's `EditUserType` form includes these). `companyEmail` is not missing — it's admin-only in the monolith too. |
| `GET /api/me/partners` | **Breaking** | Returns all users at same school regardless of day/group. Monolith filters by same day AND overlapping bolk (group). Also: does not check `user.isActive()` (monolith throws AccessDenied for inactive users). |
| `GET /api/admin/users` | **Auth escalated** | TEAM_MEMBER → TEAM_LEADER (stricter than monolith). Defaults to first active department by PK order (not user's own department). |
| `GET /api/admin/receipts` | **Auth escalated** | TEAM_MEMBER → TEAM_LEADER (stricter than monolith). |
| `PUT /api/admin/receipts/{id}/status` | **Auth escalated** | TEAM_MEMBER → TEAM_LEADER. |
| ~~`DELETE /api/admin/users/{id}` dept check~~ | ~~Behavioral~~ | Corrected: uses same underlying path (`fieldOfStudy->department`) as monolith, with null-safe handling. Not a divergence. |
| `POST /api/password_resets` | **Improvement** | Sealed user enumeration — returns 204 for all emails. Monolith leaks existence via flash messages. |
| `POST /api/login` | **Addition** | JWT auth. Replaces removed `Api/AccountController` session-based auth. |

**Removed controllers:**

| Controller | Assessment |
|-----------|-----------|
| `Api/AccountController` | Not dead code — was active session-based API auth for v2 React SPA. Replaced by JWT + `GET /api/me`. Any consumer of `/api/account/*` must migrate. |
| `Api/PartyController` | ~95% dead code. Used `FOSRestBundle` (removed). Served a one-off event dashboard. |
| `FrontEndController` | Served `client/build/index.html` as SPA fallback. Correctly removed — separate SPA apps now. |

### Survey / Content / Misc

**Twig controllers:** Perfect 1:1 port.

**API Platform endpoints:**

| Endpoint | Category | Detail |
|----------|----------|--------|
| Survey write ops (edit, delete, copy) | **Dept scoping removed** | Monolith `ensureAccess()` checks same-department AND confidentiality (confidential requires `survey_admin`/ADMIN). API: flat ROLE_TEAM_MEMBER. **Exception:** `SurveyResultProvider` correctly implements both checks — results are properly scoped. |
| Survey create | **Dept scoping removed** | Processor accepts arbitrary `departmentId` — a TEAM_MEMBER can create surveys for departments they don't belong to. Monolith always sets user's own department. |
| Survey list | **Not a regression** | Confidential survey metadata (names, IDs) visible to any TEAM_MEMBER — but monolith also shows confidential surveys in the list view. `ensureAccess()` only gates individual operations, not the list. |
| `POST /api/surveys/{id}/respond` | **Validation gap** | No required-field validation — monolith's form enforces `SurveyQuestion::getOptional()`. Also: no `SurveyLinkClick` tracking (notification analytics lost). |
| ~~Survey notifier edit: active guard missing~~ | ~~Guard removed~~ | Corrected: migration has `ConflictHttpException` (409) check — **stricter** than monolith's UI-disabled-fields approach. |
| `POST /api/contact_messages` | **Architecture change** | ~~No SupportTicket persisted~~ Corrected: monolith's `SupportTicket` is a non-persisted value object (not a Doctrine entity). Real difference: monolith uses event dispatch (`SupportTicketCreatedEvent`) with extensible listeners; migration sends email directly. No persistence was lost. |
| `PUT /api/admin/static-content/{id}` | **Breaking** | Identification changed from `htmlId` string to numeric entity ID. No auto-create behavior — monolith creates new blocks if `htmlId` unknown; migration throws 404. |
| Scheduling assistants/schools | **Guard downgrade** | TEAM_LEADER → TEAM_MEMBER. |
| Sponsor management | **Not migrated** | Monolith `SponsorsController` (corporate sponsor CRUD with logo upload) has no API equivalent. `PartnersResource` is a different feature (co-assistants at same school). |

## Summary

### Faithful aspects

- **Twig controllers**: Perfect 1:1 port across all 59 controllers, 229 routes. Zero behavioral changes.
- **Entity schema**: Zero database column/relation changes. Fully compatible.
- **Templates**: Identical.
- **Tests**: Identical (1011 tests).
- **Services**: Identical business logic.

### Systematic issues in API Platform layer

| Issue | Count | Severity |
|-------|-------|----------|
| Guard downgrades (TEAM_LEADER/ADMIN → TEAM_MEMBER) | 12+ endpoints | High |
| Department scoping removed | 5+ domains | High |
| Missing controller-level guards (`loggedInUserCanSeeInterview`, `ensureAccess`, `getAcceptApplicationAndDeadline`, self-interview block, `setCancelled(false)`) | 6+ endpoints | High |
| DTO bypasses entity validation (constraints exist but never triggered) | Team, survey, misc | Medium |
| Event dispatch failure silenced (try/catch) | All write processors | Medium |
| Missing fields/effects on DTOs/processors | Profile, team, admin create | Medium |

### Auth escalations (stricter than monolith)

| Endpoint | Monolith | API | Assessment |
|----------|----------|-----|-----------|
| `GET /api/admin/users` | TEAM_MEMBER | TEAM_LEADER | May break existing workflows |
| `GET /api/admin/receipts` | TEAM_MEMBER | TEAM_LEADER | May break existing workflows |
| `PUT /api/admin/receipts/{id}/status` | TEAM_MEMBER | TEAM_LEADER | May break existing workflows |

### Intentional improvements

| Change | Assessment |
|--------|-----------|
| Rate limiting on public endpoints (applications, contact, password reset) | Good — monolith had none |
| JWT auth replacing session-based API auth | Good — stateless, standard |
| User enumeration sealed on password reset | Good — security improvement |
| CORS enabled for production | Necessary for cross-origin dashboard |
| `isPending` check on interview accept | Good — tighter guard |
| Linked-interview check on schema delete (409 Conflict) | Good — prevents orphans |
| Active-notifier edit guard (409 Conflict) | Good — stricter than monolith's UI approach |
| Explicit duplicate-application guard (existing user flow) | Good — clearer than monolith |
