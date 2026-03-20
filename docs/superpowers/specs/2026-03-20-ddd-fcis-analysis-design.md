# DDD/FCIS Architecture Analysis — Design Spec

Analyse the Symfony codebase (`apps/server/src/App/`) and produce a declarative
restructure plan toward a colocated Domain-Driven Design architecture with
Functional Core, Imperative Shell (FCIS) as the fundamental principle.

**Deliverable:** An end-state specification document. No code changes.

**Relationship to migration:** Independent workstream. The restructure is purely
internal — API Platform DTOs and the OpenAPI spec are the external contract and
remain unchanged. Can proceed in parallel with the A1 (SDK) and B0/B1 (frontend)
migration phases.

## FCIS Interpretation for This Codebase

Doctrine entities are data containers with getters/setters. Business logic lives in
services (`ApplicationManager`, `InterviewManager`, `SurveyManager`, etc.). The
valuable extraction is **business rules and computations from services into pure
PHP classes** — not mirroring the entity graph with separate domain model classes.

- **Functional Core:** Pure PHP classes in `Domain/` — business rules, value
  objects, event definitions, repository interfaces. Zero Symfony/Doctrine imports.
- **Imperative Shell:** Everything else — Doctrine entities, repositories, API
  Platform resources/state, mailers, external service integrations.

Doctrine entities stay as Infrastructure. No entity splitting.

## Bounded Contexts

