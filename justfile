# The command surface of the repository. Run recipes inside `devenv shell`; `just` lists them.
# A recipe runs a pinned tool from the shell or a TypeScript file under tools/ for real logic.
# README.md and AGENTS.md carry a table of these recipes; `just layout write` renders it.

set positional-arguments

[private]
default:
    @just --list

# Start the homepage, dashboard, and backend against BACKEND_PG_URL. `devenv up` runs it.
[group('develop')]
dev *args:
    bun --no-env-file tools/scripts/dev.ts "$@"

# Provision the native journey accounts in the `devenv up` database.
[group('develop')]
seed:
    JOURNEY_SEED_PG_URL="postgresql://vektorprogrammet@127.0.0.1:$PGPORT/vektorprogrammet" \
      NATIVE_IDENTITY_DEPLOYMENT=local \
      NATIVE_IDENTITY_TRUSTED_ORIGINS='["http://127.0.0.1:5173"]' \
      bun --no-env-file apps/dashboard/e2e/native-users-journey-seed.mjs

# Serve the documentation site, or run another of its scripts, such as `just docs build`.
[group('develop')]
docs script="dev":
    bun run --cwd apps/docs "$1"

# Build every package through Turbo. Arguments go to Turbo.
[group('develop')]
build *args:
    bun x turbo build "$@"

# Regenerate CHANGELOG.md from conventional commits, or compare it with `--check`.
[group('develop')]
changelog *args:
    bun tools/scripts/changelog.ts "$@"

# Land a branch on main in the main checkout, then remove its worktree and delete it. It does not push.
[group('develop')]
land branch:
    bun --no-env-file tools/scripts/land.ts "$1"

# Check layout, constructs, guides, Effect exceptions, source safety, format, lint, types, and the HTTP contract. Arguments go to Turbo.
[group('check')]
check *args: layout constructs guides exceptions source-safety (format "--check") lint
    bun x turbo check-types "$@"

# Check the repository layout and its generated sections: the README and AGENTS.md tables and the hosted journey legs; `just layout write` renders them.
[group('check')]
layout *args:
    bun --no-env-file tools/conventions/src/cli.ts layout "$@"

# Check the construct index and contract pages against the @construct tags and their JSDoc, and count each construct's consumers; `just constructs write` renders the pages, and `just constructs consumers [name]` prints the modules that import a construct.
[group('check')]
constructs *args:
    bun --no-env-file tools/conventions/src/cli.ts constructs "$@"

# Check the AGENTS.md guide and the CLAUDE.md that imports it, of every app, package, and context folder; `just guides write` renders them.
[group('check')]
guides *args:
    bun --no-env-file tools/conventions/src/cli.ts guides "$@"

# Check that every suppression of an Effect rule names its entry in docs/effect-exceptions.json, and every entry its current sites and versions.
[group('check')]
exceptions *args:
    bun --no-env-file tools/conventions/src/cli.ts exceptions "$@"

# Check the migration registry and the checksums of applied migrations; `just migration-hashes write` records new ones.
[group('check')]
migration-hashes *args:
    bun --no-env-file packages/database/src/migration-manifest-cli.ts "$@"

# Scan every file in the Git index for credentials, personal data, and SQL data.
[group('check')]
source-safety:
    bun --no-env-file tools/source-safety/src/check.ts

# Format with Oxfmt, or check the format with `just format --check`.
[group('check')]
format *args="--write":
    bun x oxfmt "$@"

# Lint with Oxlint in type-aware mode after generating the React Router route types, a heavy job (AGENTS.md#verification-and-resources).
[group('check')]
lint *args=".":
    bun run --cwd apps/dashboard typegen
    bun run --cwd apps/homepage typegen
    bun x oxlint "$@"

# Type check every package and assert the HTTP contract. Arguments go to Turbo.
[group('check')]
check-types *args:
    bun x turbo check-types "$@"

# Test every package, a heavy job (AGENTS.md#verification-and-resources). Arguments go to Turbo.
[group('check')]
test *args:
    bun x turbo test "$@"

# Run a heavy job under the machine-wide heavy lock and measure it, or show the ledger with `just measure --report`.
[group('check')]
measure *args:
    bun --no-env-file tools/scripts/measure-job.ts "$@"

# Run the Alloy commands of docs/model/authority.als (check) or validate docs/model/contexts.cml (validate), a heavy job.
[group('check')]
model action:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      check | validate) exec just measure --class "model-$1" -- bun --no-env-file tools/scripts/model.ts "$1" ;;
      *) echo "Unknown action '$1'. Use check or validate." >&2; exit 2 ;;
    esac

# Run a golden journey: school-service, recruitment, reimbursement, or team-application.
[group('journeys')]
golden journey:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      school-service | recruitment) exec bun --no-env-file tools/e2e/placement-check.ts "--golden-$1" ;;
      reimbursement) exec bun --no-env-file tools/e2e/golden-reimbursement.mjs ;;
      team-application) exec bun --no-env-file tools/e2e/golden-team-application.ts ;;
      *) echo "Unknown journey '$1'. Use school-service, recruitment, reimbursement, or team-application." >&2; exit 2 ;;
    esac

