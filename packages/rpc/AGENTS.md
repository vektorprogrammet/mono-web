[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/rpc

The native RPC contract, its credential middlewares, problems, and client.
Package `@vektorprogrammet/rpc`.

## Entry points

| Import                          | Module                                       |
| ------------------------------- | -------------------------------------------- |
| `@vektorprogrammet/rpc`         | [src/index.ts](src/index.ts)                 |
| `@vektorprogrammet/rpc/problem` | [src/problem.ts](src/problem.ts)             |
| `@vektorprogrammet/rpc/client`  | [src/client.ts](src/client.ts)               |
| `@vektorprogrammet/rpc/script`  | [src/script-client.ts](src/script-client.ts) |

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../docs/constructs.md) indexes them all.

- [`isNativeRpcPath`](../../docs/constructs/rpc-transport.md#isnativerpcpath) (rpc-transport): Whether a request path addresses the native RPC endpoint.
- [`problemUnion`](../../docs/constructs/rpc-problem.md#problemunion) (rpc-problem): Creates the closed Problem Details union of one RPC.
- [`Problem`](../../docs/constructs/rpc-problem.md#problem) (rpc-problem): One RFC 9457 failure in an Effect error channel.
- [`isProblem`](../../docs/constructs/rpc-problem.md#isproblem) (rpc-problem): Narrows a caught value to a `Problem`, also one that another copy of this module created.
- [`problemBody`](../../docs/constructs/rpc-problem.md#problembody) (rpc-problem): The frozen RFC 9457 body: the registry entry, then code, instance, and validation.
- [`makeNativeProblem`](../../docs/constructs/rpc-problem.md#makenativeproblem) (rpc-problem): Builds one safe fixed public problem value.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
