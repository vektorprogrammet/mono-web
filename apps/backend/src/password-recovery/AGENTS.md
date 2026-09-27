[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/password-recovery

This folder holds Identity code under another name. The password recovery worker.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Identity context in other folders:

- [packages/domain/src/identity](../../../../packages/domain/src/identity/AGENTS.md)

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

- `Person` of [People](../directory/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                           | Relationship                                      | Integration                                                                                    |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [People](../directory/AGENTS.md)  | open host service, published language, conformist | An Account authenticates exactly one Person; the account key is the PersonId                   |
| [Delivery](../delivery/AGENTS.md) | open host service, published language, conformist |                                                                                                |
| LegacySymfony                     | anticorruption layer                              | Account import requires accepted Person evidence; legacy aliases never become login identities |

### Downstream

| Context                                 | Relationship       | Exposes        | Integration                                                                                                                           |
| --------------------------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Recruitment](../recruitment/AGENTS.md) | supplier, customer | `AccountClaim` | An onboarding invitation carries an Identity claim capability; claiming links an account and grants neither affiliation nor placement |

### Partners

| Context       | Relationship | Integration                                                                                                                                                                                                                                                                        |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl | partnership  | Identity publishes the authenticated principal and account usability; AccessControl publishes the decision language and owns the last-usable-global-administrator invariant that account disabling must respect. One transaction, one lock order (administrator set, then person). |

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
