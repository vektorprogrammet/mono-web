# DDD/FCIS Restructure Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `apps/server/src/App/` from flat layer-by-layer organization into colocated bounded contexts with FCIS layering.

**Architecture:** Every file stays under the `App\` PSR-4 namespace — no composer.json or Kernel changes. Files move from `App\Entity\X` to `App\{Context}\Infrastructure\Entity\X`. Symfony config updated additively: new service/doctrine/api-platform resource blocks per context. Migration is atomic per context — tests pass after each commit.

**Tech Stack:** Symfony 6.4, Doctrine ORM (attribute mapping), API Platform 3.4, PHPUnit (1001 tests)

**Spec:** `docs/superpowers/specs/2026-03-20-ddd-fcis-analysis-design.md`

**Scope:** This plan covers file moves and namespace updates ONLY. The spec's
Domain Extractions (Category 2 — extracting pure business rules from services
into `Domain/Rules/` classes) are a separate follow-up workstream. This plan
moves services to their target context as-is; the pure logic extraction happens
after the directory structure is in place.

---

## Chunk 1: Infrastructure Setup + Shared Kernel

### Task 0: Create target directory structure

**Files:**
- Modify: `apps/server/config/services.yaml`
- Modify: `apps/server/config/packages/doctrine.yaml`
- Modify: `apps/server/config/packages/api_platform.yaml`

This task creates all bounded context directories and updates Symfony config to discover services, entities, and API resources from both old AND new locations simultaneously. This allows incremental migration — files can be moved one context at a time while the app keeps working.

- [ ] **Step 1: Create all bounded context directory trees**

```bash
cd apps/server/src/App

# Bounded contexts
for ctx in Admission Interview Organization Survey Identity Scheduling Operations Content; do
  mkdir -p "$ctx"/{Domain/{Rules,ValueObjects,Events,Contracts},Infrastructure/{Entity,Repository,Subscriber,Validator,Command},Api/{Resource,State},Controller,Form}
done

# Shared kernel
mkdir -p Shared/{Entity,Repository,Contracts,Form}
mkdir -p Shared/Api/{Resource,State}
mkdir -p Shared/Controller

# Support
mkdir -p Support/{Infrastructure/{Mailer,Sms,Google,Slack},Api/{Resource,State},Controller,EventSubscriber,Twig,Form,Utils,DataFixtures}
```

- [ ] **Step 2: Update doctrine.yaml — add per-context entity mappings**

Keep the existing `App` mapping (for files not yet moved) and add new mappings. Set `auto_mapping: false` since we're using explicit mappings.

```yaml
doctrine:
    dbal:
        url: '%env(DATABASE_URL)%'
        charset: utf8mb4
        default_table_options:
            charset: utf8mb4
            collate: utf8mb4_unicode_ci
        mapping_types:
            enum: string
    orm:
        auto_generate_proxy_classes: '%kernel.debug%'
        naming_strategy: doctrine.orm.naming_strategy.underscore_number_aware
        auto_mapping: false
        mappings:
            # Legacy — files not yet moved
            App:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Entity'
                prefix: 'App\Entity'
                alias: App
            # Bounded contexts
            Admission:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Admission/Infrastructure/Entity'
                prefix: 'App\Admission\Infrastructure\Entity'
                alias: Admission
            Interview:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Interview/Infrastructure/Entity'
                prefix: 'App\Interview\Infrastructure\Entity'
                alias: Interview
            Organization:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Organization/Infrastructure/Entity'
                prefix: 'App\Organization\Infrastructure\Entity'
                alias: Organization
            Survey:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Survey/Infrastructure/Entity'
                prefix: 'App\Survey\Infrastructure\Entity'
                alias: Survey
            Identity:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Identity/Infrastructure/Entity'
                prefix: 'App\Identity\Infrastructure\Entity'
                alias: Identity
            Scheduling:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Scheduling/Infrastructure/Entity'
                prefix: 'App\Scheduling\Infrastructure\Entity'
                alias: Scheduling
            Operations:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Operations/Infrastructure/Entity'
                prefix: 'App\Operations\Infrastructure\Entity'
                alias: Operations
            Content:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Content/Infrastructure/Entity'
                prefix: 'App\Content\Infrastructure\Entity'
                alias: Content
            Shared:
                is_bundle: false
                type: attribute
                dir: '%kernel.project_dir%/src/App/Shared/Entity'
                prefix: 'App\Shared\Entity'
                alias: Shared
