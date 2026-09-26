[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/admissions

This folder holds the Admissions bounded context in `packages/database/src`.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

The Admissions context in other folders:

- [apps/backend/src/admission](../../../../apps/backend/src/admission/AGENTS.md)
- [apps/backend/src/application](../../../../apps/backend/src/application/AGENTS.md)
- [packages/database/src/admission-period](../admission-period/AGENTS.md)
- [packages/database/src/application](../application/AGENTS.md)
- [packages/domain/src/admission-period](../../../domain/src/admission-period/AGENTS.md)
- [packages/domain/src/admissions](../../../domain/src/admissions/AGENTS.md)
- [packages/domain/src/application](../../../domain/src/application/AGENTS.md)

## Bounded context: Admissions

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Admission periods per department and semester, public applications, and returning-assistant registrations. There is no inferred generic accepted-applicant fact.

Responsibilities:

- Admission periods
- Applications
- Applicants
- Returning registrations

### Owns

- `AdmissionPeriod`
- `Applicant`
- `AdmissionApplication`
- `ReturningRegistration`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of [AccessControl](../authz/AGENTS.md)
- `SemesterCatalogue` of AcademicCalendar
- `Department` and `FieldOfStudy` of [Organization](../organization/AGENTS.md)
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist |             |
| AcademicCalendar                          | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |
| Delivery                                  | open host service, published language, conformist |             |

### Downstream

| Context                                 | Relationship                                      | Exposes                                   | Integration                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Recruitment](../recruitment/AGENTS.md) | supplier, customer                                | `AdmissionApplication`, `AdmissionPeriod` | Interview assignment reads the application and its admission period                                                                                     |
| Messaging                               | supplier, customer                                | `AdmissionPeriod`                         | Admission-opening notices with subscription consent                                                                                                     |
| [Placements](../placements/AGENTS.md)   | open host service, published language, conformist | `AdmissionApplication`                    | The scheduling function reads each accepted applicant's weekday availability, bolk and school wishes from the application; Placements never writes them |
| Reporting                               | open host service, published language, conformist | `AdmissionApplication`                    |                                                                                                                                                         |

## Entry points

| Import                                  | Module               |
| --------------------------------------- | -------------------- |
| `@vektorprogrammet/database/admissions` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
