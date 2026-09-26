[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/contact

This folder holds the Contact bounded context in `packages/database/src`.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

The Contact context in other folders:

- [apps/backend/src/contact](../../../../apps/backend/src/contact/AGENTS.md)
- [packages/domain/src/contact](../../../domain/src/contact/AGENTS.md)

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
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                        |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist | Department mailbox and activity                                                                    |
| Delivery                                  | open host service, published language, conformist | Contact relays a transient message; the quota commits first and delivery uses the shared Mail port |

### Downstream

No downstream context.

## Entry points

| Import                               | Module               |
| ------------------------------------ | -------------------- |
| `@vektorprogrammet/database/contact` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