```

- [ ] **Step 3: Update api_platform.yaml — add per-context resource paths**

```yaml
api_platform:
    title: 'Vektorprogrammet API'
    description: 'REST API for Vektorprogrammet'
    version: '1.0.0'
    mapping:
        paths:
            # Legacy — files not yet moved
            - '%kernel.project_dir%/src/App/Entity'
            - '%kernel.project_dir%/src/App/ApiResource'
            # Bounded contexts
            - '%kernel.project_dir%/src/App/Admission/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Admission/Api/Resource'
            - '%kernel.project_dir%/src/App/Interview/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Interview/Api/Resource'
            - '%kernel.project_dir%/src/App/Organization/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Organization/Api/Resource'
            - '%kernel.project_dir%/src/App/Survey/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Survey/Api/Resource'
            - '%kernel.project_dir%/src/App/Identity/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Identity/Api/Resource'
            - '%kernel.project_dir%/src/App/Scheduling/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Scheduling/Api/Resource'
            - '%kernel.project_dir%/src/App/Operations/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Operations/Api/Resource'
            - '%kernel.project_dir%/src/App/Content/Infrastructure/Entity'
            - '%kernel.project_dir%/src/App/Content/Api/Resource'
            - '%kernel.project_dir%/src/App/Shared/Entity'
            - '%kernel.project_dir%/src/App/Shared/Api/Resource'
            - '%kernel.project_dir%/src/App/Support/Api/Resource'
    defaults:
        pagination_enabled: true
        pagination_items_per_page: 30
    formats:
        jsonld: ['application/ld+json']
        json: ['application/json']
    docs_formats:
        jsonopenapi: ['application/vnd.openapi+json']
        json: ['application/json']
        html: ['text/html']
```

- [ ] **Step 4: Update services.yaml — add per-context service autodiscovery**

Add resource blocks for each bounded context BELOW the existing `App\:` block. The existing block stays until all files are migrated, then gets removed.

**CRITICAL:** The existing `App\EventSubscriber\:` block (lines 120-128) has a
custom `bind` that routes `Psr\Log\LoggerInterface` to `@App\Service\LogService`.
When subscribers move to bounded contexts, they'll be discovered by the new
context blocks which DON'T have this binding. To prevent silent logging changes,
add the LogService binding to `_defaults.bind`:

```yaml
services:
    _defaults:
        autowire: true
        autoconfigure: true
        public: true
        bind:
            App\Mailer\MailerInterface: '@App\Mailer\Mailer'
            App\Sms\SmsSenderInterface: '@App\Sms\SmsSender'
            Psr\Log\LoggerInterface: '@App\Service\LogService'
```

(These FQCNs will be updated when Support migrates in Task 2 to
`App\Support\Infrastructure\Mailer\MailerInterface`, etc.)

Add these blocks after line 53 (after the DataFixtures block):

```yaml
    # === Bounded Context Service Discovery ===
    # Each context autodiscovers all service classes.
    # Domain value objects and events are excluded (not services).

    App\Admission\:
        resource: '../src/App/Admission/'
        exclude:
            - '../src/App/Admission/Domain/{ValueObjects,Events}/'

    App\Interview\:
        resource: '../src/App/Interview/'
        exclude:
            - '../src/App/Interview/Domain/{ValueObjects,Events}/'

    App\Organization\:
        resource: '../src/App/Organization/'
        exclude:
            - '../src/App/Organization/Domain/{ValueObjects,Events}/'

    App\Survey\:
        resource: '../src/App/Survey/'
        exclude:
            - '../src/App/Survey/Domain/{ValueObjects,Events}/'

    App\Identity\:
        resource: '../src/App/Identity/'
        exclude:
            - '../src/App/Identity/Domain/{ValueObjects,Events}/'

    App\Scheduling\:
        resource: '../src/App/Scheduling/'
        exclude:
            - '../src/App/Scheduling/Domain/{ValueObjects,Events}/'

    App\Operations\:
        resource: '../src/App/Operations/'
        exclude:
            - '../src/App/Operations/Domain/{ValueObjects,Events}/'

    App\Content\:
        resource: '../src/App/Content/'
        exclude:
            - '../src/App/Content/Domain/{ValueObjects,Events}/'

    App\Shared\:
        resource: '../src/App/Shared/'

    App\Support\:
        resource: '../src/App/Support/'
