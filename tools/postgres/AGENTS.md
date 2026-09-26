[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# tools/postgres

Disposable PostgreSQL clusters of the selected major.
Package `@monoweb/postgres`.

## Entry points

| Import              | Module               |
| ------------------- | -------------------- |
| `@monoweb/postgres` | [index.ts](index.ts) |

## Constructs

The shared constructs defined here. [docs/constructs.md](../../docs/constructs.md) lists their consumers.

- [`selectedPostgresMajor`](index.ts) (test-harness): The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.
- [`postgresProgram`](index.ts) (test-harness): Absolute path of a client program of the selected PostgreSQL major.
- [`postgresVersion`](index.ts) (test-harness): The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.
- [`loopbackPortFree`](index.ts) (test-harness): Whether a listener can bind `port` on loopback now.
- [`reserveLoopbackPorts`](index.ts) (test-harness): Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.
- [`startDisposablePostgres`](index.ts) (test-harness): Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.
- [`withDisposablePostgres`](index.ts) (test-harness): Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres` starts, and removes the cluster when `use` settles, also when it fails.
- [`startDisposablePgBouncer`](index.ts) (test-harness): Starts PgBouncer on a private loopback port in front of `upstream`, with trust authentication and every database of the cluster, in transaction pool mode unless `options` names another.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Invariants

- `startDisposablePostgres` is the only starter of a cluster. `PostgresProgram` holds only client programs, and `anti-slop/no-hand-rolled-postgres` rejects `initdb`, `postgres`, `pg_ctl`, and `createdb` elsewhere, also in `.mjs` runners.
- Ready means that `pg_isready` reports that the server accepts connections. An open port is not ready: a starting server answers on its port and rejects sessions with "the database system is starting up" (CI run 36224459581). `readiness.test.ts` holds this contract against a protocol endpoint that accepts TCP and rejects sessions.
- The owner process holds the standard input of a sentinel shell. When the owner exits without `stop`, the sentinel stops the server and removes the cluster directory. Bun exits on an uncaught failure without an `exit` event, and SIGKILL runs no handler, so an in-process hook cannot do this.
- The sentinel runs in its own session and ignores HUP, INT, QUIT, and TERM. A bash tool timeout and `hub stop` send SIGTERM to every descendant of the command, also in other sessions, and then SIGKILL to its process group; `just measure` forwards SIGINT and SIGTERM to its command. `teardown.test.ts` ends a real owner in each of these ways, by an uncaught failure, and by SIGKILL of the owner and of its process group, and asserts that no directory, server, listener, or sentinel remains.
- A cluster strips the `PG*` variables of `devenv shell` from its programs and passes the port explicitly. A client that derives its connection from the server, such as `current_setting('unix_socket_directories')`, also reads `current_setting('port')`.
