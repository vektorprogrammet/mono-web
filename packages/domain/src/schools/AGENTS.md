[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/schools

This folder holds the Schools bounded context in `packages/domain/src`.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The Schools context in other folders:

- [apps/backend/src/schools](../../../../apps/backend/src/schools/AGENTS.md)
- [apps/dashboard/app/foldkit/schools](../../../../apps/dashboard/app/foldkit/schools/AGENTS.md)
- [packages/database/src/schools](../../../database/src/schools/AGENTS.md)

## Bounded context: Schools

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Partner-school identities, contacts, language, activity and department associations, and capacity plans per school, department and semester. There is no school deletion. Directory membership grants no maintenance authority.

Responsibilities:

- Schools
- Department associations
- Capacity plans

### Owns

- `School`
- `CapacityPlan`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of [AccessControl](../authz/AGENTS.md)
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                            |
| ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist | Scope resolver: school -> associated departments (all must be covered) |
| AcademicCalendar                          | open host service, published language, conformist |                                                                        |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                        |

### Downstream

| Context                               | Relationship       | Exposes                  | Integration                                                                                                                                                                             |
| ------------------------------------- | ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Placements](../placements/AGENTS.md) | supplier, customer | `School`, `CapacityPlan` | Active school, department association and capacity, which bounds the scheduling function; Placements answers the dependent-records query Schools needs before an association is removed |

## Entry points

| Import                             | Module               |
| ---------------------------------- | -------------------- |
| `@vektorprogrammet/domain/schools` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
