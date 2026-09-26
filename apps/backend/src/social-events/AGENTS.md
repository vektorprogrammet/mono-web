[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/social-events

This folder holds the SocialEvents bounded context in `apps/backend/src`.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The SocialEvents context in other folders:

- [apps/dashboard/app/foldkit/social-events](../../../dashboard/app/foldkit/social-events/AGENTS.md)
- [packages/database/src/social-events](../../../../packages/database/src/social-events/AGENTS.md)
- [packages/domain/src/social-events](../../../../packages/domain/src/social-events/AGENTS.md)

## Bounded context: SocialEvents

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Social events for student members of a department in a semester.

Responsibilities:

- Social events

### Owns

- `SocialEvent`

### Uses but does not own

- `PrincipalAlgebra` of AccessControl
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| AccessControl                             | open host service, published language, conformist |             |
| AcademicCalendar                          | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |

### Downstream

No downstream context.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
