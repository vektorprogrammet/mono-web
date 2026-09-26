[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database

PostgreSQL schema, persistence, locks, audit, and outbox.
Package `@vektorprogrammet/database`.

## Context folders

Each folder of `src` holds a bounded context of [docs/model/contexts.cml](../../docs/model/contexts.cml), the shared kernel, or code that the layout declaration excepts. Each has its own guide.

| Folder             | Bounded context  | Guide                                       |
| ------------------ | ---------------- | ------------------------------------------- |
| `admission-period` | Admissions       | [AGENTS.md](src/admission-period/AGENTS.md) |
| `admissions`       | Admissions       | [AGENTS.md](src/admissions/AGENTS.md)       |
| `application`      | Admissions       | [AGENTS.md](src/application/AGENTS.md)      |
| `authz`            | AccessControl    | [AGENTS.md](src/authz/AGENTS.md)            |
| `contact`          | Contact          | [AGENTS.md](src/contact/AGENTS.md)          |
| `content`          | Content          | [AGENTS.md](src/content/AGENTS.md)          |
| `onboarding`       | Recruitment      | [AGENTS.md](src/onboarding/AGENTS.md)       |
| `organization`     | Organization     | [AGENTS.md](src/organization/AGENTS.md)     |
| `placements`       | Placements       | [AGENTS.md](src/placements/AGENTS.md)       |
| `profile`          | People           | [AGENTS.md](src/profile/AGENTS.md)          |
| `receipt`          | Economy          | [AGENTS.md](src/receipt/AGENTS.md)          |
| `recruitment`      | Recruitment      | [AGENTS.md](src/recruitment/AGENTS.md)      |
| `schools`          | Schools          | [AGENTS.md](src/schools/AGENTS.md)          |
| `social-events`    | SocialEvents     | [AGENTS.md](src/social-events/AGENTS.md)    |
| `team-application` | TeamApplications | [AGENTS.md](src/team-application/AGENTS.md) |
| `test-support`     | none             | [AGENTS.md](src/test-support/AGENTS.md)     |

## Entry points

| Import                                                     | Module                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@vektorprogrammet/database`                               | [src/index.ts](src/index.ts)                                                 |
| `@vektorprogrammet/database/admission-period`              | [src/admission-period/index.ts](src/admission-period/index.ts)               |
| `@vektorprogrammet/database/admissions`                    | [src/admissions/index.ts](src/admissions/index.ts)                           |
| `@vektorprogrammet/database/advisory-lock`                 | [src/advisory-lock.ts](src/advisory-lock.ts)                                 |
| `@vektorprogrammet/database/application`                   | [src/application/index.ts](src/application/index.ts)                         |
| `@vektorprogrammet/database/auth`                          | [src/auth-live.ts](src/auth-live.ts)                                         |
| `@vektorprogrammet/database/authz`                         | [src/authz/index.ts](src/authz/index.ts)                                     |
| `@vektorprogrammet/database/contact`                       | [src/contact/index.ts](src/contact/index.ts)                                 |
| `@vektorprogrammet/database/cohort-cli`                    | [src/cohort-cli.ts](src/cohort-cli.ts)                                       |
| `@vektorprogrammet/database/content`                       | [src/content/index.ts](src/content/index.ts)                                 |
| `@vektorprogrammet/database/historical-service-cohort`     | [src/historical-service-cohort.ts](src/historical-service-cohort.ts)         |
| `@vektorprogrammet/database/identity-cohort`               | [src/identity-cohort.ts](src/identity-cohort.ts)                             |
| `@vektorprogrammet/database/onboarding`                    | [src/onboarding/index.ts](src/onboarding/index.ts)                           |
| `@vektorprogrammet/database/organization`                  | [src/organization/index.ts](src/organization/index.ts)                       |
| `@vektorprogrammet/database/outbox-lifecycle`              | [src/outbox-lifecycle.ts](src/outbox-lifecycle.ts)                           |
| `@vektorprogrammet/database/live`                          | [src/layers.ts](src/layers.ts)                                               |
| `@vektorprogrammet/database/migrations`                    | [src/migrations.ts](src/migrations.ts)                                       |
| `@vektorprogrammet/database/password-recovery`             | [src/password-recovery.ts](src/password-recovery.ts)                         |
| `@vektorprogrammet/database/person-cohort`                 | [src/person-cohort.ts](src/person-cohort.ts)                                 |
| `@vektorprogrammet/database/placements`                    | [src/placements/index.ts](src/placements/index.ts)                           |
| `@vektorprogrammet/database/profile`                       | [src/profile/index.ts](src/profile/index.ts)                                 |
| `@vektorprogrammet/database/receipt/postgres`              | [src/receipt/postgres-index.ts](src/receipt/postgres-index.ts)               |
| `@vektorprogrammet/database/runtime`                       | [src/runtime-layer.ts](src/runtime-layer.ts)                                 |
| `@vektorprogrammet/database/recruitment`                   | [src/recruitment/index.ts](src/recruitment/index.ts)                         |
| `@vektorprogrammet/database/schools`                       | [src/schools/index.ts](src/schools/index.ts)                                 |
| `@vektorprogrammet/database/social-events`                 | [src/social-events/index.ts](src/social-events/index.ts)                     |
| `@vektorprogrammet/database/team-application`              | [src/team-application/index.ts](src/team-application/index.ts)               |
| `@vektorprogrammet/database/auth-engine`                   | [src/auth-engine.ts](src/auth-engine.ts)                                     |
| `@vektorprogrammet/database/identity-cohort-cli`           | [src/identity-cohort-cli.ts](src/identity-cohort-cli.ts)                     |
| `@vektorprogrammet/database/onboarding-account`            | [src/onboarding-account.ts](src/onboarding-account.ts)                       |
| `@vektorprogrammet/database/password-codec`                | [src/password-codec.ts](src/password-codec.ts)                               |
| `@vektorprogrammet/database/pg-pool`                       | [src/pg-pool.ts](src/pg-pool.ts)                                             |
| `@vektorprogrammet/database/test-support/observe-postgres` | [src/test-support/observe-postgres.ts](src/test-support/observe-postgres.ts) |

## Constructs

The shared constructs defined here. [docs/constructs.md](../../docs/constructs.md) lists their consumers.

- [`AdvisoryLockKey`](src/advisory-lock.ts) (sql-lock): The registered advisory-lock keys, one constructor per namespace.
- [`lockAdvisory`](src/advisory-lock.ts) (sql-lock): Waits for the advisory lock on `key` until the current transaction ends.
- [`tryLockAdvisory`](src/advisory-lock.ts) (sql-lock): Takes the exclusive advisory lock on `key` until the current transaction ends when no other transaction holds it.
- [`accountAccessEnabled`](src/identity-access.ts) (sql-lifecycle): Whether the native account of `personId` exists and is not disabled.
- [`selectDatabaseMigration`](src/migrations.ts) (test-harness): Selects the registered migration `id` and the migrations that run before it; an absent id throws and names the nearest registered ids.
- [`outboxClaimAssignments`](src/outbox-lifecycle.ts) (sql-lifecycle): SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.
- [`markOutboxDelivered`](src/outbox-lifecycle.ts) (sql-lifecycle): Settles the claimed row as Delivered, with delivery evidence when the table records it.
- [`markOutboxFailed`](src/outbox-lifecycle.ts) (sql-lifecycle): Settles the claimed row as Failed with its failure tag, so a later claim retries it.
- [`quarantineOutboxClaim`](src/outbox-lifecycle.ts) (sql-lifecycle): Settles the claimed row as Quarantined, a terminal status, with its failure tag.
- [`releaseOutboxClaim`](src/outbox-lifecycle.ts) (sql-lifecycle): Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.
- [`recoverStaleOutboxClaims`](src/outbox-lifecycle.ts) (sql-lifecycle): Recovers every Processing row claimed before `claimedBefore`.
- [`recoverStaleOutboxClaim`](src/outbox-lifecycle.ts) (sql-lifecycle): Recovers the rows of one claim when that claim was taken before `claimedBefore`.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
