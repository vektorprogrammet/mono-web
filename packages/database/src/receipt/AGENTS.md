[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/receipt

This folder holds Economy code under another name. Expense claim persistence under its older name.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

The Economy context in other folders:

- [apps/backend/src/receipt](../../../../apps/backend/src/receipt/AGENTS.md)
- [packages/domain/src/receipt](../../../domain/src/receipt/AGENTS.md)

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
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist | Payment authority is an AccessControl grant; approval and settlement are national delegations to the economy team. Economy keeps the payment destination keyed by the payment-authority grant and implements the RelationshipFactPort for claim ownership |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| FileCustody                               | open host service, published language, conformist | Private receipt files; SQL and file storage never share a transaction                                                                                                                                                                                     |
| Delivery                                  | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| LegacySymfony                             | anticorruption layer                              | Reviewed receipts; a legacy refund becomes approval, not proof of payment                                                                                                                                                                                 |

### Downstream

No downstream context.

## Entry points

| Import                                        | Module                                 |
| --------------------------------------------- | -------------------------------------- |
| `@vektorprogrammet/database/receipt/postgres` | [postgres-index.ts](postgres-index.ts) |

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../../../docs/constructs.md) indexes them all.

- [`CursorPositioned`](../../../../docs/constructs/pagination.md#cursorpositioned) (pagination): A row with the ordering text that `receiptCursorTimestamp` selects.
- [`receiptCursorTimestamp`](../../../../docs/constructs/pagination.md#receiptcursortimestamp) (pagination): Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
- [`withoutCursorTimestamp`](../../../../docs/constructs/pagination.md#withoutcursortimestamp) (pagination): Drops the ordering text from a row before the row leaves the adapter.
- [`receiptCursorPage`](../../../../docs/constructs/pagination.md#receiptcursorpage) (pagination): Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the ordering text.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
