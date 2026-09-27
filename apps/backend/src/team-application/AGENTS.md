[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/team-application

This folder holds TeamApplications code under another name. Team applications under the singular folder name.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The TeamApplications context in other folders:

- [apps/dashboard/app/foldkit/team-applications](../../../dashboard/app/foldkit/team-applications/AGENTS.md)
- [packages/database/src/team-application](../../../../packages/database/src/team-application/AGENTS.md)
- [packages/domain/src/team-application](../../../../packages/domain/src/team-application/AGENTS.md)

## Bounded context: TeamApplications

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

A visitor applies to one team. Team members read the team's applications; the current team leader changes intake and deletes applications. Global administration grants no implicit access. No review outcome, hiring state or appointment.

Responsibilities:

- Team applications
- Team intake

### Owns

- `TeamApplication`
- `TeamIntake`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of AccessControl
- `Team` and `Department` of [Organization](../organization/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                                   | Relationship                                                | Integration                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                             | open host service, published language, conformist           | Requirement team.member (read) and team.leader (change); global administration and board seats grant no implicit access                                                      |
| [Organization](../organization/AGENTS.md) | open host service, published language, anticorruption layer | Team and department activity plus mailbox, translated into TeamIntakeFacts; the intake itself is TeamApplications' own, and TeamApplications never writes Organization state |
| [Delivery](../delivery/AGENTS.md)         | open host service, published language, conformist           |                                                                                                                                                                              |
| LegacySymfony                             | anticorruption layer                                        | Applications open at cutover                                                                                                                                                 |

### Downstream

No downstream context.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
