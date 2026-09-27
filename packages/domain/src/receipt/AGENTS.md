[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/receipt

This folder holds Economy code under another name. Expense claims under their older name.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.
The human guide is [README.md](README.md).

The Economy context in other folders:

- [apps/backend/src/receipt](../../../../apps/backend/src/receipt/AGENTS.md)
- [packages/database/src/receipt](../../../database/src/receipt/AGENTS.md)

## Bounded context: Economy

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Expense claims with private receipt files, approval, rejection and reopening, from assistants (travel to school) and team members (social events). Every member of the national economy team approves or rejects claims through a national delegation. Only its leader, the finance lead, pays out and records immutable settlement evidence, through a leaders-only delegation. Claim state, file custody, payment destinations, approval authority, settlement authority, delivery attempts and settlement history are separate facts.

Responsibilities:

- Expense claims
- Payment destinations
- Settlement evidence

### Owns

- `ExpenseClaim`
- `PaymentDestination`
- `Settlement`

### Uses but does not own

- `PrincipalAlgebra`, `CapabilityRegistry`, `Grants`, and `Delegations` of [AccessControl](../authz/AGENTS.md)
- `Person` of [People](../profile/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)
- `PrivateFile` of FileCustody
- `OutboxEnvelope` of [Delivery](../notification/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist | Payment authority is an AccessControl grant; approval and settlement are national delegations to the economy team. Economy keeps the payment destination keyed by the payment-authority grant and implements the RelationshipFactPort for claim ownership |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| FileCustody                               | open host service, published language, conformist | Private receipt files; SQL and file storage never share a transaction                                                                                                                                                                                     |
| [Delivery](../notification/AGENTS.md)     | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| LegacySymfony                             | anticorruption layer                              | Reviewed receipts; a legacy refund becomes approval, not proof of payment                                                                                                                                                                                 |

### Downstream

No downstream context.

## Entry points

| Import                             | Module               |
| ---------------------------------- | -------------------- |
| `@vektorprogrammet/domain/receipt` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
