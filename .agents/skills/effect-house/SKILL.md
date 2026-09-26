---
name: effect-house
description: House conventions for Effect v4 TypeScript in the vektorprogrammet mono-web repository. It names the shared constructs, the composition roots that select platform layers, the test platform and @effect/vitest conventions, the runtime bridges, typed HTTP problems, Effect-returning services, the lint configuration and the project rules with their FX ids, the module guides, and the Effect exception registry and its check, and it links to the file that owns each fact. Use when you write, review, or test TypeScript in mono-web, and before you choose a construct, a platform or test layer, a Promise bridge, or a lint suppression. It adds to the portable effect-* skills and the installed Effect guidance and does not restate them.
---

# effect-house: mono-web

This overlay holds only what is particular to mono-web. Each item links to the file that owns the fact. Read that file, not a copy.
The links are relative to this file, so the file is a complete entry point also when a profile reads it by its path, `.agents/skills/effect-house/SKILL.md`.

- **Effect API.** The installed package is the authority: [node_modules/effect/AGENTS.md](../../../node_modules/effect/AGENTS.md) and the `ai-docs` examples that it links. Check each API against it, not against memory or a newer copy.
- **Decisions.** The portable skills teach them. Start with `effect-first`: installed versions, the decision ladder, pure stays pure, and done-means. It routes to the other `effect-*` skills. FX001 to FX016 are their shared rule ids, and this file uses them.
- **Repository rules.** [AGENTS.md](../../../AGENTS.md), and the module guide of each folder that you change.

## Before you write

1. Read the `AGENTS.md` guide of the folder. Every app, package, and bounded-context folder has one. `just guides write` renders its first part from [docs/model/contexts.cml](../../../docs/model/contexts.cml), the `@construct` tags, and the package exports. Local invariants go below that part.
2. Search [docs/constructs.md](../../../docs/constructs.md) for a construct that already owns the logic, and use it.
3. Find the platform and test layers of the file's role: [references/composition-and-tests.md](references/composition-and-tests.md).
4. At an HTTP boundary, a service interface, or a Promise callback, read [references/boundaries.md](references/boundaries.md).
5. If a rule cannot be followed, register an exception: [references/exceptions.md](references/exceptions.md).

## Constructs (FX002)

`just constructs` fails when [docs/constructs.md](../../../docs/constructs.md) differs from the `@construct` tags and the imports. Use a listed construct; do not write its logic again. Tag a new one `@construct <category>` when two call sites share its logic, then run `just constructs write`.

| Need                                       | Construct                                                                           | Enforcement                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------- |
| A PostgreSQL cluster for a test or journey | `startDisposablePostgres`, `withDisposablePostgres` ([test-harness][test-harness])  | `anti-slop/no-hand-rolled-postgres`   |
| Ports for the servers of a journey         | `reserveLoopbackPorts`, `loopbackPortFree` ([test-harness][test-harness])           | `anti-slop/no-port-probe`             |
| Instants in journey fixtures               | `journeyClock`, `admissionJourneyClock` ([test-harness][test-harness])              | `anti-slop/no-literal-window-instant` |
| Canonical JSON, digests, SQL JSON values   | `canonicalJson`, `canonicalJsonBytes`, `sha256Hex`, `canonicalJsonValue` ([digest]) | `anti-slop/no-json-text-parameter`    |
| The JSON text of an HTTP representation    | `jsonText` ([http-problem])                                                         | `effecttsgo/prefer-schema-over-json`  |
| An advisory lock                           | `lockAdvisory` with a registered `AdvisoryLockKey` ([sql-lock])                     | `anti-slop/no-raw-advisory-lock-sql`  |
| The Promise callbacks of a library         | `makeBetterAuthCallbackRunner` ([runtime-bridge])                                   | review-only                           |
| The class of a request that a journey saw  | `isNativeRequest`, `addressesAnyRoute` ([request-ledger])                           | review-only                           |

[test-harness]: ../../../docs/constructs.md#test-harness
[digest]: ../../../docs/constructs.md#digest
[http-problem]: ../../../docs/constructs.md#http-problem
[sql-lock]: ../../../docs/constructs.md#sql-lock
[runtime-bridge]: ../../../docs/constructs.md#runtime-bridge
[request-ledger]: ../../../docs/constructs.md#request-ledger

## House rules

