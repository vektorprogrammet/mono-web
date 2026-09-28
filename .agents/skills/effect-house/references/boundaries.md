# Services, RPC boundaries, and runtime bridges

## Services return Effects (FX003)

A service that one Effect layer offers to another returns Effects with typed failures.
A Promise interface between Effect layers is a defect; in core Effect code, `effecttsgo/async-function` and `effecttsgo/new-promise` reject one.
Precedents: `Identity`, `AuthEngineService`, `OAuthCredentialAuthority.resolve`, `PasswordRecovery`, and `ReceiptFileStore` return Effects.

A program runs only at an owned edge:

- a composition root, such as `apps/backend/src/main.ts`, a `*-main.ts` program, or a CLI;
- a runtime bridge (below).

In libraries, services, and adapters, `effect/no-premature-execution` rejects a program, and no override of [oxlint.config.ts](../../../../oxlint.config.ts) exempts a file from it. A site that cannot follow the rule registers an exception ([exceptions.md](exceptions.md)).

The raw node-postgres modules run their queries through `pgQuery`, `pgWithClient`, and `pgTransaction` in [packages/database/src/pg-pool.ts](../../../../packages/database/src/pg-pool.ts), which fail with `PgQueryError`. A module leaves that set when it moves to Effect SQL.

## Runtime bridges (FX003, FX006)

A library that calls Promise callbacks, such as Better Auth, gets a runner in the scope of the layer that owns the library.
The pattern to copy is `makeBetterAuthCallbackRunner` in [packages/database/src/auth-engine.ts](../../../../packages/database/src/auth-engine.ts): it forks each callback program into a fiber set of that scope. Closing the scope interrupts the callbacks that still run, and a typed failure, such as an `APIError`, rejects the promise that the library awaits.
A new library of this kind gets its own runner, built the same way in the layer that owns the library. Do not run a program with `Effect.runPromise` inside a callback.
The runner is no tagged construct while it is the only one, because a construct needs two consumers outside its own module. The second runner makes it one: move the logic that both share into one runner, tag it `@construct runtime-bridge`, and declare that category again in [tools/conventions/src/constructs.ts](../../../../tools/conventions/src/constructs.ts).

## RPC boundaries (FX004, FX005)

[packages/rpc](../../../../packages/rpc) owns the contract ([docs/architecture.md](../../../../docs/architecture.md#rpc-contract-and-ingress)); the backend implements each context's group, and every client derives from the same group. Nothing is generated.

- The RPC server decodes a payload with the contract schema before the handler runs. A handler decodes its success value with `strictOutput` ([docs/constructs/rpc-problem.md](../../../../docs/constructs/rpc-problem.md)).
- A failure is a `Problem`. `Problem.make(code)` takes only the code; `NativeProblemRegistry` in [packages/rpc/src/problem.ts](../../../../packages/rpc/src/problem.ts) owns its status and body. An RPC declares its closed union with `problemUnion` and takes it as `error: rpcProblems(...)`.
- Each context maps its domain failures once with `problemMapper`, as `contentProblems` and `receiptProblems` do, and declares the mapper's type as `ProblemMapper<Failure, Cases>`, where `Cases` is the type of its cases. A failure that an operation cannot produce is marked with `unreachable`.
- `ProblemBoundaryLive` is the only consumer of a Cause. A handler does not catch defects or render causes itself.
- A JSON representation is written with `jsonText`, which encodes through Schema and writes the bytes that `JSON.stringify` wrote.
- Authority, receipts, preconditions, and outbox writes follow [AGENTS.md#boundary-practices](../../../../AGENTS.md#boundary-practices).
