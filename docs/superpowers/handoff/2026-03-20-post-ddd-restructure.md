# Handoff: Post-DDD Restructure

You are picking up work on the Vektorprogrammet monorepo after a major
architectural restructure. Read this, then check CLAUDE.md and MEMORY.md
for full context before proposing any work.

## What just happened

The Symfony server (`apps/server/src/App/`) was restructured from a flat
layer-by-layer namespace (`App\Entity\*`, `App\Service\*`, etc.) into 8
colocated bounded contexts with Functional Core, Imperative Shell (FCIS)
layering. Merged to main on 2026-03-20 (PR #9, 13 commits, 546 files).

**All 1011 tests pass. Zero behavioral changes — purely structural.**

## Current architecture

```
src/App/
  Admission/       # Application lifecycle (66 files)
  Interview/       # Scheduling, conducting, scoring (65 files)
  Organization/    # Departments, teams, boards, positions (82 files)
  Survey/          # Questionnaires, responses (51 files)
  Identity/        # Users, auth, roles, access control (68 files)
  Scheduling/      # Assistant-to-school assignment (25 files)
  Operations/      # Receipts, certificates, work history (39 files)
  Content/         # Articles, sponsors, events, feedback (52 files)
  Shared/          # Semester, cross-context interfaces (14 files)
  Support/         # Mailer, SMS, Google, utilities (43 files)
```

Each context has:
```
{Context}/
  Domain/Rules/          # Pure PHP (zero framework deps) — MOSTLY EMPTY, follow-up work
  Domain/ValueObjects/
  Domain/Events/         # Currently extends Symfony Event — impure, needs extraction
  Infrastructure/Entity/ # Doctrine entities
  Infrastructure/Repository/
  Infrastructure/Subscriber/
  Api/Resource/          # API Platform DTOs
  Api/State/             # Providers + Processors
  Controller/            # Legacy Twig (deprecated, removal target)
  Form/                  # Legacy form types (deprecated)
```

## Key reference documents

| Document | Location | Purpose |
|----------|----------|---------|
| DDD/FCIS Spec | `docs/superpowers/specs/2026-03-20-ddd-fcis-analysis-design.md` | End-state specification — bounded contexts, migration map, domain extractions, cross-context relations, resolved decisions |
| PDDL Domain | `docs/superpowers/specs/2026-03-20-sdk-pddl-domain.pddl` | State machine model for SDK type constraints |
| PDDL Analysis | `docs/superpowers/specs/2026-03-20-sdk-pddl-analysis.md` | How PDDL maps to TypeScript discriminated unions |
| Implementation Plan | `docs/superpowers/plans/2026-03-20-ddd-restructure.md` | Completed plan (for reference on decisions made) |
| Migration Roadmap | `docs/migration/README.md` | Overall migration progress — homepage, dashboard, state contracts |
| Dashboard Plan | `docs/migration/dashboard.md` | 23 routes, priority order, journey-based organization |
| State Contracts | `docs/migration/contracts/` | Application, Interview, Receipt, Membership lifecycle specs |
| Implicit Invariants | `docs/migration/contracts/implicit-invariants.md` | Security bugs and convention-enforced rules |
| Server Conventions | `apps/server/docs/conventions.md` | FCIS/DDD principles, testing, coding patterns |

## Three prioritized workstreams

### 1. Domain Extractions (FCIS functional core)

The spec's "Domain Extractions" table (section in the DDD spec) identifies 15
pure business rules to extract from services into `Domain/Rules/` classes.
Services were moved as-is during the restructure — the logic extraction is
separate work.

**Start with the easiest (already pure, just need to move):**
- `AdmissionStatistics` → all methods are pure data transformations
- `InterviewCounter` → fully pure aggregation
- `ReceiptStatistics` → already in `Operations/Domain/Rules/` (done)

**Then tackle extractions that require refactoring:**
- `ApplicationManager.getApplicationStatus()` → pure state derivation
- `RoleManager.isValidRole/canChangeToRole/mapAliasToRole` → pure hierarchy logic
- `TeamMembershipService` → expiration detection
- `UserGroupCollectionManager` → distribution algorithm

Each extraction: create pure PHP class in `Domain/Rules/`, move logic there,
have the Infrastructure service delegate to it. Domain class must have zero
`use Symfony\*` or `use Doctrine\*` imports.

### 2. Dashboard Mutations (highest user value)

The dashboard has 23 routes, all read-only. No mutation flows exist yet.
Priority from `docs/migration/dashboard.md`:

1. **Admission period CRUD** — quick win, unblocks homepage application form
   and all of Journey 1 (recruitment pipeline)
2. **Application review** — display computed status, filter, assign interview
3. **Interview scheduling** — the most complex UI (reschedule cycle)
4. **Profile editing** — partially done
5. **Receipt management** — simple 3-state DAG

The first mutation flow establishes the pattern: React Router action → SDK
client → API endpoint. No example exists yet — build one as the template.

### 3. Fix Implicit Invariants (security)

`docs/migration/contracts/implicit-invariants.md` documents 30+ bugs. Critical:

- **AUTH-1**: Deactivated users can use the API (UserChecker not on API firewall)
- **AUTH-5**: Destructive ops require only ROLE_TEAM_MEMBER (should be LEADER/ADMIN)
- **APP-1**: Application uniqueness — 3 of 4 creation paths skip the check
- **AUTH-4**: No department scoping on ~10 admin API endpoints

These are security bugs independent of architecture — fix them in the DDD
structure.

## Also resolved but not yet implemented

From the DDD spec's "Resolved Decisions":
- Convert `InterviewStatusType` to PHP enum (decision #5)
- Convert `InterviewScore.suitableAssistant` to backed string enum (decision #6)
- Remove `Application.user` cascade persist (decision #2)

## Conventions to follow

- **Testing**: Always `php -d memory_limit=512M`, always `dangerouslyDisableSandbox: true`, always clear cache before tests after config/namespace changes
- **Domain layer**: Zero framework imports. If you need `use Doctrine\*` or `use Symfony\*`, it belongs in Infrastructure, not Domain.
- **Cross-context**: Infrastructure may import across contexts. Domain never imports across contexts.
- **targetEntity**: Always `::class` syntax, never short strings
- **Twig templates**: Do NOT update FQCN references — the entire Twig/Controller layer is deprecated
- **Commits**: Conventional Commits format

## How to verify

```bash
cd apps/server
rm -rf var/cache/*
php -d memory_limit=512M bin/phpunit  # 1011 tests, ~280s
composer analyse                       # PHPStan level 1
composer lint                          # PHP-CS-Fixer
```