- **Composition roots select the platform (FX003).** Only a composition root provides `BunServices.layer` or another platform layer; packages and adapters require platform services and stay portable. Enforcement: `effect/no-cross-runtime` against the roles and platforms that [oxlint.config.ts](../../../oxlint.config.ts) declares. Details: [references/composition-and-tests.md](references/composition-and-tests.md).
- **Tests are Effect programs (FX015).** `@effect/vitest`, one Effect per test, suite resources as `layer(L, { excludeTestServices: true, timeout })`, and the test platform of the package (`TestPlatform`; `DatabaseTestLive` when E1 of the diagnostics specification lands). Enforcement: `effecttsgo/async-function` in core code, `anti-slop/no-module-mocking`. Details: [references/composition-and-tests.md](references/composition-and-tests.md).
- **Services return Effects (FX003).** No Promise interface between Effect layers. A program runs only at a composition root, a runtime bridge, or a named adapter. Enforcement: `effecttsgo/async-function` and `effecttsgo/new-promise` in core code, `effect/no-premature-execution`. Details: [references/boundaries.md](references/boundaries.md).
- **HTTP failures are typed problems (FX004, FX005).** A handler decodes with the contract schemas and answers with a problem that the endpoint declares; `ProblemBoundaryLive` is the only consumer of a Cause. Enforcement: `just check-types`, which checks the endpoint unions and asserts the HTTP contract. Details: [references/boundaries.md](references/boundaries.md).
- **Every exception is registered (FX012).** A suppression of an Effect rule names its entry in [docs/effect-exceptions.json](../../../docs/effect-exceptions.json). Enforcement: `just exceptions`. Details: [references/exceptions.md](references/exceptions.md).

## Lint configuration

[oxlint.config.ts](../../../oxlint.config.ts) owns which Effect rules run on which files, and at what severity. Read it; do not copy its inventory.

- The `effect/*` rules of `@phibkro/oxlint-effect-plugin` apply by the role, platform, and boundary that each file group declares. Every group outside `packages/database` uses the `strict` strictness and reports each rule as an error. The `packages/database` groups keep the `recommended` strictness, and `advisorySeverity` makes their findings warnings until slice E1 of the diagnostics specification is done; `just lint` reports such a warning without failing, so read its output for the database files that you touched.
- The last group that matches a file decides every `effect/*` rule for it, so a test file does not inherit the rules of its source group. Groups use plain globs, because Oxlint has no extglob, and run from broad sources to narrow exceptions. [tools/conventions/tests/oxlint-groups.test.ts](../../../tools/conventions/tests/oxlint-groups.test.ts) guards that shape; keep it when you change a group.
- A new composition root or adapter joins the group of its role and platform, such as the Bun composition-root group; it gets no suppression and no `off` override. The Bun groups admit the Node modules that Bun implements (`bunNodeModules`), and their files import `process` from `node:process` and `Buffer` from `node:buffer`, because the rule admits no Node globals on `bun`.
- [docs/specs/effect-diagnostics.md](../../../docs/specs/effect-diagnostics.md) is the contract for the `effecttsgo/*` rules of the Effect language service: which rules run where, the state of each slice and of the wiring, and how to count sites (`bun x oxlint --type-aware` with the target configuration, never grep or `tsc`).

## Project rules and checks

The portable skills cite the `effecttsgo/*` rules. The rules and checks of this repository map to the same FX ids:

