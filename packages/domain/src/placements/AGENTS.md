[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/placements

This folder holds the Placements bounded context in `packages/domain/src`.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.
The human guide is [README.md](README.md).

The Placements context in other folders:

- [apps/backend/src/placements](../../../../apps/backend/src/placements/AGENTS.md)
- [apps/backend/src/substitutes](../../../../apps/backend/src/substitutes/AGENTS.md)
- [apps/dashboard/app/foldkit/dated-school-service](../../../../apps/dashboard/app/foldkit/dated-school-service/AGENTS.md)
- [packages/database/src/placements](../../../database/src/placements/AGENTS.md)
- [packages/database/src/substitutes](../../../database/src/substitutes/AGENTS.md)
- [packages/domain/src/substitutes](../substitutes/AGENTS.md)

## Bounded context: Placements

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Assistant supply (affiliation), semester placements, school demand, automatically drafted and reviewed proposals, confirmed rosters, dated school-service commitments, absences with a record of who covered each lesson date, days served and certificates, and immutable service outcomes and history. Substitutes and assistants arrange cover in Slack; the system records the result.

Responsibilities:

- Volunteer affiliation
- Placements
- Demand
- Placement drafts, proposals and rosters
- Commitments
- Absence and coverage
- Days served and certificates
- Service history

Implementation: packages/domain/src/placements: portable contracts; packages/database/src/placements: PostgreSQL service Layer and adapters

### Owns

- `VolunteerAffiliation`
- `Placement`
- `PlacementDemand`
- `PlacementProposal`
- `SchoolServiceCommitment`
- `Absence`
- `DaysServed`
- `Certificate`
- `HistoricalService`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of [AccessControl](../authz/AGENTS.md)
- `Person` and `Profile` of [People](../profile/AGENTS.md)
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)
- `School` and `CapacityPlan` of [Schools](../schools/AGENTS.md)
- `AdmissionApplication` of [Admissions](../admissions/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../notification/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist | Placements implements the RelationshipFactPort for affiliation, placement and roster membership                                                                                         |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |                                                                                                                                                                                         |
| AcademicCalendar                          | open host service, published language, conformist |                                                                                                                                                                                         |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                         |
| [Schools](../schools/AGENTS.md)           | supplier, customer                                | Active school, department association and capacity, which bounds the scheduling function; Placements answers the dependent-records query Schools needs before an association is removed |
| [Admissions](../admissions/AGENTS.md)     | open host service, published language, conformist | The scheduling function reads each accepted applicant's weekday availability, bolk and school wishes from the application; Placements never writes them                                 |
| [Delivery](../notification/AGENTS.md)     | open host service, published language, conformist |                                                                                                                                                                                         |
| LegacySymfony                             | anticorruption layer                              | Reviewed current assignments and append-only historical service                                                                                                                         |

### Downstream

| Context   | Relationship                                      | Exposes                                                        | Integration                                                                                           |
| --------- | ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Mailing   | open host service, published language, conformist | `Placement`, `HistoricalService`                               | Assistant recipients: accepted historical service and active placements for a department and semester |
| Reporting | open host service, published language, conformist | `VolunteerAffiliation`, `Placement`, `SchoolServiceCommitment` | Active assistants per department and semester count as active members                                 |

## Entry points

| Import                                | Module               |
| ------------------------------------- | -------------------- |
| `@vektorprogrammet/domain/placements` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
