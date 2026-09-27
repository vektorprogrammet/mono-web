[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/content

This folder holds the Content bounded context in `packages/domain/src`.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

The Content context in other folders:

- [apps/backend/src/content](../../../../apps/backend/src/content/AGENTS.md)
- [apps/dashboard/app/foldkit/content](../../../../apps/dashboard/app/foldkit/content/AGENTS.md)
- [packages/database/src/content](../../../database/src/content/AGENTS.md)

## Bounded context: Content

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Public articles with drafts and published versions, public page text and sponsor presentation. Bodies are sanitized; slugs are unique.

Responsibilities:

- Articles
- Page text
- Sponsors

### Owns

- `Article`
- `PageText`
- `SponsorPresentation`

### Uses but does not own

- `PrincipalAlgebra` of [AccessControl](../authz/AGENTS.md)
- `Profile` of [People](../profile/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist |             |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |

### Downstream

No downstream context.

## Entry points

| Import                             | Module               |
| ---------------------------------- | -------------------- |
| `@vektorprogrammet/domain/content` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
