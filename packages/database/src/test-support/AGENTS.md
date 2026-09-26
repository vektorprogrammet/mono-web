[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/test-support

This folder is not a bounded context. Disposable PostgreSQL fixtures and statement observers for tests and proofs.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

## Entry points

| Import                                                     | Module                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `@vektorprogrammet/database/test-support/observe-postgres` | [observe-postgres.ts](observe-postgres.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
