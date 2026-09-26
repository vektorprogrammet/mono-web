# Composition roots, platform layers, and tests

## Composition roots select the platform (FX003)

A composition root builds the layers of one program and selects its runtime platform.
The backend entry point [apps/backend/src/main.ts](../../../../apps/backend/src/main.ts) merges `BunServices.layer` with `FetchHttpClient.layer` into one `platformLayer` and provides it to the layers that it builds.
The other roots do the same: the `*-main.ts` programs, the database CLIs (`packages/database/src/**/*-cli.ts`), and the tools mains.

Packages and adapters stay portable.
They require the platform services that they use, such as `FileSystem`, `Path`, and `HttpClient`, and they never import a platform package.
Precedents: `DomainFileSystem` in [packages/domain/src/runtime-services.ts](../../../../packages/domain/src/runtime-services.ts), and `makeReceiptFileStore` in [apps/backend/src/receipt/filesystem.ts](../../../../apps/backend/src/receipt/filesystem.ts).
A service resolves the platform services when its layer is built, not in each operation.

[oxlint.config.ts](../../../../oxlint.config.ts) declares the role and platform of each file group: `effect-library`, `runtime-adapter`, `composition-root`, or `test`, on `node`, `bun`, `browser`, or `portable`.
`effect/no-cross-runtime` rejects a platform import outside a composition root or an adapter that declares that platform.
A new root joins its group in `oxlint.config.ts`. Do not suppress the rule to add one.

## Tests are Effect programs (FX015)

- Write each test as one Effect program with `@effect/vitest`: `it.effect` for code under the test services, such as the test clock, and `it.live` for code that reads the real clock or real infrastructure. The API is in the installed `@effect/vitest` package and [node_modules/effect/ai-docs/src/09_testing](../../../../node_modules/effect/ai-docs/src/09_testing).
- Build suite resources as layers: `layer(L, { excludeTestServices: true, timeout })`. Use the named form, `layer(L, options)("suite", (it) => …)`, when the layer spans nested describes, because the anonymous form then builds inside the first test.
- Precedents: [packages/database/src/schools.test.ts](../../../../packages/database/src/schools.test.ts), [packages/database/src/oauth-refresh-window.test.ts](../../../../packages/database/src/oauth-refresh-window.test.ts), and [apps/backend/src/receipt/filesystem.test.ts](../../../../apps/backend/src/receipt/filesystem.test.ts).
- A test takes the platform from the test platform module of its package, a runtime adapter that `oxlint.config.ts` declares platform `bun`: `TestPlatform` in [apps/backend/src/test/platform.ts](../../../../apps/backend/src/test/platform.ts), and `TestPlatform` and `DatabaseTestLive` (`DatabaseTest()`, PGlite, on that platform) in [packages/database/src/test-support/platform.ts](../../../../packages/database/src/test-support/platform.ts), which other packages import as `@vektorprogrammet/database/test-support/platform`.
- A test against real PostgreSQL starts a private cluster through `withDisposablePostgres` or `startDisposablePostgres` ([docs/constructs.md#test-harness](../../../../docs/constructs.md#test-harness)) and bounds its connections.
- Replace a dependency through its service with a test layer, never with a module mock (`anti-slop/no-module-mocking`). A test double of a service returns Effects, and an unexpected call dies.
- Decode a response with the contract schema. Do not pin observed output ([AGENTS.md#construction-over-trust](../../../../AGENTS.md#construction-over-trust)).

## Running tests

Run a focused test through its package: `bun run --cwd <package> vitest run <file> --no-file-parallelism --maxWorkers=1`.
Real PostgreSQL tests, browser suites, `just test`, and `just check` are heavy jobs. Run each through `just measure` ([AGENTS.md#verification-and-resources](../../../../AGENTS.md#verification-and-resources)).
