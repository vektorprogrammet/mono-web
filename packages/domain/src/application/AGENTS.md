[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/application

This folder holds Admissions code under another name. Applications, apart from admission periods.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The Admissions context in other folders:

- [apps/backend/src/admission](../../../../apps/backend/src/admission/AGENTS.md)
- [apps/backend/src/application](../../../../apps/backend/src/application/AGENTS.md)
- [packages/database/src/admission-period](../../../database/src/admission-period/AGENTS.md)
- [packages/database/src/admissions](../../../database/src/admissions/AGENTS.md)
- [packages/database/src/application](../../../database/src/application/AGENTS.md)
- [packages/domain/src/admission-period](../admission-period/AGENTS.md)
- [packages/domain/src/admissions](../admissions/AGENTS.md)

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
- `OutboxEnvelope` of [Delivery](../notification/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist |             |
| AcademicCalendar                          | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |
| [Delivery](../notification/AGENTS.md)     | open host service, published language, conformist |             |

### Downstream

| Context                                 | Relationship                                      | Exposes                                   | Integration                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Recruitment](../recruitment/AGENTS.md) | supplier, customer                                | `AdmissionApplication`, `AdmissionPeriod` | Interview assignment reads the application and its admission period                                                                                     |
| Messaging                               | supplier, customer                                | `AdmissionPeriod`                         | Admission-opening notices with subscription consent                                                                                                     |
| [Placements](../placements/AGENTS.md)   | open host service, published language, conformist | `AdmissionApplication`                    | The scheduling function reads each accepted applicant's weekday availability, bolk and school wishes from the application; Placements never writes them |
| Reporting                               | open host service, published language, conformist | `AdmissionApplication`                    |                                                                                                                                                         |

## Entry points

| Import                                 | Module               |
| -------------------------------------- | -------------------- |
| `@vektorprogrammet/domain/application` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
