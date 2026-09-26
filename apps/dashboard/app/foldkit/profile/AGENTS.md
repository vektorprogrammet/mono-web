[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/profile

This folder holds People code under another name. Profile self-service under its older name.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

The People context in other folders:

- [apps/backend/src/directory](../../../../backend/src/directory/AGENTS.md)
- [apps/backend/src/profile](../../../../backend/src/profile/AGENTS.md)
- [packages/database/src/profile](../../../../../packages/database/src/profile/AGENTS.md)
- [packages/domain/src/profile](../../../../../packages/domain/src/profile/AGENTS.md)

## Bounded context: People

From [docs/model/contexts.cml](../../../../../docs/model/contexts.cml).

Owns the stable human identity and its contact profile. Legacy data must resolve to a Person through explicit mapping and identity evidence before credentials, affiliations, placements or history can reference it.

Responsibilities:

- Person
- Profile
- Person reconciliation

### Owns

- `Person`
- `Profile`
- `PersonReconciliation`

### Uses but does not own

- `PrincipalAlgebra` of AccessControl

### Upstream

| Context       | Relationship                                      | Integration                                                                                 |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| AccessControl | open host service, published language, conformist |                                                                                             |
| LegacySymfony | anticorruption layer                              | Explicit source-to-Person mapping with identity evidence; quarantine without partial writes |

### Downstream

| Context                                         | Relationship                                                | Exposes             | Integration                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Identity                                        | open host service, published language, conformist           | `Person`            | An Account authenticates exactly one Person; the account key is the PersonId                                                  |
| [Organization](../organization/AGENTS.md)       | open host service, published language, conformist           | `Person`            |                                                                                                                               |
| [Recruitment](../recruitment/AGENTS.md)         | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |
| [Placements](../dated-school-service/AGENTS.md) | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |
| Economy                                         | open host service, published language, conformist           | `Person`            |                                                                                                                               |
| [Content](../content/AGENTS.md)                 | open host service, published language, conformist           | `Profile`           |                                                                                                                               |
| Mailing                                         | open host service, published language, anticorruption layer | `Profile`           | Contact profile -> copyable recipient address; a missing contact is absent, an infrastructure failure is not an empty success |
| Reporting                                       | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
