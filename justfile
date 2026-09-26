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

# Check layout, constructs, guides, source safety, format, lint, types, and the HTTP contract. Arguments go to Turbo.
[group('check')]
check *args: layout constructs guides source-safety (format "--check") lint
    bun x turbo check-types "$@"

# Check the repository layout and the generated README and AGENTS.md sections; `just layout write` renders them.
[group('check')]
layout *args:
    bun --no-env-file tools/conventions/src/cli.ts layout "$@"

# Check docs/constructs.md against the @construct tags and the imports; `just constructs write` renders it.
[group('check')]
constructs *args:
    bun --no-env-file tools/conventions/src/cli.ts constructs "$@"

# Check the AGENTS.md guide and CLAUDE.md link of every app, package, and context folder; `just guides write` renders them.
[group('check')]
guides *args:
    bun --no-env-file tools/conventions/src/cli.ts guides "$@"

# Scan every file in the Git index for credentials, personal data, and SQL data.
[group('check')]
source-safety:
    bun --no-env-file tools/source-safety/src/check.ts

# Format with Oxfmt, or check the format with `just format --check`.
[group('check')]
format *args="--write":
    bun x oxfmt "$@"

# Lint with Oxlint.
[group('check')]
lint *args=".":
    bun x oxlint "$@"

# Type check every package and assert the HTTP contract. Arguments go to Turbo.
[group('check')]
check-types *args:
    bun x turbo check-types "$@"

# Test every package, a heavy job (AGENTS.md#verification-and-resources). Arguments go to Turbo.
[group('check')]
test *args:
    bun x turbo test "$@"

# Run a heavy job with resource measurement, or show the ledger with `just measure --report`.
[group('check')]
measure *args:
    bun --no-env-file tools/scripts/measure-job.ts "$@"

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

# Run a browser suite: admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, organization, owner, profile, recruitment, scheduling, schools, settlement, social-events, or substitutes.
[group('journeys')]
e2e suite:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      applicant) exec bun run --cwd apps/homepage e2e:applicant:real ;;
      contact) exec bun run --cwd apps/homepage e2e:contact:native ;;
      admission-periods | approval | conduct | content-publication | identity | interview-response | organization | owner | profile | recruitment | scheduling | schools | settlement | social-events | substitutes)
        exec bun run --cwd apps/dashboard "e2e:real-$1" ;;
      *) echo "Unknown suite '$1'. Use admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, organization, owner, profile, recruitment, scheduling, schools, settlement, social-events, or substitutes." >&2; exit 2 ;;
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

# Run a migration rehearsal: organization-import, receipt-import, current-assignment, or, in the legacy-data profile, account-cohort, legacy-current-assignment, legacy-organization, legacy-receipt, legacy-candidate.
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

# Run a command in one of the machine-wide hook slots (pre-push hooks).
[group('hooks')]
hook-slot *args:
    bun --no-env-file tools/scripts/hook-slot.ts "$@"

# Run the Git hooks by hand, for example `just hooks --hook-stage pre-push`.
[group('hooks')]
hooks *args:
    prek run "$@"
