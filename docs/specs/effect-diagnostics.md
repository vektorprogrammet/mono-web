# Effect diagnostics

Status: frozen for implementation on 2026-09-26 (operator decision: fix all, then enforce).
Remove this specification when `just lint` enforces every Effect language-service rule as an error with no findings, and `tsc` no longer reports Effect diagnostics.

## Defect

`tsconfig.json` loads `@effect/language-service` with default severities. Hosted run `36240534206` (`TypeScript (build, test)`, main `fe990e0f`) printed 926 suggestion lines (some packages twice, from build and check-types) that nobody acts on, which hide real output.

| Rule                            | Count | Slice |
| ------------------------------- | ----: | ----- |
| `preferTypedSchemaDecoder`      |   234 | A     |
| `unnecessaryFailYieldableError` |   166 | B     |
| `effectSucceedWithVoid`         |    92 | B     |
| `schemaNumber`                  |    82 | C     |
| `unnecessaryTypeofType`         |    52 | B     |
| `schemaSyncInEffect`            |    20 | C     |
| `lazyEffect`                    |    18 | C     |
| `unnecessaryPipeChain`          |    10 | B     |
| `unnecessaryEffectGen`          |     8 | B     |
| `multipleCatchTag`              |     8 | C     |

## Contract

- Enforcement (operator decision, 2026-09-26): Effect language-service checks are errors, never warnings or suggestions, and run everywhere Oxlint runs.
  `oxlint.config.ts` enables the `@effect/tsgo` Oxlint `recommended` preset (type-aware `effecttsgo/*` rules, which `effect-tsgo patch --oxlint` provides) with every rule mapped to `"error"`.
  `just lint`, and therefore the lint hook, `just check`, and the hosted Checks workflow, report them. The `@effect/language-service` plugin in `tsconfig.json` keeps refactors and quick info but emits no diagnostics, so `oxlint.config.ts` is the single home of Effect rule severities.
- Each site follows the rule's own fix. Where the fix would change behaviour or a test's intent, keep the behaviour and choose the equivalent typed form. A site that genuinely cannot follow a rule gets an `oxlint-disable-next-line effecttsgo/<rule>` comment with its reason, listed here.
- The wiring lands after slices A, B, and C, on a tree with zero findings, so `main` never carries a failing or warning rule.
- No behaviour, HTTP contract, or schema change. Tests keep asserting the same observable results.
- Count sites with the tools' output (`bun x oxlint --type-aware` with the preset, or the current `just check-types`), not with grep.

## Done when

1. `just lint` reports zero `effecttsgo/*` findings, and every preset rule is `"error"`; reintroducing one site fails `just lint` (negative control recorded in the commit message).
2. `just check-types` prints no Effect diagnostic.
3. The lint hook, `just check`, and the hosted Checks and Tests workflows pass on the final commit; the hook's lint time is measured and recorded.

## Remaining steps

Slices A, B, and C run in separate worktrees. A slice that stops before it is done commits its work in progress and lists its remaining packages here.
