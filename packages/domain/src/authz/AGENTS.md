[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/authz

This folder holds AccessControl code under another name. The access-control interpreter under its older name.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The AccessControl context in other folders:

- [packages/database/src/authz](../../../database/src/authz/AGENTS.md)

## Bounded context: AccessControl

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Publishes the principal, scope, role, capability and decision language every context authorizes against. permit = exactly one usable principal AND (an effective role whose reach covers the resource, with its named requirements met, OR an active principal-side grant that covers it, OR an unconsumed bearer capability for exactly this resource). An OAuth client acting for a person never exceeds the person's authority and stays inside its token scope; a bot changes data only with the person's confirmation. A unit sits at one scope: an ordinary team at itself, a department board at its department, the national board at national scope. Default deny; resolved inside the committing transaction; revocation applies on the next interaction.

Responsibilities:

- Principal algebra
- Role algebra
- Capability registry
- Grants
- Capability interpreter
- Relationship fact port

Implementation: Pure interpreter in the domain package; each fact-owning context implements the fact port in its adapter

### Owns

- `PrincipalAlgebra`: Who acts, under which credential, over which scope, and with what outcome
- `CapabilityRegistry`: One registry binds each command to its capability, requirement, scope resolver and decision time
- `Grants`: Explicit, time-bound authority: global administration (system administration, with a one-time bootstrap grant at cutover), payment authority, service-principal grants and delegated rules. Receipt approval and settlement are delegations to the economy team, not grants. No role implies a grant. The global-administrator grant keeps its organisational actions for now.
- `Delegations`

### Uses but does not own

No aggregate of another context.

### Upstream

No upstream context.

### Downstream

| Context                                           | Relationship                                      | Exposes                                                           | Integration                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Organization](../organization/AGENTS.md)         | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          | In-process interpreter; Organization implements the RelationshipFactPort inside the caller's transaction: a team appointment has team reach; a board appointment reaches its board's scope with the capabilities of its position's role type; a derived Styret seat follows its team leadership |
| [People](../profile/AGENTS.md)                    | open host service, published language, conformist | `PrincipalAlgebra`                                                |                                                                                                                                                                                                                                                                                                 |
| [Schools](../schools/AGENTS.md)                   | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          | Scope resolver: school -> associated departments (all must be covered)                                                                                                                                                                                                                          |
| [Admissions](../admissions/AGENTS.md)             | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          |                                                                                                                                                                                                                                                                                                 |
| [Recruitment](../recruitment/AGENTS.md)           | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          | Recruitment implements the RelationshipFactPort for interview assignment (interviewer, co-interviewer); the named requirement recruitment.interviewer-appointment reads Organization's appointments                                                                                             |
| [Placements](../placements/AGENTS.md)             | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          | Placements implements the RelationshipFactPort for affiliation, placement and roster membership                                                                                                                                                                                                 |
| [Economy](../receipt/AGENTS.md)                   | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`, `Grants`, `Delegations` | Payment authority is an AccessControl grant; approval and settlement are national delegations to the economy team. Economy keeps the payment destination keyed by the payment-authority grant and implements the RelationshipFactPort for claim ownership                                       |
| [TeamApplications](../team-application/AGENTS.md) | open host service, published language, conformist | `PrincipalAlgebra`, `CapabilityRegistry`                          | Requirement team.member (read) and team.leader (change); global administration and board seats grant no implicit access                                                                                                                                                                         |
| [SocialEvents](../social-events/AGENTS.md)        | open host service, published language, conformist | `PrincipalAlgebra`                                                |                                                                                                                                                                                                                                                                                                 |
| [Content](../content/AGENTS.md)                   | open host service, published language, conformist | `PrincipalAlgebra`                                                |                                                                                                                                                                                                                                                                                                 |
| Mailing                                           | open host service, published language, conformist | `PrincipalAlgebra`                                                |                                                                                                                                                                                                                                                                                                 |
| Reporting                                         | open host service, published language, conformist | `PrincipalAlgebra`                                                |                                                                                                                                                                                                                                                                                                 |

### Partners

| Context                           | Relationship | Integration                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Identity](../identity/AGENTS.md) | partnership  | Identity publishes the authenticated principal and account usability; AccessControl publishes the decision language and owns the last-usable-global-administrator invariant that account disabling must respect. One transaction, one lock order (administrator set, then person). |

## Entry points

| Import                           | Module               |
| -------------------------------- | -------------------- |
| `@vektorprogrammet/domain/authz` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
