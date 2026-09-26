[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/team-application

This folder holds TeamApplications code under another name. Team applications under the singular folder name.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

The TeamApplications context in other folders:

- [apps/backend/src/team-application](../../../../apps/backend/src/team-application/AGENTS.md)
- [apps/dashboard/app/foldkit/team-applications](../../../../apps/dashboard/app/foldkit/team-applications/AGENTS.md)
- [packages/domain/src/team-application](../../../domain/src/team-application/AGENTS.md)

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

- `PrincipalAlgebra` and `CapabilityRegistry` of [AccessControl](../authz/AGENTS.md)
- `Team` and `Department` of [Organization](../organization/AGENTS.md)
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                                | Integration                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist           | Requirement team.member (read) and team.leader (change); global administration and board seats grant no implicit access                                                      |
| [Organization](../organization/AGENTS.md) | open host service, published language, anticorruption layer | Team and department activity plus mailbox, translated into TeamIntakeFacts; the intake itself is TeamApplications' own, and TeamApplications never writes Organization state |
| Delivery                                  | open host service, published language, conformist           |                                                                                                                                                                              |
| LegacySymfony                             | anticorruption layer                                        | Applications open at cutover                                                                                                                                                 |

### Downstream

No downstream context.

## Entry points

| Import                                        | Module               |
| --------------------------------------------- | -------------------- |
| `@vektorprogrammet/database/team-application` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
