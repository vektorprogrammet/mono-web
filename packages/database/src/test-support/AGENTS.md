[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/test-support

This folder is not a bounded context. Disposable PostgreSQL fixtures and statement observers for tests and proofs.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

## Entry points

| Import                                                     | Module                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `@vektorprogrammet/database/test-support/observe-postgres` | [observe-postgres.ts](observe-postgres.ts) |
| `@vektorprogrammet/database/test-support/platform`         | [platform.ts](platform.ts)                 |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Which database harness a test takes

- `withPostgresTestDatabase` runs on PGlite behind a socket server, with the native client and the selected migrations. It is fast and takes migration selections for upgrade proofs.
- `withRealPostgres` runs on a private PostgreSQL cluster of the selected major through `DatabaseLive`. A test takes it when the server rejects a statement that the client sees: a constraint violation, a trigger exception, a failed statement inside a transaction that rolls back, or any other `SqlError` from the server.
- The PGlite socket cannot carry that: its message-by-message bridge sends the native client a second `ReadyForQuery` after an `ErrorResponse`, and the connection ends with "Unexpected ReadyForQuery during parse". `pgliteSocketDatabase` watches the server frames, and `refusingRejectedStatements` ends the test with a `PgliteSocketRejectedStatement` defect, so a failure path declared on the wrong harness fails the same way at once. A rejection that a plpgsql block catches inside the server never reaches the client and stays valid on PGlite. A domain failure or an interruption that rolls back a healthy transaction also stays valid.
- A test that opens its own PGlite socket takes `pgliteSocketDatabase`, never `PGLiteSocketServer` directly.
