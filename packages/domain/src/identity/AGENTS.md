[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/identity

This folder holds the Identity bounded context in `packages/domain/src`.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The Identity context in other folders:

- [apps/backend/src/password-recovery](../../../../apps/backend/src/password-recovery/AGENTS.md)

## Bounded context: Identity

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Authenticates people and machines. An Account authenticates exactly one Person; credentials, sessions, recovery and claim capabilities belong to the account lifecycle. A service caller is a separate principal, never a synthetic Person.

Responsibilities:

- Accounts
- Credentials
- Sessions
- Password recovery
- Account claim capability
- Machine credentials
- Security audit

Implementation: Better Auth behind an anti-corruption adapter; the auth schema is written and read by this context only

### Owns

- `Account`
- `Session`
- `PasswordRecovery`
- `AccountClaim`
- `MachineCredential`
- `SecurityAudit`

### Uses but does not own

- `Person` of [People](../profile/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../notification/AGENTS.md)

### Upstream

| Context                               | Relationship                                      | Integration                                                                                    |
| ------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [People](../profile/AGENTS.md)        | open host service, published language, conformist | An Account authenticates exactly one Person; the account key is the PersonId                   |
| [Delivery](../notification/AGENTS.md) | open host service, published language, conformist |                                                                                                |
| LegacySymfony                         | anticorruption layer                              | Account import requires accepted Person evidence; legacy aliases never become login identities |

### Downstream

| Context                                 | Relationship       | Exposes        | Integration                                                                                                                           |
| --------------------------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Recruitment](../recruitment/AGENTS.md) | supplier, customer | `AccountClaim` | An onboarding invitation carries an Identity claim capability; claiming links an account and grants neither affiliation nor placement |

### Partners

| Context                             | Relationship | Integration                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md) | partnership  | Identity publishes the authenticated principal and account usability; AccessControl publishes the decision language and owns the last-usable-global-administrator invariant that account disabling must respect. One transaction, one lock order (administrator set, then person). |

## Entry points

| Import                              | Module               |
| ----------------------------------- | -------------------- |
| `@vektorprogrammet/domain/identity` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