```

- [ ] **Step 5: Verify the app still works with empty directories**

```bash
cd apps/server
php bin/console cache:clear
php bin/console debug:container --tag=doctrine.event_subscriber
php -d memory_limit=512M bin/phpunit --testdox 2>&1 | tail -5
```

Expected: All 1001 tests pass. Empty directories don't affect anything.

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src/App/{Admission,Interview,Organization,Survey,Identity,Scheduling,Operations,Content,Shared,Support}
git add apps/server/config/services.yaml apps/server/config/packages/doctrine.yaml apps/server/config/packages/api_platform.yaml
git commit -m "chore: create DDD bounded context directory structure and config"
```

---

### Task 1: Migrate Shared Kernel (14 files)

**Files:** See spec section "Shared Kernel"

The Shared Kernel has the fewest files and is referenced by all contexts. Move it first so subsequent context migrations can reference the new Shared namespace.

- [ ] **Step 1: Move files with git mv**

```bash
cd apps/server/src/App

# Entities
git mv Entity/Semester.php Shared/Entity/
git mv Entity/DepartmentSemesterInterface.php Shared/Contracts/
git mv Entity/PeriodInterface.php Shared/Contracts/
git mv Entity/TeamInterface.php Shared/Contracts/
git mv Entity/TeamMembershipInterface.php Shared/Contracts/

# Repository
git mv Entity/Repository/SemesterRepository.php Shared/Repository/

# Utils
git mv Utils/SemesterUtil.php Shared/

# API resources
git mv ApiResource/AdminSemesterWriteResource.php Shared/Api/Resource/
git mv ApiResource/AdminSemesterDeleteResource.php Shared/Api/Resource/

# State
git mv State/AdminSemesterCreateProcessor.php Shared/Api/State/
git mv State/AdminSemesterDeleteProcessor.php Shared/Api/State/
git mv State/AdminSemesterDeleteProvider.php Shared/Api/State/

# Legacy (deprecated)
git mv Controller/SemesterController.php Shared/Controller/
git mv Form/Type/CreateSemesterType.php Shared/Form/
```

- [ ] **Step 2: Update namespaces in all moved files**

For each moved file, update the `namespace` declaration. Example patterns:

| Old namespace | New namespace |
|--------------|--------------|
| `App\Entity` | `App\Shared\Entity` |
| `App\Entity\Repository` | `App\Shared\Repository` |
| `App\Utils` | `App\Shared` |
| `App\ApiResource` | `App\Shared\Api\Resource` |
| `App\State` | `App\Shared\Api\State` |
| `App\Controller` | `App\Shared\Controller` |
| `App\Form\Type` | `App\Shared\Form` |

Use find-replace across each moved file. For interfaces in `Shared/Contracts/`, namespace becomes `App\Shared\Contracts`.

- [ ] **Step 3: Update all `use` statements across the entire codebase**

Search and replace across `apps/server/src/` and `apps/server/tests/`:

```
use App\Entity\Semester;                    → use App\Shared\Entity\Semester;
use App\Entity\DepartmentSemesterInterface; → use App\Shared\Contracts\DepartmentSemesterInterface;
use App\Entity\PeriodInterface;             → use App\Shared\Contracts\PeriodInterface;
use App\Entity\TeamInterface;               → use App\Shared\Contracts\TeamInterface;
use App\Entity\TeamMembershipInterface;     → use App\Shared\Contracts\TeamMembershipInterface;
use App\Entity\Repository\SemesterRepository; → use App\Shared\Repository\SemesterRepository;
use App\Utils\SemesterUtil;                 → use App\Shared\SemesterUtil;
```

Also update `targetEntity` references in Doctrine ORM attributes on entities that reference Semester (many files across all contexts).

- [ ] **Step 4: Update services.yaml explicit service references**

No explicit Shared services in services.yaml — autodiscovery handles it.

- [ ] **Step 5: Run full test suite**

```bash
cd apps/server
php -d memory_limit=512M bin/phpunit 2>&1 | tail -5
```

Expected: 1001 tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: migrate Shared Kernel to App\Shared namespace"
```

---

## Chunk 2: Support + Content + Operations

### Task 2: Migrate Support (43 files)

**Files:** See spec section "Support (context-agnostic infrastructure)"

Support has no domain entities — only infrastructure services, subscribers, Twig extensions, and utilities. No Doctrine mapping changes needed.

- [ ] **Step 1: Move files with git mv**

```bash
cd apps/server/src/App

