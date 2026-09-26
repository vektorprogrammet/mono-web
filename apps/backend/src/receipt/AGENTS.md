[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/receipt

This folder holds Economy code under another name. Expense claim HTTP handlers and private files.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Economy context in other folders:

- [packages/database/src/receipt](../../../../packages/database/src/receipt/AGENTS.md)
- [packages/domain/src/receipt](../../../../packages/domain/src/receipt/AGENTS.md)

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

- `PrincipalAlgebra`, `CapabilityRegistry`, `Grants`, and `Delegations` of AccessControl
- `Person` of [People](../directory/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)
- `PrivateFile` of FileCustody
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                             | open host service, published language, conformist | Payment authority is an AccessControl grant; approval and settlement are national delegations to the economy team. Economy keeps the payment destination keyed by the payment-authority grant and implements the RelationshipFactPort for claim ownership |
| [People](../directory/AGENTS.md)          | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| FileCustody                               | open host service, published language, conformist | Private receipt files; SQL and file storage never share a transaction                                                                                                                                                                                     |
| [Delivery](../delivery/AGENTS.md)         | open host service, published language, conformist |                                                                                                                                                                                                                                                           |
| LegacySymfony                             | anticorruption layer                              | Reviewed receipts; a legacy refund becomes approval, not proof of payment                                                                                                                                                                                 |

### Downstream

No downstream context.

## Entry points

| Import                                              | Module                                   |
| --------------------------------------------------- | ---------------------------------------- |
| `@vektorprogrammet/backend/receipt/delivery`        | [delivery.ts](delivery.ts)               |
| `@vektorprogrammet/backend/receipt/filesystem`      | [filesystem.ts](filesystem.ts)           |
| `@vektorprogrammet/backend/receipt/import-snapshot` | [import-snapshot.ts](import-snapshot.ts) |
| `@vektorprogrammet/backend/receipt/payment-account` | [payment-account.ts](payment-account.ts) |
| `@vektorprogrammet/backend/receipt/reviewed-import` | [reviewed-import.ts](reviewed-import.ts) |

## Constructs

The shared constructs defined here. [docs/constructs.md](../../../../docs/constructs.md) lists their consumers.

- [`ReceiptE2EBarrierArrival`](e2e-support.ts) (test-harness): `false` for unprobed requests; `true` once all three lanes are synchronized.
- [`receiptProblems`](http-problem.ts) (http-problem): The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.
- [`storedReceiptProblems`](http-problem.ts) (http-problem): A stored receipt value a read cannot decode is the receipt store failing, not the request.
- [`receiptCredentialProblems`](http-problem.ts) (http-problem): A credential rejected inside a receipt handler is answered from the request's own evidence.
- [`jsonResponse`](http-representation.ts) (http-transport): A JSON body under the receipt cache policy the caller names.
- [`privateJsonResponse`](http-representation.ts) (http-transport): A JSON body private to the caller, varying by Origin.
- [`projected`](http-representation.ts) (http-problem): Projects stored rows onto response items.
- [`receiptMutationCapsule`](http-representation.ts) (http-transport): The replayable response of one receipt mutation.
- [`readPrivateReceiptFile`](http-representation.ts) (http-transport): Answers verified private bytes with their exact headers; unreadable bytes are the receipt store failing.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
