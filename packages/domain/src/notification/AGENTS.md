[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/notification

This folder holds Delivery code under another name. The mail notification port that Delivery owns.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The Delivery context in other folders:

- [apps/backend/src/delivery](../../../../apps/backend/src/delivery/AGENTS.md)
- [apps/backend/src/mail](../../../../apps/backend/src/mail/AGENTS.md)

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
| [Identity](../identity/AGENTS.md)                 | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Admissions](../admissions/AGENTS.md)             | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Recruitment](../recruitment/AGENTS.md)           | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Placements](../placements/AGENTS.md)             | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Economy](../receipt/AGENTS.md)                   | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [TeamApplications](../team-application/AGENTS.md) | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| Messaging                                         | open host service, published language, conformist | `OutboxEnvelope` |                                                                                                    |
| [Contact](../contact/AGENTS.md)                   | open host service, published language, conformist | `OutboxEnvelope` | Contact relays a transient message; the quota commits first and delivery uses the shared Mail port |

## Entry points

| Import                                  | Module               |
| --------------------------------------- | -------------------- |
| `@vektorprogrammet/domain/notification` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
