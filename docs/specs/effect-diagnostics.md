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
- When a rule provides a precise expectation mechanism, use it instead of a disable comment, and list the site here: the expectation names what it accepts, so a new finding still fails.
- The wiring lands last, on a tree with zero findings, so `main` never carries a failing or warning rule.
- No behaviour, HTTP contract, or schema change. Tests keep asserting the same observable results.
- Count sites with `bun x oxlint --type-aware` and the target configuration, not with grep or `tsc`.

## Slices

| Slice | Rules | Sites on `5ee47aec` | State |
| ----- | ----- | ------------------: | ----- |
| A | `prefer-typed-schema-decoder` | 332 | Landed `5ee47aec`; 13 residual sites in `apps/dashboard/app/routes/*.tsx` move to D |
| B | `unnecessary-fail-yieldable-error`, `unnecessary-typeof-type`, `effect-succeed-with-void`, `unnecessary-pipe-chain`, `unnecessary-effect-gen` | 207 | In progress |
| C | `schema-number`, `schema-sync-in-effect`, `lazy-effect`, `multiple-catch-tag` | 132 | In progress |
| D | every other non-`effectNative` preset rule everywhere (`any-unknown-in-error-context` 141, `leaking-requirements` 4, and the small ones), type-aware `typescript(*)` 138, A's residue; `prefer-schema-over-json`, `instance-of-schema`, and `extends-native-error` are `effectNative` rules, so they belong to E1–E3 in core code and are off elsewhere | 312 | In progress: `packages/database`, `packages/domain`, `packages/http-api` done |
| E1 | `effectNative` rules in `packages/database` (`async-function` 376 and the rest) | ~470 | After C |
| E2 | `effectNative` rules in `apps/backend` | ~400 | After E1 or D |
| E3 | `effectNative` rules in `packages/domain` and `packages/http-api` | ~90 | After E1 or D |
| W | wiring (`oxlint.config.ts`, tsconfig, lint hook, CI), negative control | - | Prepared; lands last |

## Exceptions

`effecttsgo/leaking-requirements` expectations (`@effect-expect-leaking` in the service's JSDoc):

- `IdentitySnapshot` (`packages/database/src/auth-live.ts`) expects `Database`: session reads run in the caller's ambient Database transaction.
- `ContentManagement` (`packages/domain/src/content/service.ts`) expects `Organization`: the capability topology gives ContentManagement no layer dependency, so the composition root supplies Organization to every operation.
- `PersonSecurity` and `PersonOrServiceSecurity` (`packages/http-api/src/common.ts`) expect `HttpServerRequest`, `ParsedSearchParams`, and `RouteContext`: HttpApiMiddleware security handlers run per request.

## Done when

1. `just lint` reports zero `effecttsgo/*` findings, and every preset rule is `"error"`; reintroducing one site fails `just lint` (negative control recorded in the commit message).
2. `just check-types` prints no Effect diagnostic.
3. The lint hook, `just check`, and the hosted Checks and Tests workflows pass on the final commit; the hook's lint time is measured and recorded.

## Remaining steps

Slices A, B, and C run in separate worktrees. A slice that stops before it is done commits its work in progress and lists its remaining packages here.

Slice D (branch `refactor/effect-diagnostics-d-0926`) remains, by the D configuration on `f60aa1ed` (the preset rules outside `effectNative`, B, and C, plus the type-aware `typescript(*)` rules, all errors):

- `apps/dashboard`: `prefer-typed-schema-decoder` 13 (the A residue in `app/routes/*.tsx`), `no-base-to-string` 17, `unbound-method` 12, `restrict-template-expressions` 10, `require-array-sort-compare` 10, `any-unknown-in-error-context` 6, `global-error-in-effect-failure` 3, `effect-map-void` 2.
- `apps/backend`: `no-base-to-string` 3, `any-unknown-in-error-context` 2, `catch-all-to-map-error` 2, `catch-to-ignore` 1, `unbound-method` 1, `no-misused-spread` 1, `restrict-template-expressions` 1.
- `apps/homepage`: `no-base-to-string` 5, `no-useless-default-assignment` 1. `packages/sdk`: `no-base-to-string` 1.
- `tools/e2e`: `restrict-template-expressions` 8, `require-array-sort-compare` 5, `multiple-effect-provide` 2, `any-unknown-in-error-context` 1, `no-misused-spread` 1, `no-redundant-type-constituents` 1.
- `tools/acceptance`: `no-redundant-type-constituents` 7, `restrict-template-expressions` 6, `require-array-sort-compare` 2, `no-misused-spread` 2.
- `tools/verification`: `any-unknown-in-error-context` 3, `no-base-to-string` 1, `require-array-sort-compare` 1, `unbound-method` 1, `no-misused-spread` 1.

The fixes so far follow these forms: type the failure channel instead of `unknown` (an explicit error union, or inference where the success type is already annotated); `Effect.orElseSucceed` for `Effect.catch` to `Effect.succeed`; `Result.try` for synchronous `try/catch` in a generator; `Struct.assign` where a class instance is copied into a plain object, which keeps the plain result; an explicit comparator that keeps the previous order; an arrow for an unbound method; a precise parameter type instead of `String(unknown)`.