# Infrastructure/Mailer
git mv Mailer/Mailer.php Support/Infrastructure/Mailer/
git mv Mailer/MailerInterface.php Support/Infrastructure/Mailer/

# Infrastructure/Sms
git mv Sms/Sms.php Support/Infrastructure/Sms/
git mv Sms/SmsSender.php Support/Infrastructure/Sms/
git mv Sms/SmsSenderInterface.php Support/Infrastructure/Sms/
git mv Sms/GatewayAPI.php Support/Infrastructure/Sms/
git mv Sms/SlackSms.php Support/Infrastructure/Sms/

# Infrastructure/Google
git mv Google/GoogleAPI.php Support/Infrastructure/Google/
git mv Google/GoogleService.php Support/Infrastructure/Google/
git mv Google/Gmail.php Support/Infrastructure/Google/
git mv Google/GoogleDrive.php Support/Infrastructure/Google/
git mv Google/GoogleGroups.php Support/Infrastructure/Google/
git mv Google/GoogleUsers.php Support/Infrastructure/Google/

# Infrastructure/Slack
git mv Service/SlackMailer.php Support/Infrastructure/Slack/
git mv Service/SlackMessenger.php Support/Infrastructure/Slack/

# Infrastructure (misc)
git mv Service/FileUploader.php Support/Infrastructure/
git mv Service/LogService.php Support/Infrastructure/
git mv Service/BetaRedirecter.php Support/Infrastructure/
git mv Service/GeoLocation.php Support/Infrastructure/

# Services
git mv Service/FilterService.php Support/
git mv Service/Sorter.php Support/

# Utils
git mv Utils/CsvUtil.php Support/Utils/
git mv Utils/TimeUtil.php Support/Utils/

# EventSubscribers
git mv EventSubscriber/DbSubscriber.php Support/EventSubscriber/
git mv EventSubscriber/ExceptionSubscriber.php Support/EventSubscriber/
git mv EventSubscriber/GSuiteSubscriber.php Support/EventSubscriber/

# Controllers (legacy)
git mv Controller/BaseController.php Support/Controller/
git mv Controller/FileBrowserController.php Support/Controller/
git mv Controller/GitHubController.php Support/Controller/

# API (cross-context aggregation)
git mv ApiResource/DashboardResource.php Support/Api/Resource/
git mv ApiResource/Statistics.php Support/Api/Resource/
git mv State/DashboardProvider.php Support/Api/State/
git mv State/StatisticsProvider.php Support/Api/State/

# Twig extensions (legacy)
git mv Twig/Extension/AccessExtension.php Support/Twig/
git mv Twig/Extension/AppRoutingExtension.php Support/Twig/
git mv Twig/Extension/AssetExtension.php Support/Twig/
git mv Twig/Extension/ContentModeExtension.php Support/Twig/
git mv Twig/Extension/RoleExtension.php Support/Twig/
git mv Twig/Extension/RouteDisplayExtension.php Support/Twig/
git mv Twig/Extension/SafeHtmlExtension.php Support/Twig/
git mv Twig/Extension/SemesterExtension.php Support/Twig/

# Form (legacy)
git mv Form/Extension/FieldTypeHelpExtension.php Support/Form/
git mv Form/Type/CropImageType.php Support/Form/
git mv Form/Type/TelType.php Support/Form/