| Context | Responsibility | Core Entities | Key Services |
|---------|---------------|---------------|-------------|
| **Admission** | Application lifecycle — submit, review, accept/reject | Application, AdmissionPeriod, AdmissionSubscriber, AdmissionNotification | ApplicationManager, ApplicationAdmission, AdmissionNotifier, AdmissionStatistics |
| **Interview** | Interview scheduling, conducting, scoring | Interview, InterviewSchema, InterviewQuestion, InterviewAnswer, InterviewScore, InterviewDistribution | InterviewManager, InterviewCounter, InterviewNotificationManager |
| **Organization** | Structural hierarchy — departments, teams, boards, positions | Department, Team, TeamMembership, ExecutiveBoard, ExecutiveBoardMembership, Position, TeamApplication, TeamInterest | TeamMembershipService, UserGroupCollectionManager |
| **Survey** | Questionnaire creation, distribution, response collection | Survey, SurveyQuestion, SurveyQuestionAlternative, SurveyAnswer, SurveyTaken, SurveyNotification, SurveyNotificationCollection, SurveyLinkClick, Feedback | SurveyManager, SurveyNotifier |
| **Identity** | Users, authentication, roles, access control | User, Role, PasswordReset, AccessRule, UnhandledAccessRule, UserGroup, UserGroupCollection | UserService, UserRegistration, LoginManager, RoleManager, AccessControlService, PasswordManager |
| **Scheduling** | Assistant-to-school assignment | School, SchoolCapacity, AssistantScheduling/* | (existing AssistantScheduling module) |
| **Finance** | Receipts, certificates, assistant work history | Receipt, CertificateRequest, AssistantHistory, Signature | (ReceiptStatistics) |
| **Content** | Articles, static pages, sponsors, changelog | Article, StaticContent, Sponsor, ChangeLogItem, SupportTicket, SocialEvent, InfoMeeting | ContentModeManager |

## Shared Kernel

Deliberately small. Only concepts genuinely used across multiple contexts with no
single owner:

| Class | Rationale |
|-------|-----------|
| `Semester` | Used by Admission, Organization, Scheduling, Finance |
| `SemesterUtil` | Pure semester calculations |
| `FieldOfStudy` | Referenced by Identity and Admission |
| `DepartmentSemesterInterface` | Implemented across contexts |
| `PeriodInterface` | Implemented across contexts |
| `TeamInterface` | Implemented across contexts |
| `TeamMembershipInterface` | Implemented across contexts |

**Excluded from Shared:** Department (owned by Organization, referenced by ID),
User (owned by Identity, referenced by ID), Role/AccessRule (owned by Identity),
utility classes (context-specific or Support/).

## Layer Structure per Context

```
src/
  {Context}/
    Domain/              # Pure PHP. Zero framework imports.
      Rules/             # Business rules as pure functions/classes
      ValueObjects/      # Immutable value types
      Events/            # Domain event definitions
      Contracts/         # Repository interfaces, service interfaces
    Infrastructure/      # Framework-coupled implementations
      Entity/            # Doctrine entities (current entities, moved here)
      Repository/        # Concrete Doctrine repositories
      ...                # Mailer, external integrations where relevant
    Api/                 # API Platform layer
      Resource/          # DTOs (#[ApiResource])
      State/             # Providers + Processors
    Controller/          # Legacy Twig controllers (deprecated, removed post-migration)
    Form/                # Legacy form types (deprecated, removed post-migration)
```

**No Application/ layer.** Current services are thin orchestrators calling Doctrine
directly — they're infrastructure. The "application layer" emerges naturally when
pure rules are extracted. What remains (database calls, event dispatching) stays
in Infrastructure or Api/State.

**Domain/Rules/ not Domain/{Aggregate}.php.** Since entities stay as Doctrine
objects in Infrastructure, the domain layer holds extracted logic — validation
rules, state machine logic, computation — not aggregate root classes.

### Example: Admission Context

```
src/
  Admission/
    Domain/
      Rules/
        ApplicationEligibility.php    # can this user apply?
        AdmissionPeriodStatus.php     # is period open/closed?
      ValueObjects/
        ApplicationStatus.php         # (existing Model/ApplicationStatus)
        Availability.php              # mon-fri booleans as value object
      Events/
        ApplicationCreatedEvent.php
      Contracts/
        ApplicationRepositoryInterface.php
    Infrastructure/
      Entity/
        Application.php
        AdmissionPeriod.php
        AdmissionSubscriber.php
        AdmissionNotification.php
      Repository/
        ApplicationRepository.php
        AdmissionPeriodRepository.php
        AdmissionSubscriberRepository.php
        AdmissionNotificationRepository.php
      AdmissionNotifier.php           # sends emails (impure)
    Api/
      Resource/
        ApplicationInput.php
        ExistingUserApplicationInput.php
        ApplicationDetailResource.php
        AdminApplicationListResource.php
        AdminApplicationCreateInput.php
        AdminApplicationDeleteResource.php
        AdminApplicationBulkDeleteInput.php
        AdmissionSubscriberInput.php
        AdmissionStatisticsResource.php
      State/
        ApplicationProcessor.php
        ExistingUserApplicationProcessor.php
        ApplicationDetailProvider.php
        AdminApplicationListProvider.php
        AdminApplicationCreateProcessor.php
        AdminApplicationDeleteProcessor.php
        AdminApplicationDeleteProvider.php
        AdminApplicationBulkDeleteProcessor.php
        AdmissionSubscriberProcessor.php
        AdmissionStatisticsProvider.php
    Controller/
      ExistingUserAdmissionController.php
      ApplicationStatisticsController.php
      AdmissionAdminController.php
      AdmissionPeriodController.php
      AdmissionSubscriberController.php
    Form/
      AdmissionSubscriberType.php
```

**Service decomposition:**
- `ApplicationManager` → pure rules to Domain/Rules/, orchestration absorbed into
  Api/State/ processors
- `ApplicationAdmission` → same treatment
- `AdmissionStatistics` → pure computation to Domain/Rules/, queries to
  Infrastructure/
- `AdmissionNotifier` → Infrastructure/ (sends emails)

## Cross-Context Dependencies

### Pragmatic coupling rule

Infrastructure layers may import entities across context boundaries (Doctrine
requires this for `ManyToOne`/`OneToMany` relations). Domain layers never import
across contexts. Api layers reference by ID or lightweight read-only interfaces.

### Entity ownership

- **Department** — Organization owns it. Other contexts reference by department ID.
  `$application->getAdmissionPeriod()->getDepartment()` traversals acknowledged as
  infrastructure-level coupling, not domain coupling.
- **User** — Identity owns it. Other contexts hold user IDs. Doctrine `ManyToOne`
  relations to User remain in Infrastructure entities.

### Cross-context event flow

Events decouple contexts at the domain level. Event class lives in the originating
context's Domain/Events/. Subscribers live in the consuming context's
Infrastructure/.

```
Admission/Domain/Events/ApplicationCreatedEvent.php
  → Admission/Infrastructure/AdmissionNotifier.php (same context)
  → Interview/Infrastructure/Subscriber/ApplicationCreatedSubscriber.php (cross-context)
```

## File Categorization Rules

Every existing `.php` file falls into one of five categories:

### Category 1: Direct move

File moves to the same layer in its new context. No logic changes.

- `Entity/X.php` → `{Context}/Infrastructure/Entity/X.php`
- `Entity/Repository/XRepository.php` → `{Context}/Infrastructure/Repository/XRepository.php`
- `State/XProcessor.php` → `{Context}/Api/State/XProcessor.php`
- `State/XProvider.php` → `{Context}/Api/State/XProvider.php`
- `ApiResource/X.php` → `{Context}/Api/Resource/X.php`
- `Event/XEvent.php` → `{Context}/Domain/Events/XEvent.php`
- `Controller/XController.php` → `{Context}/Controller/XController.php`
- `Form/Type/XType.php` → `{Context}/Form/XType.php`
- `EventSubscriber/XSubscriber.php` → `{Context}/Infrastructure/Subscriber/XSubscriber.php`
- `Command/XCommand.php` → `{Context}/Infrastructure/Command/XCommand.php`
- `Validator/Constraints/X.php` → `{Context}/Infrastructure/Validator/X.php` (or Domain/Rules/ if pure)
- `Role/*.php` → `Identity/Infrastructure/` or `Identity/Domain/`

### Category 2: Extract + move

Services with mixed concerns. Pure logic extracted to Domain/Rules/, remainder
stays in Infrastructure/ or absorbed into Api/State/.

Candidates: `ApplicationManager`, `ApplicationAdmission`, `InterviewManager`,
`InterviewCounter`, `InterviewNotificationManager`, `SurveyManager`,
`SurveyNotifier`, `AdmissionStatistics`, `AccessControlService`, `RoleManager`,
`TeamMembershipService`, `UserGroupCollectionManager`.

### Category 3: Split across contexts

Classes serving multiple domains, requiring decomposition.

Candidates: `UserService` (parts Identity, parts cross-cutting), `BaseController`
(helper methods belong to different contexts), `FilterService`, `Sorter`.

### Category 4: Deprecate

Legacy-only, removed post-migration. Move into context for colocation, then delete.

- All `Controller/*.php` (58 files)
- All `Form/Type/*.php` (50+ files)
- `Twig/Extension/*.php` (12 files)
- `DataFixtures/` — stays as-is or reorganizes per context

### Category 5: Infrastructure utilities

Context-agnostic infrastructure.

- `Google/*`, `Sms/*`, `Mailer/*` → `Support/Infrastructure/`
- `Utils/CsvUtil.php`, `Utils/TimeUtil.php` → `Support/`
- `Security/UserChecker.php` → `Identity/Infrastructure/`
- `AutoMapper/UserMap.php` → `Identity/Infrastructure/`
- `Type/InterviewStatusType.php` → `Interview/Infrastructure/`
- `Model/ApplicationStatus.php` → `Admission/Domain/ValueObjects/`

Remaining services not listed in Categories 2-3 (e.g., `EmailSender`,
`FileUploader`, `SlackMailer`, `SlackMessenger`, `GeoLocation`, `LogService`,
`BetaRedirecter`, `CompanyEmailMaker`, `ApplicationData`, `AssistantHistoryData`,
`SbsData`, `PasswordManager`, `LoginManager`, `UserRegistration`) are
infrastructure — assign to their owning context per the rules in Step 2.
- `Model/ApplicationStatus.php` → `Admission/Domain/ValueObjects/`

## Analysis Execution Process

### Step 1: Validate bounded contexts with dependency check

For each candidate context, grep all `use App\*` imports across the codebase (not
just Entity and Service — include Event, EventSubscriber, Role, Validator, etc.).
Confirm naming-based groupings hold. Flag classes that import heavily from multiple
contexts.

### Step 2: Categorize every file

Walk each directory and assign every `.php` file a category (1-5) and target
context. Output: full migration map table.

### Step 3: Audit services for extractable domain logic

For each Category 2 service, identify:
- Pure business rules (no `$em->flush()`, no `$mailer->send()`, no repository
  calls) → Domain/Rules/
- Value objects hiding as primitives → Domain/ValueObjects/
- Remaining orchestration → Infrastructure/ or absorbed into Api/State/

### Step 4: Document cross-context entity references

For each Doctrine `ManyToOne`/`OneToMany` crossing a context boundary, document
source entity, target entity, and which contexts are coupled.

### Step 5: Produce open questions

Entity ownership disputes, services straddling contexts, shared logic ambiguities.

**Parallelization:** Steps 2-4 can run per bounded context independently, then
merge results.

## Output Document Structure

1. **Bounded Contexts** — names, descriptions, ownership
2. **Shared Kernel** — contents, rationale for each inclusion
3. **Target Directory Tree** — full `src/` tree for the end state
4. **Migration Map** — table: `existing path → category → target path`
5. **Domain Extractions** — table: `service → extracted rules → remaining infra`
6. **Cross-Context Relations** — table: `entity.field → target entity → contexts`
7. **Open Questions** — deferred to human review

## Constraints

- Do not modify any files during analysis
- Domain layer classes must have zero Symfony/Doctrine dependencies
- Doctrine entities remain as Infrastructure — no entity splitting
- Prefer explicit bounded context boundaries over a large Shared Kernel
- Infrastructure layers may import across contexts; Domain layers never
- Analysis spec is end-state only — no implementation ordering
