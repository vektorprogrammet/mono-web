[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/content

This folder holds the Content bounded context in `apps/dashboard/app/foldkit`.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

The Content context in other folders:

- [apps/backend/src/content](../../../../backend/src/content/AGENTS.md)
- [packages/database/src/content](../../../../../packages/database/src/content/AGENTS.md)
- [packages/domain/src/content](../../../../../packages/domain/src/content/AGENTS.md)

## Bounded context: Content

From [docs/model/contexts.cml](../../../../../docs/model/contexts.cml).

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

- `PrincipalAlgebra` of AccessControl
- `Profile` of [People](../profile/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| AccessControl                             | open host service, published language, conformist |             |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |

### Downstream

No downstream context.

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