# DataFixtures
git mv DataFixtures Support/DataFixtures
```

- [ ] **Step 2: Update namespaces in all moved files**

Namespace mapping patterns:

| Old | New |
|-----|-----|
| `App\Mailer` | `App\Support\Infrastructure\Mailer` |
| `App\Sms` | `App\Support\Infrastructure\Sms` |
| `App\Google` | `App\Support\Infrastructure\Google` |
| `App\Service\SlackMailer` | `App\Support\Infrastructure\Slack\SlackMailer` |
| `App\Service\SlackMessenger` | `App\Support\Infrastructure\Slack\SlackMessenger` |
| `App\Service\FileUploader` | `App\Support\Infrastructure\FileUploader` |
| `App\Service\LogService` | `App\Support\Infrastructure\LogService` |
| `App\Service\BetaRedirecter` | `App\Support\Infrastructure\BetaRedirecter` |
| `App\Service\GeoLocation` | `App\Support\Infrastructure\GeoLocation` |
| `App\Service\FilterService` | `App\Support\FilterService` |
| `App\Service\Sorter` | `App\Support\Sorter` |
| `App\Utils` | `App\Support\Utils` |
| `App\EventSubscriber` | `App\Support\EventSubscriber` |
| `App\Controller\BaseController` | `App\Support\Controller\BaseController` |
| `App\Twig\Extension` | `App\Support\Twig` |
| `App\Form\Extension` | `App\Support\Form` |
| `App\Form\Type\CropImageType` | `App\Support\Form\CropImageType` |
| `App\DataFixtures\ORM` | `App\Support\DataFixtures\ORM` |

- [ ] **Step 3: Update `use` statements across the entire codebase**

Every file importing from the moved namespaces needs updating. Key high-impact replacements:

```
use App\Mailer\MailerInterface;     → use App\Support\Infrastructure\Mailer\MailerInterface;
use App\Mailer\Mailer;              → use App\Support\Infrastructure\Mailer\Mailer;
use App\Sms\SmsSenderInterface;     → use App\Support\Infrastructure\Sms\SmsSenderInterface;
use App\Controller\BaseController;  → use App\Support\Controller\BaseController;
use App\Service\LogService;         → use App\Support\Infrastructure\LogService;
use App\Service\FileUploader;       → use App\Support\Infrastructure\FileUploader;
use App\Service\SlackMessenger;     → use App\Support\Infrastructure\Slack\SlackMessenger;
```

- [ ] **Step 4: Update services.yaml explicit service references**

All explicit service definitions referencing moved classes must be updated. This includes:
- `App\Mailer\Mailer` → `App\Support\Infrastructure\Mailer\Mailer`
- `App\Sms\SmsSender` → `App\Support\Infrastructure\Sms\SmsSender`
- `App\Sms\GatewayAPI` → `App\Support\Infrastructure\Sms\GatewayAPI`
- `App\Sms\SlackSms` → `App\Support\Infrastructure\Sms\SlackSms`
- `App\Google\*` → `App\Support\Infrastructure\Google\*`
- `App\Service\*` → corresponding new namespaces
- `App\EventSubscriber\DbSubscriber` → `App\Support\EventSubscriber\DbSubscriber`
- `App\Twig\Extension\*` → `App\Support\Twig\*`
- `App\Validator\Constraints\` resource path
- `App\DataFixtures\ORM\` resource path
- Interface bindings in `_defaults.bind`

- [ ] **Step 5: Run full test suite**

```bash
cd apps/server
php -d memory_limit=512M bin/phpunit 2>&1 | tail -5
```

Expected: 1001 tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: migrate Support to App\Support namespace"
```

---

### Task 3: Migrate Content (52 files)

**Files:** See spec section "Content"

- [ ] **Step 1: Move files with git mv**

Move all Content entities, repositories, services, events, subscribers, API resources, state handlers, controllers, forms, twig extensions, and validators per the spec migration map.

- [ ] **Step 2: Update namespaces in all moved files**

| Old | New |
|-----|-----|
| `App\Entity\Article` | `App\Content\Infrastructure\Entity\Article` |
| `App\Entity\Repository\ArticleRepository` | `App\Content\Infrastructure\Repository\ArticleRepository` |
| `App\ApiResource\AdminChangelogWriteResource` | `App\Content\Api\Resource\AdminChangelogWriteResource` |
| `App\State\AdminChangelogCreateProcessor` | `App\Content\Api\State\AdminChangelogCreateProcessor` |
| `App\Event\SupportTicketCreatedEvent` | `App\Content\Domain\Events\SupportTicketCreatedEvent` |
| `App\EventSubscriber\SupportTicketSubscriber` | `App\Content\Infrastructure\Subscriber\SupportTicketSubscriber` |
| `App\Service\ContentModeManager` | `App\Content\Infrastructure\ContentModeManager` |
| `App\Controller\ArticleController` | `App\Content\Controller\ArticleController` |
| `App\Form\Type\ArticleType` | `App\Content\Form\ArticleType` |
| `App\Twig\Extension\SponsorsExtension` | `App\Content\Twig\SponsorsExtension` |

- [ ] **Step 3: Update `use` statements across the entire codebase**
- [ ] **Step 4: Update services.yaml explicit references (if any)**
- [ ] **Step 5: Run full test suite** — Expected: 1001 tests passing
- [ ] **Step 6: Commit**