| Rule or check                                                                       | FX    | Rejects                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `effect/no-cross-runtime`                                                           | FX003 | A built-in, global, or platform layer of a runtime other than the one that the file group declares                                      |
| `effect/no-premature-execution`                                                     | FX003 | A program that runs, or a platform that is provided, outside a composition root                                                         |
| `effect/no-ambient-authority`                                                       | FX002 | Clock, random, cryptographic, network, timer, environment, file system, process, or runtime authority outside a declared Effect service |
| `effect/no-ambient-console`                                                         | FX011 | Console output outside the Effect observability capability                                                                              |
| `effect/no-native-promise-control-flow`                                             | FX003 | `async`, `await`, a Promise construction or combinator, or `Effect.runPromise` in a library, service, or adapter                        |
| `effect/no-untyped-throw`                                                           | FX005 | A `throw` in a library or service, where the failure belongs in the error channel                                                       |
| `effect/no-raw-json-parse`                                                          | FX004 | `JSON.parse` of external data, where a schema decodes the text                                                                          |
| `anti-slop-effect/no-manual-effect-error-tag`                                       | FX005 | A branch on `_tag` in a catch handler, where a tagged error handler fits                                                                |
| `anti-slop-effect/no-manual-tag-comparison`, `anti-slop-effect/prefer-effect-match` | FX002 | A hand-written branch on `_tag`, or a chain of literal ternaries over one value, where `Match` fits                                     |
| `anti-slop-effect/no-manual-tagged-construction`                                    | FX002 | A hand-written `_tag`, where the tagged value has a constructor                                                                         |
| `anti-slop-effect/no-service-constructor-imports`                                   | FX003 | An import of a project `make<Capability>` constructor outside a test, where a layer provides the service                                |
| `anti-slop/no-module-mocking`                                                       | FX015 | A module mock in a test                                                                                                                 |
| The rules of the constructs table                                                   | FX002 | Logic that a listed construct owns                                                                                                      |
| `just exceptions`                                                                   | FX012 | A suppression without a registered exception, and an entry that no longer matches its sites or versions                                 |
| `just constructs`                                                                   | FX002 | A construct catalogue that differs from the `@construct` tags and the imports                                                           |
| `just check-types`                                                                  | FX004 | A type error, and an HTTP contract that differs from the one that it regenerates                                                        |
| `packages/database/src/migration-registry.test.ts`, `just migration-hashes`         | FX010 | An applied migration whose checksum changed, and a migration id, position, or file that the registry lacks                              |

`effect/no-native-promise-control-flow` and `effect/no-untyped-throw` are strict rules, so they run in every group outside `packages/database`. `effect/no-raw-json-parse` runs where a group declares the `external-data` boundary: the `apps/backend` runtime adapters.

## What the tier skills look up here

The portable skills leave these facts to the overlay:

- **Lint configuration and severities:** [Lint configuration](#lint-configuration).
- **Project rules and checks:** [Project rules and checks](#project-rules-and-checks).
- **Exception registry and its check:** [docs/effect-exceptions.json](../../../docs/effect-exceptions.json) and `just exceptions`; see [references/exceptions.md](references/exceptions.md).
- **House constructs:** [Constructs](#constructs-fx002) and [docs/constructs.md](../../../docs/constructs.md).
- **Composition roots, test platform, and runtime bridges:** [references/composition-and-tests.md](references/composition-and-tests.md) and [references/boundaries.md](references/boundaries.md).
- **Layer names:** `<Service>Live` for a live layer, such as `DatabaseLive`, `ContentManagementLive`, and `ReceiptFileStoreLive`, and `DatabaseTest()` for the PGlite database of a test. Services have no `layer` or `layerTest` statics.
- **Migrations and the test database:** `packages/database/migrations/NNNN-<name>.sql`, frozen by `packages/database/migrations/checksums.json`; `just migration-hashes write` records a new one. A test takes `DatabaseTest()` or a disposable cluster (`withDisposablePostgres`).
- **Drift check of generated artifacts:** `just check-types` runs the `generate` scripts of `packages/http-api` and `packages/sdk` before the type checks, and asserts the HTTP contract.
- **Test command and type-test tool:** `bun run --cwd <package> vitest run <file> --no-file-parallelism --maxWorkers=1`. Type tests use `expectTypeOf` of Vitest, as [`packages/sdk/src/__tests__/generated-native-client.test.ts`](../../../packages/sdk/src/__tests__/generated-native-client.test.ts) does.
- **Foldkit house form:** one folder per bounded context in `apps/dashboard/app/foldkit`, each with its guide, and one Model per stateful workflow. Tests are `update.test.ts`, `view.test.ts` with `Scene` of `foldkit/test`, and `update.property.test.ts`. `anti-slop/no-unkeyed-command-row` runs there. `foldkit/prefer-command-mapmessage` does not, because `oxlint.config.ts` configures no Foldkit plugin.

## Done means

- `just exceptions`, `just constructs`, `just guides`, and `just layout` pass. The pre-commit hook runs them on the staged tree.
- `just lint` passes on the changed files with no new warning, and the package type check passes. `just check-types` and `just check` are heavy jobs: run them through `just measure`.
- The changed behaviour has a focused test (`bun run --cwd <package> vitest run <file>`) or a journey, run through `just measure` when it starts PostgreSQL or a browser.
- The report names each exception added, changed, or retired, with its id.
