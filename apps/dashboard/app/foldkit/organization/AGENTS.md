[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/organization

This folder holds the Organization bounded context in `apps/dashboard/app/foldkit`.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

The Organization context in other folders:

- [apps/backend/src/organization](../../../../backend/src/organization/AGENTS.md)
- [packages/database/src/organization](../../../../../packages/database/src/organization/AGENTS.md)
- [packages/domain/src/organization](../../../../../packages/domain/src/organization/AGENTS.md)

## Bounded context: Organization

From [docs/model/contexts.cml](../../../../../docs/model/contexts.cml).

Local departments, teams with a home department and a scope, department boards (Styret), the national board (Hovedstyret), positions and effective-dated appointments. Units are scopes, never holders: an ordinary team sits at its own scope, a department board at its department, the national board at national scope. Appointments are relationship facts that AccessControl reads. A position is an informal title that its unit defines; it maps to exactly one role type, and authority comes only from the role type, with the unit's reach. A title is never authority. Styret holds its own positions plus one derived seat for every leader of a local team with its home in the department; Hovedstyret holds its own positions plus one derived seat for every leader of a national team. A department governs itself only while Hovedstyret recognises it as independent; a department that is not independent, and a team without a board, fall under Hovedstyret. Members are students with a role; membership lapses after three semesters without one. A Hovedstyret seat does not make a person a global administrator. An ordinary team leader acts within the team. A functional team is an ordinary team; its department or national work comes only from delegations.

Responsibilities:

- Departments
- Department independence
- Teams
- Department boards
- National board
- Positions
- Appointments
- Joining agreements
- Membership
- Fields of study
- Team interest

### Owns

- `Department`
- `Team`
- `NationalBoard`
- `Position`
- `Appointment`
- `JoiningAgreement`
- `GrantedMembership`
- `FieldOfStudy`
- `TeamInterest`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of AccessControl
- `Person` of [People](../profile/AGENTS.md)

### Upstream

| Context                        | Relationship                                                | Integration                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                  | open host service, published language, conformist           | In-process interpreter; Organization implements the RelationshipFactPort inside the caller's transaction: a team appointment has team reach; a board appointment reaches its board's scope with the capabilities of its position's role type; a derived Styret seat follows its team leadership |
| [People](../profile/AGENTS.md) | open host service, published language, conformist           |                                                                                                                                                                                                                                                                                                 |
| HkDirCatalogue                 | open host service, published language, anticorruption layer | Candidate source for fields of study; not selected                                                                                                                                                                                                                                              |
| LegacySymfony                  | anticorruption layer                                        | Reviewed cohort; historical membership never becomes current authority by inference                                                                                                                                                                                                             |

### Downstream

| Context                                            | Relationship                                                | Exposes                             | Integration                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TeamApplications](../team-applications/AGENTS.md) | open host service, published language, anticorruption layer | `Team`, `Department`                | Team and department activity plus mailbox, translated into TeamIntakeFacts; the intake itself is TeamApplications' own, and TeamApplications never writes Organization state |
| [Schools](../schools/AGENTS.md)                    | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| Admissions                                         | open host service, published language, conformist           | `Department`, `FieldOfStudy`        |                                                                                                                                                                              |
| [Recruitment](../recruitment/AGENTS.md)            | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| [Placements](../dated-school-service/AGENTS.md)    | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| Economy                                            | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| [SocialEvents](../social-events/AGENTS.md)         | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| [Content](../content/AGENTS.md)                    | open host service, published language, conformist           | `Department`                        |                                                                                                                                                                              |
| Contact                                            | open host service, published language, conformist           | `Department`                        | Department mailbox and activity                                                                                                                                              |
| Mailing                                            | open host service, published language, conformist           | `Appointment`                       | Nonsuspended appointments overlapping a semester (touching a boundary does not qualify)                                                                                      |
| Reporting                                          | open host service, published language, conformist           | `Department`, `Team`, `Appointment` | Active members per department, from current appointments; the General Assembly vote-weight report reads them                                                                 |

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