# Run a browser suite: admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, onboarding, organization, owner, password-recovery, profile, recommendation, recommendation-applicant-progress, recommendation-co-interviewer, recommendation-correction, recommendation-report, recommendation-returning, recruitment, scheduling, schools, settlement, sign-in-pages, social-events, substitutes, or unavailable-projections.
[group('journeys')]
e2e suite:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      applicant) exec bun run --cwd apps/homepage e2e:applicant:real ;;
      contact) exec bun run --cwd apps/homepage e2e:contact:native ;;
      admission-periods | approval | conduct | content-publication | identity | interview-response | organization | owner | profile | recruitment | scheduling | schools | settlement | social-events | substitutes)
        exec bun run --cwd apps/dashboard "e2e:real-$1" ;;
      sign-in-pages | unavailable-projections) exec bun run --cwd apps/dashboard "e2e:$1" ;;
      onboarding) exec bun --no-env-file tools/acceptance/onboarding-check.ts --browser ;;
      password-recovery) exec bun --no-env-file tools/acceptance/password-recovery-check.ts ;;
      recommendation) exec bun --no-env-file tools/acceptance/recommendation-check.ts ;;
      recommendation-applicant-progress) exec bun --no-env-file tools/acceptance/recommendation-check.ts --applicant-progress-mode ;;
      recommendation-co-interviewer) exec bun --no-env-file tools/acceptance/recommendation-check.ts --co-interviewer-mode ;;
      recommendation-correction) exec bun --no-env-file tools/acceptance/recommendation-check.ts --correction-mode ;;
      recommendation-report) exec bun --no-env-file tools/acceptance/recommendation-check.ts --report ;;
      recommendation-returning) exec bun --no-env-file tools/acceptance/recommendation-check.ts --returning-mode ;;
      *) echo "Unknown suite '$1'. Use admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, onboarding, organization, owner, password-recovery, profile, recommendation, recommendation-applicant-progress, recommendation-co-interviewer, recommendation-correction, recommendation-report, recommendation-returning, recruitment, scheduling, schools, settlement, sign-in-pages, social-events, substitutes, or unavailable-projections." >&2; exit 2 ;;
    esac

# Run a PostgreSQL proof: authorization-rules, delivery-recovery, or rule-reconciliation.
[group('journeys')]
proof name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    name="$1"
    shift
    case "$name" in
      authorization-rules) exec bun run packages/database/runtime/authorization-rules-postgres-proof-main.ts "$@" ;;
      delivery-recovery) exec bun --no-env-file tools/verification/unattended-delivery-recovery.ts "$@" ;;
      rule-reconciliation) exec bun run packages/database/runtime/rule-reconciliation-postgres-tracer-main.ts "$@" ;;
      *) echo "Unknown proof '$name'. Use authorization-rules, delivery-recovery, or rule-reconciliation." >&2; exit 2 ;;
    esac

# Build a PostgreSQL fixture in JOURNEY_SEED_PG_URL: recommendation-preupgrade.
[group('journeys')]
fixture name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    name="$1"
    shift
    case "$name" in
      recommendation-preupgrade) exec bun run tools/verification/recommendation-preupgrade-fixture.ts "$@" ;;
      *) echo "Unknown fixture '$name'. Use recommendation-preupgrade." >&2; exit 2 ;;
    esac

# Run a migration rehearsal, where account-cohort and the legacy ones need the legacy-data profile: organization-import, receipt-import, current-assignment, account-cohort, legacy-current-assignment, legacy-organization, legacy-receipt, or legacy-candidate.
[group('migration')]
rehearsal name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    name="$1"
    shift
    case "$name" in
      account-cohort | legacy-*) bun --no-env-file tools/scripts/require-legacy-data-profile.ts ;;
    esac
    case "$name" in
      organization-import) exec bun run tools/verification/organization-import-rehearsal-main.ts "$@" ;;
      receipt-import) exec bun run tools/verification/receipt-import-rehearsal.ts "$@" ;;
      current-assignment) exec bun --no-env-file tools/verification/current-assignment-cohort-rehearsal.ts "$@" ;;
      account-cohort) exec bun run tools/verification/identity-cohort-rehearsal.ts "$@" ;;
      legacy-current-assignment) exec bun --no-env-file tools/e2e/run-legacy-current-assignment-rehearsal.ts "$@" ;;
      legacy-organization) exec bun --no-env-file tools/e2e/run-legacy-organization-rehearsal.ts "$@" ;;
      legacy-receipt) exec bun --no-env-file tools/e2e/run-legacy-receipt-rehearsal.ts "$@" ;;
      legacy-candidate) exec bun --no-env-file tools/e2e/run-legacy-candidate-rehearsal.ts "$@" ;;
      *) echo "Unknown rehearsal '$name'. Use organization-import, receipt-import, current-assignment, account-cohort, legacy-current-assignment, legacy-organization, legacy-receipt, or legacy-candidate." >&2; exit 2 ;;
    esac

# Run an operator migration command: legacy-service (the service cutover) or legacy-receipt.
[group('migration')]
migration name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    name="$1"
    shift
    case "$name" in
      legacy-service) exec bun --no-env-file tools/e2e/run-legacy-service-cutover.ts "$@" ;;
      legacy-receipt) exec bun --no-env-file tools/e2e/run-legacy-receipt-import.ts "$@" ;;
      *) echo "Unknown migration '$name'. Use legacy-service or legacy-receipt." >&2; exit 2 ;;
    esac

# Type check and test the packages that the staged tree changes (pre-commit and merge hooks).
[group('hooks')]
check-staged *args:
    bun --no-env-file tools/scripts/check-staged.ts "$@"

# Run a command in one of the machine-wide hook slots under the shared heavy lock (lint and pre-push hooks).
[group('hooks')]
hook-slot *args:
    bun --no-env-file tools/scripts/hook-slot.ts "$@"

# Run the Git hooks by hand, for example `just hooks --hook-stage pre-push`.
[group('hooks')]
hooks *args:
    prek run "$@"
