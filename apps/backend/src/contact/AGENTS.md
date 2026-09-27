[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/contact

This folder holds the Contact bounded context in `apps/backend/src`.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Contact context in other folders:

- [packages/database/src/contact](../../../../packages/database/src/contact/AGENTS.md)
- [packages/domain/src/contact](../../../../packages/domain/src/contact/AGENTS.md)

## Bounded context: Contact

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Relays a visitor's contact message to an active department mailbox. The message is transient; only the quota is durable. Submission is anonymous and rate limited per visitor address. The homepage server authenticates to the backend with a deployment secret; that secret names no principal.

Responsibilities:

- Contact quota
- Contact relay

### Owns

- `ContactQuota`

### Uses but does not own

- `Department` of [Organization](../organization/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                        |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist | Department mailbox and activity                                                                    |
| [Delivery](../delivery/AGENTS.md)         | open host service, published language, conformist | Contact relays a transient message; the quota commits first and delivery uses the shared Mail port |

### Downstream

No downstream context.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
