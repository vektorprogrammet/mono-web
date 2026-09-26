[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain

Business values, transitions, failures, and authority.
Package `@vektorprogrammet/domain`.

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
| `identity`         | Identity         | [AGENTS.md](src/identity/AGENTS.md)         |
| `notification`     | Delivery         | [AGENTS.md](src/notification/AGENTS.md)     |
| `onboarding`       | Recruitment      | [AGENTS.md](src/onboarding/AGENTS.md)       |
| `organization`     | Organization     | [AGENTS.md](src/organization/AGENTS.md)     |
| `placements`       | Placements       | [AGENTS.md](src/placements/AGENTS.md)       |
| `profile`          | People           | [AGENTS.md](src/profile/AGENTS.md)          |
| `receipt`          | Economy          | [AGENTS.md](src/receipt/AGENTS.md)          |
| `recruitment`      | Recruitment      | [AGENTS.md](src/recruitment/AGENTS.md)      |
| `schools`          | Schools          | [AGENTS.md](src/schools/AGENTS.md)          |
| `shared-kernel`    | shared kernel    | [AGENTS.md](src/shared-kernel/AGENTS.md)    |
| `social-events`    | SocialEvents     | [AGENTS.md](src/social-events/AGENTS.md)    |
| `substitutes`      | Placements       | [AGENTS.md](src/substitutes/AGENTS.md)      |
| `team-application` | TeamApplications | [AGENTS.md](src/team-application/AGENTS.md) |
| `tutor`            | none             | [AGENTS.md](src/tutor/AGENTS.md)            |

## Entry points

| Import                                                     | Module                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@vektorprogrammet/domain`                                 | [src/index.ts](src/index.ts)                                                                               |
| `@vektorprogrammet/domain/schema`                          | [src/schema.ts](src/schema.ts)                                                                             |
| `@vektorprogrammet/domain/data`                            | [src/data.ts](src/data.ts)                                                                                 |
| `@vektorprogrammet/domain/runtime-services`                | [src/runtime-services.ts](src/runtime-services.ts)                                                         |
| `@vektorprogrammet/domain/runtime/node`                    | [runtime/node.ts](runtime/node.ts)                                                                         |
| `@vektorprogrammet/domain/laws`                            | [src/laws.ts](src/laws.ts)                                                                                 |
| `@vektorprogrammet/domain/report`                          | [src/report.ts](src/report.ts)                                                                             |
| `@vektorprogrammet/domain/fixtures`                        | [src/fixtures.ts](src/fixtures.ts)                                                                         |
| `@vektorprogrammet/domain/capabilities`                    | [src/capabilities.ts](src/capabilities.ts)                                                                 |
| `@vektorprogrammet/domain/authz`                           | [src/authz/index.ts](src/authz/index.ts)                                                                   |
| `@vektorprogrammet/domain/mail`                            | [src/mail.ts](src/mail.ts)                                                                                 |
| `@vektorprogrammet/domain/receipt`                         | [src/receipt/index.ts](src/receipt/index.ts)                                                               |
| `@vektorprogrammet/domain/application`                     | [src/application/index.ts](src/application/index.ts)                                                       |
| `@vektorprogrammet/domain/admission-period`                | [src/admission-period/index.ts](src/admission-period/index.ts)                                             |
| `@vektorprogrammet/domain/admissions`                      | [src/admissions/index.ts](src/admissions/index.ts)                                                         |
| `@vektorprogrammet/domain/organization`                    | [src/organization/index.ts](src/organization/index.ts)                                                     |
| `@vektorprogrammet/domain/content`                         | [src/content/index.ts](src/content/index.ts)                                                               |
| `@vektorprogrammet/domain/social-events`                   | [src/social-events/index.ts](src/social-events/index.ts)                                                   |
| `@vektorprogrammet/domain/profile`                         | [src/profile/index.ts](src/profile/index.ts)                                                               |
| `@vektorprogrammet/domain/schools`                         | [src/schools/index.ts](src/schools/index.ts)                                                               |
| `@vektorprogrammet/domain/identity`                        | [src/identity/index.ts](src/identity/index.ts)                                                             |
| `@vektorprogrammet/domain/http-semantics`                  | [src/http-semantics.ts](src/http-semantics.ts)                                                             |
| `@vektorprogrammet/domain/recruitment`                     | [src/recruitment/index.ts](src/recruitment/index.ts)                                                       |
| `@vektorprogrammet/domain/notification`                    | [src/notification/index.ts](src/notification/index.ts)                                                     |
| `@vektorprogrammet/domain/shared-kernel`                   | [src/shared-kernel/index.ts](src/shared-kernel/index.ts)                                                   |
| `@vektorprogrammet/domain/time`                            | [src/time.ts](src/time.ts)                                                                                 |
| `@vektorprogrammet/domain/contact`                         | [src/contact/index.ts](src/contact/index.ts)                                                               |
| `@vektorprogrammet/domain/substitutes`                     | [src/substitutes/index.ts](src/substitutes/index.ts)                                                       |
| `@vektorprogrammet/domain/team-application`                | [src/team-application/index.ts](src/team-application/index.ts)                                             |
| `@vektorprogrammet/domain/onboarding`                      | [src/onboarding/index.ts](src/onboarding/index.ts)                                                         |
| `@vektorprogrammet/domain/placements`                      | [src/placements/index.ts](src/placements/index.ts)                                                         |
| `@vektorprogrammet/domain/organization/authority-fixtures` | [src/organization/authority-fixtures.test-support.ts](src/organization/authority-fixtures.test-support.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
