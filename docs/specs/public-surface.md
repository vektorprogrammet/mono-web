# Public surface

Status: frozen for implementation on 2026-09-26 (operator request; evidence below). Remove this specification when the checks below run in hooks and CI and `AGENTS.md`, the effect-house overlay, and the module guides describe the rule.

## Goal

Each package's public surface is exactly what other packages use, and every declaration on it has a doc comment.
A reader can trust that anything reachable from a package's `exports` is used across a package boundary and documented. Anything else is internal.

## Evidence (measured on `6740cbbc`)

- Export maps reach 2,483 declarations in domain, database, http-api, sdk, backend, and tools/postgres. 1,847 of them have no JSDoc, and 1,097 (44%) have no importer outside their package. Of those, 631 have no importer at all.
- knip 6.38.0 export findings are reliable: at most 2% false positives, and 0 with the tuned entries. Its file and dependency findings need explicit entries for spawned runners, justfile CLIs, and `tools/acceptance`.
- The module graph has no runtime cycle. Two type-only 2-cycles exist, in `authz/reach.ts`↔`organization/authority.ts` and `password-recovery.ts`↔`auth-engine.ts`. Modules are folder-cohesive. Only 6 merges are clean, and merging gives little.
- A root barrel would cost the browser bundle about 28% gzip for one symbol and would put 1,600+ names in one namespace. The per-context subpath entries stay the surface.
- `isolatedDeclarations` would raise about 5,000 errors, most of them in Schema constants. It forces types, not docs, so it is not used.

Full lists: the SurfaceAnalysis report (`/tmp/surface-*.txt` on the workstation at the time of measurement). Re-measure before starting; do not trust these lists.

## Rules

- The public surface of a package is the closure of its `package.json` `exports` through re-exports. Barrels that are export-map targets re-export by name, not `export *`, so the surface is written down, not inferred.
- **An export needs an importer, except package exports** (operator decision, 2026-09-27). A package's export-map closure is its public API: a declaration reachable from `package.json` `exports` may be exported without an in-repository importer, but it still needs its doc comment. Every other `export` needs at least one importer (a test counts). An internal export that nothing imports loses `export`, or is deleted when dead. knip's unused-exports check with entry exports excluded (`includeEntryExports: false`) is exactly this rule.
- Every public declaration has a JSDoc comment that says what it is for. A type derived from a documented schema (`type X = typeof XSchema.Type`) is covered by the schema's comment. `@construct` exports keep the stricter tags of [construct contracts](construct-contracts.md).
- knip runs in `just check` and hosted Checks with the tuned entries, and reports no unused files, exports, types, or dependencies.
- No root barrel convention. The domain `.` entry, with 962 names and 4 importers, is removed, and its importers use subpaths. `"sideEffects": false` is set on domain once the bundle build shows it is safe.

## Steps

1. Prune: delete the barrels no one imports (`domain/src/tutor/index.ts`, `sdk/src/index.ts`), remove the unused sdk `@effect/vitest` devDependency, remove the 11 alias duplicates, and apply the knip findings with tuned entries.
2. Narrow: convert entry barrels to named re-exports (no `export *`), and remove domain `.`. Package exports are not pruned for lacking an in-repository importer.
3. Collapse the clean merges that still apply.
4. Enforce: `just surface` in `tools/conventions`, reusing the declaration and JSDoc reader that construct contracts builds, over the export-map closure. It reports an undocumented public declaration and a barrel with no importer. Turn it on per package as each package reaches zero findings (sdk and postgres pass today). Then write the docs, package by package.

## Done when

1. `just surface` reports zero findings for every package, runs in `just check`, the pre-commit hook, and hosted Checks, and fails on an undocumented public export (negative control).
2. knip runs with zero findings in `just check`, the pre-commit hook, and hosted Checks, with entry exports excluded. It fails on a new unused export in an internal module, and passes on a new unimported export reachable from a package's `exports` (negative and positive controls).
3. No entry barrel uses `export *`. Domain has no `.` entry.
4. The browser bundles of the dashboard and homepage are no larger than before (measured).
5. `just check` and the hosted Checks and Tests workflows pass.

## Constraints

Every rename or removal migrates all its callers in the same commit. Run it after the Fumadocs, certificates, construct-contracts, and runtime-import slices land, because it touches every package's entry points.
