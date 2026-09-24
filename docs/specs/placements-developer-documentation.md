# Placements developer documentation

Status: planned. This specification does not claim implementation, tool compatibility, or acceptance.

This is pilot A of [Developer module documentation](../module-developer-documentation.md#first-pilot-placements).
The common base is `c89a55127bdfca4628839e0a14089878f3ce85fb`.
The implementation branch is `docs/placements-developer-guide-0924` in the separate `mono-web-docs` worktree.

## Goal

A consumer can find Placements, run a supported example, and understand its contract without private imports.
A maintainer can locate the implementation, explain its boundaries, and complete one bounded change without changing public behavior.

One guide connects these tasks with source-derived reference material and executable checks.
The guide must distinguish public guarantees, implementation explanations, illustrative composition, and real database evidence.

## Constraints

### Scope and authority

The guide covers purpose, exclusions, use, contract, composition, implementation, and change tasks.
The [package export map](../../packages/placements/package.json) owns supported imports.
It currently exposes `@vektorprogrammet/placements/contracts` and `@vektorprogrammet/placements/server`, with no package-root entry point.

The reference derives signatures and API comments from those exports and their declarations.
Private files can support maintainer explanations, but they are not supported import paths.
The guide links [business rules](../system.md#school-demand-and-placement) and [architectural ownership](../architecture.md#ownership) instead of defining competing rules.

The [service declaration](../../packages/placements/src/service.ts) specifies caller-owned transactions and the precondition callback boundary.
The [implementation](../../packages/placements/src/server/service.ts) supplies the database-backed Layer and holds the department lock across command execution.
The guide must link these sources and explain their relation to:

- [HTTP authority and preconditions](../../apps/backend/src/placements/http.ts).
- [Command receipts and transactions](../../apps/backend/src/http-api/receipt-transaction.ts).
- [Roster notification delivery](../../packages/placements/src/server/outbox.ts).
- [Dispatch notification delivery](../../packages/placements/src/server/dispatch-outbox.ts).
- [Runtime composition](../../apps/backend/src/main.ts).
- [Database resource Layers](../../packages/database/src/layers.ts).

The explanation must identify the owner of authorization, transaction completion, retries, interruption, provider delivery, and resource release.
It must distinguish committed state, queued delivery, and provider acknowledgement.
It must not promise exactly-once provider effects or cancellation rollback without source and behavioral evidence.

### Ownership and exclusions

| Area                       | Owned work or restriction                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| This preparation           | Only this specification before implementation starts                                                                              |
| Future Placements work     | Public declaration comments, executable examples, guide, and scoped checks under `packages/placements`                            |
| Future documentation tools | Narrow extensions under `tools/system-guide`, or one coherent documentation tool location if necessary                            |
| Shared files               | Manifests, lockfiles, navigation, CI entry points, roadmap, and STATE changes require an integration handoff                      |
| Forbidden product changes  | Public API changes, export expansion, business-rule changes, and new private integration paths                                    |
| Other branch               | No E2E runner, browser scenario, workflow, or sibling specification edits                                                         |
| Broader exclusions         | No repository-wide rewrite, new framework, custom compiler-based documentation generator, or new documentation website by default |

Before a shared-file edit, the author declares its path and purpose to the integrating owner.
The integrating owner resolves overlapping changes and checks the combined committed artifact.
Documentation must work without the parallel E2E CI branch.

### Tool qualification

The [existing renderer](../../tools/system-guide/build.ts) produces standalone HTML from trusted MDX.
It does not currently derive a module reference or check executable examples.
The [HTTP generator](../../packages/http-api/scripts/generate-openapi.ts) provides an existing deterministic generation and freshness pattern.
The [package TypeScript configuration](../../packages/placements/tsconfig.json) currently includes only `src`.
New examples must enter an explicit compiler check.

Qualify [Effect docgen](https://github.com/Effect-TS/docgen) before adoption.
Limit the first experiment to this package, two supported entry points, and one executable example.
Record the candidate version, dependencies, installed TypeScript and Effect versions, Node and Bun versions, commands, and results.
Check declaration extraction, JSDoc rendering, public export filtering, example execution, deterministic output, and freshness failure behavior.
A dependency mismatch or unsupported compiler API is a failed qualification, not permission to replace the application stack.

If docgen cannot satisfy this contract, retain the installed compiler and runtime for examples.
Reuse existing rendering and source declarations for the reference.
Evaluate one maintained alternative only when that fallback leaves a concrete requirement unmet.
Do not import temporary parity tooling into durable documentation tooling.
Do not claim qualification from package metadata alone.

### Examples and rendered source

At least one executable TypeScript file must import supported public entry points and produce an observable result.
It must exercise a meaningful rejected operation or precondition and explain caller recovery.
An invalid transition is sufficient for a pure example, but it does not establish persistence behavior.
Any Service example must show required Layers, caller authority, transaction responsibility, and cleanup.
A fake Service cannot establish database or transaction guarantees.

The guide includes the exact executable file, not a separately maintained code block.
The reference includes source documentation and declarations, not copied signatures or generated explanations of intent.
Generated output remains outside tracked source, consistent with the [repository policy](../../AGENTS.md#authority).
An executable freshness check must reject output that no longer matches its source.

## Values

- One authority for each fact, with direct source links.
- Useful consumer tasks before exhaustive implementation narration.
- Explicit maintainer boundaries instead of accidental private contracts.
- Existing tools before new dependencies or abstractions.
- Honest evidence limits instead of claims from compilation alone.
- Small, repeatable checks that fail for a real defect.

## Definition of done

All requirements apply to future implementation. None of these acceptance checks ran during preparation.

| Requirement     | Executable or observed acceptance                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Discovery       | The repository documentation entry point links the guide. Local links and source references resolve.                              |
| Public imports  | The example compiler check resolves only supported package entry points, including dependencies.                                  |
| Use example     | The declared command runs the exact rendered source and checks its success and meaningful rejection outcomes.                     |
| API reference   | Generation derives the public entry points, declarations, and their API comments from current source.                             |
| Freshness       | Generation is deterministic. A read-only check rejects edited output and output from changed source.                              |
| Negative checks | Disposable changes break a public import, invalidate an example, and stale an output. Each relevant check exits nonzero.          |
| Explanation     | Source review connects authority, transaction, outbox, retry, interruption, and resource claims to their actual owners.           |
| Reader use      | An independent developer or agent finds the guide and completes the use task without private implementation coaching.             |
| Reader change   | The same reader makes a disposable, bounded comment or example change and runs the documented affected checks.                    |
| Reporting       | The acceptance record identifies human or agent readers, commands, source artifact, failures, cleanup, and unverified boundaries. |

The final guide must name exact commands, working directories, prerequisites, expected results, and cleanup.
New command names remain implementation decisions until executable files exist.
Preparation does not authorize a claim that future commands already work.

The existing real-boundary command is:

```bash
bun run test:golden-school-service
```

The [local gate instructions](../web-system-functional-testing.md#local-school-service-gate) own prerequisites and evidence limits.
Documentation references this accepted command without duplicating its implementation or depending on its CI integration.
Pure example success does not establish HTTP authorization, PostgreSQL atomicity, browser usability, or provider acceptance.
An agent reader exercise does not establish comprehension by an unfamiliar human developer.

### Resources and cleanup

Examples use synthetic values and disposable resources, with no real credentials or external notifications.
The implementation declares every process, port, runtime, database, temporary directory, and generated artifact that it owns.
One heavy job runs at a time across both workstreams.
Real PostgreSQL or browser acceptance requires coordination with the integrating owner.

Each executable closes owned resources after success, failure, and interruption.
Disposable negative checks restore source and remove temporary artifacts without touching another worktree.
The implementation removes qualification experiments and completed specifications after durable guidance and observable checks replace them.
The integration handoff retains acceptance evidence outside the repository.
