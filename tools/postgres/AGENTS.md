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
- [`postgresProgram`](index.ts) (test-harness): Absolute path of a program of the selected PostgreSQL major.
- [`postgresComposeFile`](index.ts) (test-harness): Compose file of the disposable `receipt-postgres` container.
- [`postgresComposeEnvironment`](index.ts) (test-harness): Adds the selected major to the environment of a Compose command.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
