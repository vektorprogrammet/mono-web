[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/schools

This folder holds the Schools bounded context in `apps/dashboard/app/foldkit`.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

The Schools context in other folders:

- [apps/backend/src/schools](../../../../backend/src/schools/AGENTS.md)
- [packages/database/src/schools](../../../../../packages/database/src/schools/AGENTS.md)
- [packages/domain/src/schools](../../../../../packages/domain/src/schools/AGENTS.md)

## Bounded context: Schools

From [docs/model/contexts.cml](../../../../../docs/model/contexts.cml).

Partner-school identities, contacts, language, activity and department associations, and capacity plans per school, department and semester. There is no school deletion. Directory membership grants no maintenance authority.

Responsibilities:

- Schools
- Department associations
- Capacity plans

### Owns

- `School`
- `CapacityPlan`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of AccessControl
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                            |
| ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| AccessControl                             | open host service, published language, conformist | Scope resolver: school -> associated departments (all must be covered) |
| AcademicCalendar                          | open host service, published language, conformist |                                                                        |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                        |

### Downstream

| Context                                         | Relationship       | Exposes                  | Integration                                                                                                                                                                             |
| ----------------------------------------------- | ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Placements](../dated-school-service/AGENTS.md) | supplier, customer | `School`, `CapacityPlan` | Active school, department association and capacity, which bounds the scheduling function; Placements answers the dependent-records query Schools needs before an association is removed |

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
