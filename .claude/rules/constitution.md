# Monoweb Project Conventions

## RPC Contract Conventions

When working on `packages/rpc/`:

- The RPC tag is the operation ID (`social-events.create`). Command receipts store it
- Payload and success are Schemas; the error is `rpcProblems(<Operation>Problem)`, a closed `problemUnion` of registry codes
- Types are inferred from the Schemas, never hand-written interfaces
- Each RPC takes at most one credential middleware (none for anonymous access) and exactly one `withAccessSpec(...)`; `packages/rpc/test/contract.test.ts` checks the AccessSpec, the tag grammar, and the defect boundary
- A contract re-exports only the schemas its own RPCs use; clients import other domain values from `@vektorprogrammet/domain`
- Every client derives from the group: `RpcClient` in Effect code, `callNative`, `callBrowserNative`, and `callHomepageNative` in the apps, and `nativeScriptClient` from `@vektorprogrammet/rpc/script` in journeys and probes. No client is generated or written by hand
- `packages/rpc/src/social-events.ts` is the precedent to copy
