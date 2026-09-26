[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/substitutes

This folder holds Placements code under another name. Absence and coverage records, which the CML keeps in Placements.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Placements context in other folders:

- [apps/backend/src/placements](../placements/AGENTS.md)
- [apps/dashboard/app/foldkit/dated-school-service](../../../dashboard/app/foldkit/dated-school-service/AGENTS.md)
- [packages/database/src/placements](../../../../packages/database/src/placements/AGENTS.md)
- [packages/database/src/substitutes](../../../../packages/database/src/substitutes/AGENTS.md)
- [packages/domain/src/placements](../../../../packages/domain/src/placements/AGENTS.md)
- [packages/domain/src/substitutes](../../../../packages/domain/src/substitutes/AGENTS.md)

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

- `PrincipalAlgebra` and `CapabilityRegistry` of AccessControl
- `Person` and `Profile` of [People](../directory/AGENTS.md)
- `SemesterCatalogue` of AcademicCalendar
- `Department` of [Organization](../organization/AGENTS.md)
- `School` and `CapacityPlan` of [Schools](../schools/AGENTS.md)
- `AdmissionApplication` of [Admissions](../admission/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                             | open host service, published language, conformist | Placements implements the RelationshipFactPort for affiliation, placement and roster membership                                                                                         |
| [People](../directory/AGENTS.md)          | open host service, published language, conformist |                                                                                                                                                                                         |
| AcademicCalendar                          | open host service, published language, conformist |                                                                                                                                                                                         |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                         |
| [Schools](../schools/AGENTS.md)           | supplier, customer                                | Active school, department association and capacity, which bounds the scheduling function; Placements answers the dependent-records query Schools needs before an association is removed |
| [Admissions](../admission/AGENTS.md)      | open host service, published language, conformist | The scheduling function reads each accepted applicant's weekday availability, bolk and school wishes from the application; Placements never writes them                                 |
| [Delivery](../delivery/AGENTS.md)         | open host service, published language, conformist |                                                                                                                                                                                         |
| LegacySymfony                             | anticorruption layer                              | Reviewed current assignments and append-only historical service                                                                                                                         |

### Downstream

| Context   | Relationship                                      | Exposes                                                        | Integration                                                                                           |
| --------- | ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Mailing   | open host service, published language, conformist | `Placement`, `HistoricalService`                               | Assistant recipients: accepted historical service and active placements for a department and semester |
| Reporting | open host service, published language, conformist | `VolunteerAffiliation`, `Placement`, `SchoolServiceCommitment` | Active assistants per department and semester count as active members                                 |

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
