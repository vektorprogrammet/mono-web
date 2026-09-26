# Repository conventions

Status: frozen for implementation on 2026-09-25. Remove this specification when the checks below run in hooks and CI and `AGENTS.md`, the README, and the module guides carry the enduring rules.

Progress on 2026-09-26 (`ffb46b9b`), the active contract for lead-handoff items 5:

- Phases 1 and 2 are done: the layout declaration and check, the `justfile`, module guides, and the construct catalogue run in hooks and CI.
- Phase 3 is partial. Reuse rules in force: `no-raw-advisory-lock-sql`, `no-hand-rolled-postgres`, `no-port-probe`, `no-git-history`, `no-dev-server`, `no-unkeyed-command-row`, `no-literal-window-instant`, `no-json-text-parameter`, and `no-leadership-reach`.
  Not yet written: generated package rules and context boundary rules from the CML, `import/no-cycle`, raw SQL outside `packages/database`, outbox claim SQL, bare provider `fetch`, and `Date.now()`/`new Date()` in domain and backend code.
- Phase 4 is done for each rule in force (each is an error with no violations); the rules not yet written have unmigrated violations.
- Phase 5 has not started: no `ai-docs` package, `LLMS.md`, Knip, or syncpack.

## Goal

The repository keeps its structure, its reuse of shared code, and its documentation correct by construction.
Each fact has one source. Everything derived from it is generated, or a check fails when it drifts.
A person or an agent can find the right place for new code, the shared construct to use, and the commands to run without asking.

## Sources of truth

| Fact | Source | Derived from it |
| --- | --- | --- |
| Bounded contexts and their relationships | `docs/model/contexts.cml` | context folder check, context boundary lint rules, context sections of module guides, docs-site context map |
| Authority rules | `docs/model/authority.als` | nothing generated; the Alloy checks run in CI |
| Repository layout | one declaration in `tools/conventions` | layout check, layout table in `AGENTS.md` and the README |
| Shared constructs | `@construct <category>` JSDoc tags on exports | construct catalogue page, consumer counts from the import graph, lint messages |
| Worked examples for people and agents | type-checked files under `ai-docs/src` | `LLMS.md` and the docs-site guide section |
| Commands | the root `justfile` | `just --list`, hook and CI invocations |
| Public entry points | `exports` in each `package.json` | module guides, import rules |

## Decisions

### Layout

- Packages stay layer-first: `packages/domain`, `packages/database`, `packages/http-api`, `packages/sdk`, and `apps/backend` for composition.
- Each layer uses the CML context name as its folder name: `packages/domain/src/<context>`, `packages/database/src/<context>`, `apps/backend/src/<context>`, `apps/dashboard/app/foldkit/<context>`.
- Code shared by several contexts belongs to a CML Shared Kernel context, not to loose top-level files.
- `packages/placements` folds back into `packages/domain/src/placements` and `packages/database/src/placements` before the context checks turn on.
- Top-level entries are limited to `apps/`, `packages/`, `tools/`, `infra/`, `docs/`, `ai-docs/`, and the root configuration files. `tools/` code is never imported by `apps/` or `packages/`.
- The shared canonical-JSON and digest helpers move out of `packages/domain/src/tutor` into a Shared Kernel folder.

### Commands

- The `justfile` is the only user-facing command surface.
- A recipe delegates to a devenv task when it needs declared dependencies, such as PostgreSQL before tests. It delegates to a devenv script when it needs a pinned tool, and to a TypeScript file under `tools/` for real logic.
- Root `package.json` scripts shrink to what Bun, Turbo, and tools require. Per-package scripts that Turbo runs stay.
- Hooks and CI workflows call `just` recipes inside `devenv shell`.

### Module guides

- Every app, every package, and every context folder has an `AGENTS.md` with a `CLAUDE.md` symlink.
- The context section is generated from the CML: responsibility, owned aggregates, what the context does not own, upstream and downstream relationships, and the role of this layer.
- The constructs section and the entry-point section are generated from `@construct` tags and `exports`.
- Local invariants, pitfalls, and recipes are hand-written below the generated sections.
- Existing module READMEs stay as human guides. The generated guide links to them.

