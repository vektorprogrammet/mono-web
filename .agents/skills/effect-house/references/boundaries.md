# Services, HTTP boundaries, and runtime bridges

## Services return Effects (FX003)

A service that one Effect layer offers to another returns Effects with typed failures.
A Promise interface between Effect layers is the defect that slices E1 and E2 of [docs/specs/effect-diagnostics.md](../../../../docs/specs/effect-diagnostics.md) remove; the specification records how far each has come.
Precedents: `Identity`, `AuthEngineService`, `OAuthCredentialAuthority.resolve`, `PasswordRecovery`, and `ReceiptFileStore` return Effects.

A program runs only at an owned edge:

- a composition root, such as `apps/backend/src/main.ts`, a `*-main.ts` program, or a CLI;
- a runtime bridge (below);
- a named adapter that [oxlint.config.ts](../../../../oxlint.config.ts) exempts from `effect/no-premature-execution`, with the reason beside it.

Do not add a file to that exemption to silence the rule. Register an exception instead ([exceptions.md](exceptions.md)).

The raw node-postgres modules run their queries through `pgQuery`, `pgWithClient`, and `pgTransaction` in [packages/database/src/pg-pool.ts](../../../../packages/database/src/pg-pool.ts), which fail with `PgQueryError`. A module leaves that set when it moves to Effect SQL.

## Runtime bridges (FX003, FX006)

A library that calls Promise callbacks, such as Better Auth, gets a runner in the scope of the layer that owns the library.
`makeBetterAuthCallbackRunner` ([docs/constructs.md#runtime-bridge](../../../../docs/constructs.md#runtime-bridge)) forks each callback program into a fiber set of that scope. Closing the scope interrupts the callbacks that still run, and a typed failure, such as an `APIError`, rejects the promise that the library awaits.
A new library of this kind gets its own runner, tagged `@construct runtime-bridge`. Do not run a program with `Effect.runPromise` inside a callback.

## HTTP boundaries (FX004, FX005)

[packages/http-api](../../../../packages/http-api) owns the contracts; the backend derives its transport from them, and `just check-types` asserts the generated HTTP contract.

- A handler decodes its input with the contract schemas: `readJsonBody`, `decodeRequest`, and `strictOutput` ([docs/constructs.md#http-problem](../../../../docs/constructs.md#http-problem)).
- A failure is a `Problem`. `Problem.make(code)` takes only the code; `NativeProblemRegistry` in [packages/http-api/src/http-semantics.ts](../../../../packages/http-api/src/http-semantics.ts) owns its status and body. An endpoint declares its closed union with `problemUnion`.
- Each context maps its domain failures once with `problemMapper`, as `contentProblems` and `receiptProblems` do. A failure that an operation cannot produce is marked with `unreachable`.
- `ProblemBoundaryLive` is the only consumer of a Cause. A handler does not catch defects or render causes itself.
- A JSON representation is written with `jsonText`, which encodes through Schema and writes the bytes that `JSON.stringify` wrote.
- Authority, receipts, preconditions, and outbox writes follow [AGENTS.md#boundary-practices](../../../../AGENTS.md#boundary-practices).
