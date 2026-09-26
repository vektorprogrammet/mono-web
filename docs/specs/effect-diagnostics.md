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

- Enforcement (operator decisions, 2026-09-26): Effect language-service checks are errors, never warnings or suggestions, and run everywhere Oxlint runs (`just lint`, the lint hook, `just check`, the hosted Checks workflow).
- Scope (operator decision after the preset census of 4,167 findings on `5ee47aec`):
  - **Core Effect code** (`packages/domain`, `packages/database`, `packages/http-api`, `apps/backend`): every rule of the `@effect/tsgo` Oxlint `recommended` and `correctness` presets is an error, including the `effectNative` rules.
  - **Everywhere else** (`apps/dashboard`, `apps/homepage`, `apps/docs`, `packages/sdk`, `tools/*`, `**/e2e/**`): the same rules are errors except the `effectNative` preset's rules, which are off there. `oxlint.config.ts` derives that list from the package's exported `effectNative` preset (never a copied list) and states the reason once: these are not Effect programs.
  - Oxlint's own type-aware `typescript(*)` rules that type-aware mode enables are errors too, so type-aware lint prints no warnings.
- `oxlint.config.ts` imports the presets from `@effect/tsgo` and maps every rule to `"error"`. The `@effect/language-service` plugin in `tsconfig.json` keeps refactors and quick info but emits no diagnostics.
- Each site follows the rule's own fix. Where the fix would change behaviour or a test's intent, keep the behaviour and choose the equivalent Effect form. A site that genuinely cannot follow a rule gets `// oxlint-disable-next-line <rule> -- <reason>`, listed here.
- The wiring lands last, on a tree with zero findings, so `main` never carries a failing or warning rule.
- No behaviour, HTTP contract, or schema change. Tests keep asserting the same observable results.
- Count sites with `bun x oxlint --type-aware` and the target configuration, not with grep or `tsc`.

## Slices

| Slice | Rules | Sites on `5ee47aec` | State |
| ----- | ----- | ------------------: | ----- |
| A | `prefer-typed-schema-decoder` | 332 | Landed `5ee47aec`; 13 residual sites in `apps/dashboard/app/routes/*.tsx` move to D |
| B | `unnecessary-fail-yieldable-error`, `unnecessary-typeof-type`, `effect-succeed-with-void`, `unnecessary-pipe-chain`, `unnecessary-effect-gen` | 207 | In progress |
| C | `schema-number`, `schema-sync-in-effect`, `lazy-effect`, `multiple-catch-tag` | 132 | In progress |
| D | every other non-`effectNative` preset rule everywhere (`any-unknown-in-error-context` 141, `prefer-schema-over-json` 51, `instance-of-schema` 47, `extends-native-error` 28, and the small ones), type-aware `typescript(*)` 138, A's residue | ~420 | After B |
| E1 | `effectNative` rules in `packages/database` (`async-function` 376 and the rest) | ~470 | After C |
| E2 | `effectNative` rules in `apps/backend` | ~400 | After E1 or D |
| E3 | `effectNative` rules in `packages/domain` and `packages/http-api` | ~90 | After E1 or D |
| W | wiring (`oxlint.config.ts`, tsconfig, lint hook, CI), negative control | - | Prepared; lands last |

## Done when

1. `just lint` reports zero `effecttsgo/*` findings, and every preset rule is `"error"`; reintroducing one site fails `just lint` (negative control recorded in the commit message).
2. `just check-types` prints no Effect diagnostic.
3. The lint hook, `just check`, and the hosted Checks and Tests workflows pass on the final commit; the hook's lint time is measured and recorded.

## Remaining steps

Slices A, B, and C run in separate worktrees. A slice that stops before it is done commits its work in progress and lists its remaining packages here.