```bash
git commit -m "refactor: migrate Content to App\Content namespace"
```

---

### Task 4: Migrate Operations (39 files)

**Files:** See spec section "Operations"

Same pattern as Content. Move entities (Receipt, CertificateRequest, AssistantHistory, Signature), repositories, services, events, subscribers, API resources, state handlers, controllers, forms.

- [ ] **Steps 1-6:** Same pattern as Task 3. Commit message:

```bash
git commit -m "refactor: migrate Operations to App\Operations namespace"
```

---

## Chunk 3: Scheduling + Survey

### Task 5: Migrate Scheduling (25 files)

**Files:** See spec section "Scheduling"

Includes the existing `AssistantScheduling/` pure domain classes which move to `Scheduling/Domain/Rules/`.

- [ ] **Steps 1-6:** Same pattern. Note: `AssistantScheduling/School.php` and `AssistantScheduling/Assistant.php` move to `Scheduling/Domain/Rules/` with namespace `App\Scheduling\Domain\Rules`. Commit message:

```bash
git commit -m "refactor: migrate Scheduling to App\Scheduling namespace"
```

---

### Task 6: Migrate Survey (51 files)

**Files:** See spec section "Survey"

- [ ] **Steps 1-6:** Same pattern. Commit message:

```bash
git commit -m "refactor: migrate Survey to App\Survey namespace"
```

---

## Chunk 4: Admission + Interview

### Task 7: Migrate Admission (66 files)

**Files:** See spec section "Admission"

Largest context by file count. Includes InfoMeeting (moved from Content per resolved decision). Also includes EmailSender, ApplicationEmail validators, and substitute-related files.

**Watch for non-standard paths:**
- `Model/ApplicationStatus.php` → `Admission/Domain/ValueObjects/` (not in Entity/)
- `Validator/Constraints/InfoMeeting*.php` → `Admission/Infrastructure/Validator/`
- `Service/EmailSender.php` → `Admission/Infrastructure/` (not Support)

- [ ] **Steps 1-6:** Same pattern. Commit message:

```bash
git commit -m "refactor: migrate Admission to App\Admission namespace"
```

---

### Task 8: Migrate Interview (65 files)

**Files:** See spec section "Interview"

Second-largest context. Includes all Interview state processors (20 files), form types (14 files), and commands.

**Watch for non-standard paths:**
- `Form/InterviewNewTimeType.php` — NOT in `Form/Type/`, directly in `Form/`
- `Type/InterviewStatusType.php` → `Interview/Domain/ValueObjects/` (convert to enum)
- `Validator/Constraints/InterviewAnswer*.php` → `Interview/Infrastructure/Validator/`
- `Command/SendAcceptInterviewReminderCommand.php` → `Interview/Infrastructure/Command/`
- `Command/SendListOfScheduledInterviewsCommand.php` → `Interview/Infrastructure/Command/`

- [ ] **Steps 1-6:** Same pattern. Commit message:

```bash
git commit -m "refactor: migrate Interview to App\Interview namespace"
```

---

## Chunk 5: Organization + Identity + Cleanup

### Task 9: Migrate Organization (82 files)

**Files:** See spec section "Organization"

Most files. Includes Department, Team, FieldOfStudy, UserGroup, and all membership-related entities.

- [ ] **Steps 1-6:** Same pattern. Commit message:

```bash
git commit -m "refactor: migrate Organization to App\Organization namespace"
```

---

### Task 10: Migrate Identity (68 files)

**Files:** See spec section "Identity"

Last context. After this, `src/App/Entity/`, `src/App/Service/`, etc. should be empty.

**Watch for non-standard paths:**
- `AutoMapper/UserMap.php` → `Identity/Infrastructure/`
- `Security/UserChecker.php` → `Identity/Infrastructure/`
- `Role/Roles.php` → `Identity/Domain/`
- `Role/ReversedRoleHierarchy.php` → `Identity/Infrastructure/`

**High impact:** `App\Entity\User` is imported by ~100+ files across all contexts.
The `use` statement update will be the largest single find-replace of the entire
migration. Run tests carefully.

- [ ] **Steps 1-6:** Same pattern. Commit message:

```bash
git commit -m "refactor: migrate Identity to App\Identity namespace"
```

---

### Task 11: Cleanup legacy directories and config

After all contexts are migrated, the old flat directories should be empty.

