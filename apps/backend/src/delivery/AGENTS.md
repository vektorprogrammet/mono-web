[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/delivery

This folder holds the Delivery bounded context in `apps/backend/src`.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Delivery context in other folders:

- [apps/backend/src/mail](../mail/AGENTS.md)
- [packages/domain/src/notification](../../../../packages/domain/src/notification/AGENTS.md)

## Bounded context: Delivery

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Every command that needs external work commits one immutable envelope with its business fact. Workers claim, attempt, acknowledge or retry after commit. Retry reuses the envelope and effect identity; a provider failure never rolls back the business fact.

Responsibilities:

- Outbox envelopes
- Claims and fencing
- Retry and quarantine
- Mail port

### Owns

- `OutboxEnvelope`

### Uses but does not own

No aggregate of another context.

### Upstream

| Context      | Relationship                            | Integration                                                         |
| ------------ | --------------------------------------- | ------------------------------------------------------------------- |
| MailProvider | open host service, anticorruption layer | Provider Layer; a provider failure never rolls back a business fact |

### Downstream

| Context                                           | Relationship                                      | Exposes          | Integration                                                                                        |
| ------------------------------------------------- | ------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| [Identity](../password-recovery/AGENTS.md)        | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Admissions](../admission/AGENTS.md)              | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Recruitment](../recruitment/AGENTS.md)           | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Placements](../placements/AGENTS.md)             | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Economy](../receipt/AGENTS.md)                   | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [TeamApplications](../team-application/AGENTS.md) | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| Messaging                                         | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Contact](../contact/AGENTS.md)                   | open host service, published language, conformist | `OutboxEnvelope` | Contact relays a transient message; the quota commits first and delivery uses the shared Mail port |

## Entry points

| Import                                    | Module             |
| ----------------------------------------- | ------------------ |
| `@vektorprogrammet/backend/delivery/http` | [http.ts](http.ts) |

## Constructs

The shared constructs defined here. [docs/constructs.md](../../../../docs/constructs.md) lists their consumers.

- [`deliverJson`](http.ts) (delivery): Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