### Shared constructs

- A shared construct carries `@construct <category>` and a module header comment in the style of Effect's modules: purpose, when to use, details.
- The catalogue lists name, summary, location, and consumers. Consumers are computed from the import graph.
- A construct is created only when at least two call sites share the same logic.
- Raw node-postgres code in `packages/database` moves to Effect SQL. No construct gets a second, raw-client twin.

### Lint and boundary rules

- Package level: the Oxlint `no-restricted-imports` patterns are generated from the CML context map and the layout declaration, and `import/no-cycle` is on.
- Context level: custom rules in `tools/oxlint` forbid imports between context folders unless the CML declares the relationship, and require such imports to go through the context's entry module. The same rules cover the dashboard's Foldkit context folders.
- Reuse rules name the construct to use. The first rules:
  - raw SQL (`sql` tags, `pg`, or `SqlClient` imports) outside `packages/database`;
  - hand-written advisory-lock SQL outside `lockAdvisory` (in force);
  - outbox claim SQL outside `outbox-lifecycle.ts`;
  - bare `fetch` for provider delivery outside `deliverJson`;
  - `Date.now()` and `new Date()` in domain and backend code instead of `Clock` and `DateTime`;
  - port reservation outside the golden harness helpers.
- A new rule starts as a warning. It becomes an error in the commit that migrates its last violation.

### Hygiene

- Knip reports unused files, exports, and dependencies. syncpack keeps workspace versions and Bun catalogs consistent. One root Renovate configuration replaces the per-app files.
- The source-safety scan runs over the whole staged tree on every commit, independent of the Turbo cache.

### Documentation for agents

- `ai-docs/src/<NN>_<topic>/` holds an `index.md` and numbered, type-checked example files, following Effect's `ai-docs` layout.
- A generator writes `LLMS.md` at the root. The docs site publishes it.
- Examples come first for the recurring tasks: a command with an outbox effect, a Layer for a provider, a typed problem mapping, and a golden journey step.

## Boundaries

- No change to product behaviour, the HTTP wire contract, or the database schema, except moving files and import paths.
- No new formatter or linter besides Oxfmt and Oxlint. Knip and syncpack are hygiene reports, not linters.
- Context Mapper runs on a JDK from nixpkgs as a devenv task that only the generation step depends on. The default shell does not grow.
- Nothing published, deployed, or pushed as part of this work beyond `main`.

## Phases

Each phase lands green on `main` before the next starts.

1. Structure: fold Placements back, move the shared digest helpers, add the layout declaration and check, and switch commands to the `justfile`.
2. Generated documentation: module guides, construct tags and catalogue, and docs-site pages.
3. Rules: generated package rules, context boundary rules, and reuse rules, all as warnings.
4. Migration: move each violation onto its construct. Promote each rule to an error once its violations reach zero.
5. Agent documentation: the `ai-docs` package and generated `LLMS.md`.

## Done when

1. `just` lists every command that the README and `AGENTS.md` mention, and no root script duplicates a recipe.
2. A new top-level folder, a package outside `apps/`, `packages/`, or `tools/`, or a context folder missing from the CML fails the layout check in the pre-commit hook and in CI.
3. Editing the CML without regenerating fails the check that compares generated outputs, and so does editing a generated section of a module guide by hand.
4. Every app, package, and context folder has a guide and a `CLAUDE.md` symlink. The context section of each guide matches the CML.
5. The catalogue lists every tagged construct with consumer counts computed from imports. An exported construct used by three or more modules outside its own without a tag is reported.
6. A staged import across contexts without a declared CML relationship fails. A staged raw SQL statement outside `packages/database` fails. Each rule has a negative control in its test.
7. Knip and syncpack run in CI with no unexplained findings.
8. `LLMS.md` is generated from examples that type-check. A broken example fails the build.
9. `bun run check`, the source-safety scan, and the hosted Checks and Tests workflows pass on the final commit.
