# Handoff: Post-Guard Parity & Quality Gates

You are picking up work on the Vektorprogrammet monorepo after a major
quality and security session. Read this, then check CLAUDE.md and MEMORY.md
for full context before proposing any work.

## What just happened (2026-03-20 to 2026-03-21)

Two workstreams completed in a single session (~62 commits, 302 files):

### 1. Domain Extractions (FCIS Functional Core)

Extracted 10 pure business rules from Infrastructure services into
`Domain/Rules/` classes. 7 new classes, 64 unit tests, 10 state machine
tests. All with two-stage code review (spec compliance + quality).

**Completed extractions:**
- `AdmissionStatistics` — graph data (now accepts `$now` param for purity)
- `InterviewCounter` — suitability counting (with `Suitability` PHP enum)
- `RoleHierarchy` — role validation + hierarchy (const arrays)
- `SurveyDataTransformer` — target audience, text answers, team names
- `ApplicationStatusRule` — application status derivation (primitives, no cross-context)
- `UserGroupDistribution` — user-to-group distribution algorithm
- `MembershipExpiration` — team membership date predicate

5 spec entries marked N/A (methods don't exist) or Skipped (fully impure).

### 2. Quality Gates & Security Fixes

**Lint tooling added:**
- deptrac — DDD architecture boundary enforcement (`composer deptrac`)
- PHPStan level 5 + strict rules (`composer analyse`) — 775 → 124 baseline (84% reduction)
- php-parallel-lint (`composer syntax`)
- 9 Claude Code hooks (PHP format, TS lint, strict_types, namespace check, targetEntity, container lint, scoped PHPUnit, dangerous command block, Twig guard)

**Security fixes (API Guard Parity):**
- AUTH-1: UserChecker added to API firewalls (deactivated users blocked)
- AUTH-3: Missing `throw` on access denied (1-line fix, regression test added)
- AUTH-4: Department scoping on 9 admin providers via `assertDepartmentAccess()`
- AUTH-5: 12 role upgrades across Interview, Organization, Scheduling, Admission
- AUTH relaxations: 3 endpoints relaxed to match monolith (UserList, ReceiptDashboard, ReceiptStatus)
- APP-1/APP-2: DB unique constraint on Application(user, admissionPeriod) + NotNull
- DATA-1/DATA-2: DB unique constraints on Semester, AdmissionPeriod
- TEAM-1: Null guard on `Department.getLatestAdmissionPeriod()`
- INTERVIEW-7/10: Interview state machine + suitability validation
- RECEIPT-1: Receipt state machine (pending→refunded|rejected, rejected→pending)
- Null guards: Interview interviewer/coInterviewer, User.getDepartment, TeamMembership.isActive checks isSuspended

**All 1087 tests pass. 3102 assertions.**

## Current architecture

Same DDD bounded context structure as before. Key additions:

```
{Context}/Domain/Rules/       # Now populated with pure business rules
{Context}/Domain/ValueObjects/ # Suitability enum added
.claude/skills/php-conventions/ # On-demand PHP conventions skill
.claude/rules/constitution.md   # Injected into all subagents via SubagentStart
.claude/settings.json           # 9 quality gate hooks
.claude/hooks/check-target-entity.sh
```

## Key reference documents

| Document | Location | Purpose |
|----------|----------|---------|
| DDD/FCIS Spec | `docs/superpowers/specs/2026-03-20-ddd-fcis-analysis-design.md` | Domain extractions table (with Status column) |
| Guard Parity Design | `docs/plans/2026-03-09-api-guard-parity-design.md` | Remaining ~30 fixes not yet implemented |
| Implicit Invariants | `docs/migration/contracts/implicit-invariants.md` | Full bug inventory (58 items, 27 fixed) |
| Server Conventions | `apps/server/docs/conventions.md` | Points to `php-conventions` skill |
| Migration Roadmap | `docs/migration/README.md` | Homepage, dashboard, state contracts |
| Dashboard Plan | `docs/migration/dashboard.md` | 23 routes, priority order |

## Three prioritized workstreams

### 1. Dashboard Mutations (highest user value)

The dashboard has 23 routes, all read-only. No mutation flows exist yet.
The first mutation flow establishes the pattern: React Router action → SDK
client → API endpoint. No example exists — build one as the template.

Priority from `docs/migration/dashboard.md`:

1. **Admission period CRUD** — quick win, unblocks homepage application form
2. **Application review** — display computed status, filter, assign interview
3. **Interview scheduling** — most complex UI (reschedule cycle)
4. **Receipt management** — simple 3-state DAG (state machine now enforced)

### 2. Remaining Guard Parity (~30 items)

From `docs/plans/2026-03-09-api-guard-parity-design.md`, not yet implemented:

**Missing effects:** Event dispatch in ProfileProcessor, TeamApplicationProcessor
**Missing fields:** accountNumber/fieldOfStudy on ProfileResource, team fields
**Missing guards:** Survey access extraction, team inactive filtering
**Missing features:** Interview draft-save, static content htmlId lookup
**AUTH-2 (default-deny):** Reverted — needs AccessRules for all legitimate routes first

### 3. PHPStan structural violations (124 remaining)

All strict rule violations resolved (0). Remaining 124 are level 5:
- `is_countable()` guards (Doctrine entity null collections)
- Cross-context PHPDoc type resolution
- Symfony internal method signatures

Diminishing returns — fix opportunistically when touching affected files.

## Conventions to follow

- **Invoke `php-conventions` skill** before modifying PHP code
- **Testing**: `dangerouslyDisableSandbox: true`, clear cache after namespace changes
- **Entity validation**: After adding state machines/constraints, verify fixture loading with `APP_ENV=test php bin/console doctrine:fixtures:load`
- **Domain layer**: Zero framework imports, read entities OK, construct/mutate not OK
- **Cross-context**: Domain never imports across contexts, use local mirror constants
- **Doctrine entities**: No native type declarations on collection properties, keep `is_countable()` guards
- **Commits**: Conventional Commits format

## Quality gates (automated)

| Gate | Trigger | What |
|------|---------|------|
| PHP CS-Fixer | PostToolUse Edit | Auto-format PHP |
| oxlint | PostToolUse Edit | Lint TS/TSX |
| strict_types | PostToolUse Edit | Warn if missing |
| Namespace check | PostToolUse Edit | Warn on mismatch |
| targetEntity | PostToolUse Edit | Warn on string form |
| Container lint | PostToolUse Edit (async) | Alert on DI failure |
| Scoped PHPUnit | PostToolUse Edit (async) | Alert on test failure |
| Dangerous cmds | PreToolUse Bash | Block doctrine:drop etc |
| Twig guard | PreToolUse Edit | Warn on deprecated layer |

## How to verify

```bash
cd apps/server
rm -rf var/cache/*
composer test:unit           # 258 tests (19 errors are pre-existing DB-dependent)
composer analyse             # PHPStan level 5 + strict (0 errors with baselines)
composer deptrac             # DDD boundary check
composer syntax              # php-parallel-lint
php -d memory_limit=512M bin/phpunit  # Full suite: 1087 tests, 3102 assertions
```
