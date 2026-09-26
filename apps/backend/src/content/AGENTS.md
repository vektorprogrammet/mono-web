[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/content

This folder holds the Content bounded context in `apps/backend/src`.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Content context in other folders:

- [apps/dashboard/app/foldkit/content](../../../dashboard/app/foldkit/content/AGENTS.md)
- [packages/database/src/content](../../../../packages/database/src/content/AGENTS.md)
- [packages/domain/src/content](../../../../packages/domain/src/content/AGENTS.md)

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

- `PrincipalAlgebra` of AccessControl
- `Profile` of [People](../directory/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)

### Upstream

| Context                                   | Relationship                                      | Integration |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| AccessControl                             | open host service, published language, conformist |             |
| [People](../directory/AGENTS.md)          | open host service, published language, conformist |             |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |             |

### Downstream

No downstream context.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

## Constructs

The shared constructs defined here. [docs/constructs.md](../../../../docs/constructs.md) lists their consumers.

- [`authorizeContentOperation`](http-access.ts) (http-problem): Evaluates a content endpoint's AccessSpec for one person with the content grant scope.
- [`authorizedActor`](http-context.ts) (http-problem): Resolves the staff person of a snapshot read and its content actor at the person's authorization instant.
- [`authorizedActorInTransaction`](http-context.ts) (http-problem): Resolves the staff person of a command, its credential, and its content actor inside the command's transaction.
- [`departmentQuery`](http-decode.ts) (http-problem): A workspace or news listing accepts at most one department filter and no other parameter.
- [`versionFromQuery`](http-decode.ts) (http-problem): A news article read accepts at most one positive published version and no other parameter.
- [`contentProblems`](http-problem.ts) (http-problem): The one answer for every content domain failure.
- [`contentActorProblems`](http-problem.ts) (http-problem): A staff person rejected after ingress is answered from the credential the request presented.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
