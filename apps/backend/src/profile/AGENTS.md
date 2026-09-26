[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/profile

This folder holds People code under another name. Profile HTTP handlers under their older name.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The People context in other folders:

- [apps/backend/src/directory](../directory/AGENTS.md)
- [apps/dashboard/app/foldkit/profile](../../../dashboard/app/foldkit/profile/AGENTS.md)
- [packages/database/src/profile](../../../../packages/database/src/profile/AGENTS.md)
- [packages/domain/src/profile](../../../../packages/domain/src/profile/AGENTS.md)

## Bounded context: People

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

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

| Context                                    | Relationship                                                | Exposes             | Integration                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Identity](../password-recovery/AGENTS.md) | open host service, published language, conformist           | `Person`            | An Account authenticates exactly one Person; the account key is the PersonId                                                  |
| [Organization](../organization/AGENTS.md)  | open host service, published language, conformist           | `Person`            |                                                                                                                               |
| [Recruitment](../recruitment/AGENTS.md)    | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |
| [Placements](../placements/AGENTS.md)      | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |
| [Economy](../receipt/AGENTS.md)            | open host service, published language, conformist           | `Person`            |                                                                                                                               |
| [Content](../content/AGENTS.md)            | open host service, published language, conformist           | `Profile`           |                                                                                                                               |
| Mailing                                    | open host service, published language, anticorruption layer | `Profile`           | Contact profile -> copyable recipient address; a missing contact is absent, an infrastructure failure is not an empty success |
| Reporting                                  | open host service, published language, conformist           | `Person`, `Profile` |                                                                                                                               |

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
