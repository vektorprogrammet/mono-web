# Effect diagnostics

Status: frozen for implementation on 2026-09-26 (operator decision: fix all, then enforce).
Remove this specification when `just check-types` prints no Effect language-service diagnostic and every rule below is an error.

## Defect

`tsconfig.json` loads `@effect/language-service` with default severities. Hosted run `36240534206` (`TypeScript (build, test)`, main `fe990e0f`) printed 926 suggestions that nobody acts on, which hide real output.

| Rule                            | Count | Slice |
| ------------------------------- | ----: | ----- |
| `preferTypedSchemaDecoder`      |   442 | A     |
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

- Each site follows the rule's own fix. Where the fix would change behaviour or a test's intent, keep the behaviour and choose the equivalent typed form; record any site that genuinely cannot follow the rule with the rule's suppression comment and a reason, and list it here.
- A rule becomes `"error"` in the `diagnosticSeverity` options of the `@effect/language-service` plugin in `tsconfig.json` in the commit that migrates its last site. Never downgrade a rule to hide sites.
- No behaviour, HTTP contract, or schema change. Tests keep asserting the same observable results.
- Count sites with the language service's own output (`just check-types`), not with grep.

## Done when

1. `just check-types` prints no Effect language-service diagnostic.
2. All ten rules are `"error"` in `tsconfig.json`; reintroducing one site fails `just check-types` (negative control recorded in the commit message).
3. `just check`, `just test`, and the hosted Checks and Tests workflows pass on the final commit.

## Remaining steps

Slices A, B, and C run in separate worktrees. A slice that stops before it is done commits its work in progress and lists its remaining packages here.