- [ ] **Step 1: Verify old directories are empty**

```bash
cd apps/server/src/App
# These should all be empty (or not exist):
ls Entity/ Controller/ Service/ ApiResource/ State/ Event/ EventSubscriber/ \
   Form/ Twig/ Validator/ Type/ Model/ Role/ Security/ AutoMapper/ \
   Mailer/ Sms/ Google/ Utils/ Command/ AssistantScheduling/ DataFixtures/ 2>/dev/null
```

- [ ] **Step 2: Remove empty legacy directories**

```bash
cd apps/server/src/App
rmdir Entity/Repository Entity Controller Service ApiResource State \
      Event EventSubscriber Form/Type Form/Extension Form \
      Twig/Extension Twig Validator/Constraints Validator \
      Type Model Role Security AutoMapper Mailer Sms Google \
      Utils Command AssistantScheduling 2>/dev/null
```

- [ ] **Step 3: Remove legacy config entries from services.yaml**

Remove the old `App\:` resource block (line 45-46) and the old `App\Entity\Repository\:` block (line 48-49) that pointed to now-empty directories. Also remove the old `App\EventSubscriber\:`, `App\Validator\Constraints\:`, and `App\Twig\Extension\:` blocks.

- [ ] **Step 4: Remove legacy Doctrine mapping**

In `doctrine.yaml`, remove the `App:` mapping block that pointed to `src/App/Entity`.

- [ ] **Step 5: Remove legacy API Platform paths**

In `api_platform.yaml`, remove the two legacy paths:
- `src/App/Entity`
- `src/App/ApiResource`

- [ ] **Step 6: Run full test suite one final time**

```bash
cd apps/server
php bin/console cache:clear
php -d memory_limit=512M bin/phpunit 2>&1 | tail -5
```

Expected: 1001 tests, all passing.

- [ ] **Step 7: Run static analysis**

```bash
cd apps/server
composer analyse  # PHPStan
composer lint     # PHP-CS-Fixer
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove empty legacy directories and config entries"
```

---

## Execution Notes

### Namespace update strategy

For each context migration, the namespace update has two parts:

1. **In moved files:** Change the `namespace` declaration at the top of each file.
2. **Across the codebase:** Find-replace all `use` statements that reference moved classes.

Use this approach for safety:

```bash
# Example: Find all files importing App\Entity\Article
grep -rl 'use App\\Entity\\Article;' apps/server/src/ apps/server/tests/ | \
  xargs sed -i '' 's/use App\\Entity\\Article;/use App\\Content\\Infrastructure\\Entity\\Article;/g'
```

Also update:
- Doctrine `targetEntity` strings in ORM attributes: `targetEntity: 'Article'` may need full class name if the entity moved to a different namespace.
- `repositoryClass` references in `#[ORM\Entity]` attributes.
- String references in services.yaml (explicit service definitions).
- `provider:` and `processor:` class references in `#[ApiResource]` attributes.

### Doctrine targetEntity handling

Doctrine `targetEntity` values that use short class names (e.g., `targetEntity: 'User'`) resolve relative to the current entity's namespace. When entities move to different namespaces, these must become fully qualified:

```php
// Before (both in App\Entity namespace — short name works):
#[ORM\ManyToOne(targetEntity: 'User')]

// After (Application in Admission, User in Identity — need FQCN):
#[ORM\ManyToOne(targetEntity: \App\Identity\Infrastructure\Entity\User::class)]
```

Use `::class` syntax instead of strings for type safety.

### Test file updates

Test files in `apps/server/tests/` also use `use` statements that reference moved classes. These must be updated alongside source files. The test directory structure does NOT need to mirror the bounded context structure — tests can stay flat as long as `use` statements are correct.

### Order of operations

The migration order (Shared → Support → Content → Operations → Scheduling → Survey → Admission → Interview → Organization → Identity) is chosen to minimize the number of cross-context `use` statement updates per task. Contexts that are most-referenced (Identity, Organization) go last so their old namespace is available longest.

### Rollback

Each task is one atomic commit. If tests fail after a context migration, `git reset --hard HEAD~1` reverts to the last working state. No partial migrations — each commit has all files moved AND all references updated.

### PHPStan and PHP-CS-Fixer

PHPStan may need its configuration updated if it references specific paths. Check `apps/server/phpstan.neon` after the migration. PHP-CS-Fixer should work automatically since it scans all `.php` files.
