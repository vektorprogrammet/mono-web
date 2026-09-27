[//]: # "guide: generated from content/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# tools/conventions

Layout, guide, construct, and Effect exception checks and their generated files.
Package `@monoweb/conventions`.

## Entry points

| Import                               | Module                                       |
| ------------------------------------ | -------------------------------------------- |
| `@monoweb/conventions/documentation` | [src/documentation.ts](src/documentation.ts) |
| `@monoweb/conventions/layout`        | [src/layout.ts](src/layout.ts)               |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Constructs

Reading about a shared construct discloses in three steps, and each step has one source:

1. The index, `docs/constructs.md`: each category and each construct in one line.
2. The contract, on the page of its category in `docs/constructs/`: the summary, the signature, inputs, output, errors, and requirements that `src/contracts.ts` reads from the annotations, and the side effects, how it works, one use, and the misuse to avoid from `@sideEffects`, `@remarks`, `@example`, and `@avoid`.
3. Its consumers, which `just constructs consumers <name>` reads from the import graph when called.

The pages depend on the tagged declarations and their JSDoc alone, never on the import graph, so an import changes no page; `constructPages` in `src/constructs.ts` names their paths.
`checkConstructs` fails on a stale page, a malformed or misplaced tag, a missing contract tag or annotation, and a construct that fewer than two modules outside its own module and the tests of its app or package import.
It only warns about an untagged function that three or more modules outside its app or package import.

## Documentation extracts

This package reads construct contracts, journeys, layout, and package guides. `apps/docs` writes documentation through `just docs generate`, including `docs/constructs.md` and `docs/constructs/*.md`. `just constructs write` delegates to that command. Keep authored pages in the root or workspace `content/` folders.
