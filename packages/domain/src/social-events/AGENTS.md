[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/social-events

This folder holds the SocialEvents bounded context in `packages/domain/src`.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The SocialEvents context in other folders:

- [apps/backend/src/social-events](../../../../apps/backend/src/social-events/AGENTS.md)
- [apps/dashboard/app/foldkit/social-events](../../../../apps/dashboard/app/foldkit/social-events/AGENTS.md)
- [packages/database/src/social-events](../../../database/src/social-events/AGENTS.md)

## Bounded context: SocialEvents

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Social events for student members of a department in a semester.

Responsibilities:

- Social events

### Owns

- `SocialEvent`

### Uses but does not own

- `PrincipalAlgebra` of [AccessControl](../authz/AGENTS.md)
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist |             |
| AcademicCalendar                          | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |

### Downstream

No downstream context.

## Entry points

| Import                                   | Module               |
| ---------------------------------------- | -------------------- |
| `@vektorprogrammet/domain/social-events` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
