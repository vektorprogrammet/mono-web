[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/http-api

HTTP contracts, middleware declarations, and OpenAPI.
Package `@vektorprogrammet/http-api`.

## Entry points

| Import                                      | Module                                         |
| ------------------------------------------- | ---------------------------------------------- |
| `@vektorprogrammet/http-api`                | [src/index.ts](src/index.ts)                   |
| `@vektorprogrammet/http-api/http-semantics` | [src/http-semantics.ts](src/http-semantics.ts) |

## Constructs

The shared constructs defined here. [docs/constructs.md](../../docs/constructs.md) lists their consumers.

- [`problemUnion`](src/http-semantics.ts) (http-problem): Creates a closed endpoint-specific Problem Details union.
- [`Problem`](src/http-semantics.ts) (http-problem): One RFC 9457 failure in an Effect error channel.
- [`isProblem`](src/http-semantics.ts) (http-problem): Narrows a caught value to a `Problem`, also one that another copy of this module created.
- [`problemBody`](src/http-semantics.ts) (http-problem): The frozen RFC 9457 body: the registry entry, then code, instance, and validation.
- [`problemHeaders`](src/http-semantics.ts) (http-problem): The response headers of one problem: `no-store`, its challenge, and its retry delay.
- [`makeNativeProblem`](src/http-semantics.ts) (http-problem): Builds one safe fixed public problem value.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
