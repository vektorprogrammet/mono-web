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
| D | every other non-`effectNative` preset rule everywhere (`any-unknown-in-error-context` 141, `leaking-requirements` 4, and the small ones), type-aware `typescript(*)` 138, A's residue; `prefer-schema-over-json`, `instance-of-schema`, and `extends-native-error` are `effectNative` rules, so they belong to E1–E3 in core code and are off elsewhere | 312 | Done: zero findings repository-wide (branches `refactor/effect-diagnostics-d-0926` and `refactor/effect-diagnostics-d2-0926`) |
| E1 | `effectNative` rules in `packages/database` (`async-function` 376 and the rest) | ~470 | After C |
| E2 | `effectNative` rules in `apps/backend` | 450 on `282da16f` | In progress: 430 left; see Remaining steps |
| E3 | `effectNative` rules in `packages/domain` and `packages/http-api` | 104 on `40de8ee4` | Done: zero findings in both packages, no exception (branch `refactor/effect-diagnostics-e3-0926`) |
| W | wiring (`oxlint.config.ts`, tsconfig, lint hook, CI), negative control | - | Prepared; lands last |

## Exceptions

`effecttsgo/leaking-requirements` expectations (`@effect-expect-leaking` in the service's JSDoc):

- `IdentitySnapshot` (`packages/database/src/auth-live.ts`) expects `Database`: session reads run in the caller's ambient Database transaction.
- `ContentManagement` (`packages/domain/src/content/service.ts`) expects `Organization`: the capability topology gives ContentManagement no layer dependency, so the composition root supplies Organization to every operation.
- `PersonSecurity` and `PersonOrServiceSecurity` (`packages/http-api/src/common.ts`) expect `HttpServerRequest`, `ParsedSearchParams`, and `RouteContext`: HttpApiMiddleware security handlers run per request.

`// oxlint-disable-next-line` comments:

- `effecttsgo/any-unknown-in-error-context` in `nativeRouterWebHandler` (`apps/backend/src/router.ts`): Effect types the failure of `HttpRouter.asHttpEffect()` as `unknown`, and `HttpEffect.toWebHandler` renders every failure cause as a response. The backend entry point and the tools rehearsals build their native web handler only through this function.
- `effecttsgo/unsafe-effect-type-assertion` in `problemMapper` (`apps/backend/src/http-api/problem.ts`): each failure tag maps to the problem type its case returns, and TypeScript cannot index the generic `Cases` by the failure tag, so the mapped error channel is asserted once. `unreachable` in the same file narrows with `Effect.catchIf` instead.

## Done when

1. `just lint` reports zero `effecttsgo/*` findings, and every preset rule is `"error"`; reintroducing one site fails `just lint` (negative control recorded in the commit message).
2. `just check-types` prints no Effect diagnostic.
3. The lint hook, `just check`, and the hosted Checks and Tests workflows pass on the final commit; the hook's lint time is measured and recorded.

## Remaining steps

Slices A, B, and C run in separate worktrees. A slice that stops before it is done commits its work in progress and lists its remaining packages here.

Slice D is done. Type-aware lint of `apps/dashboard` and `apps/homepage` depends on the `react-router typegen` output (`.react-router/`, ignored by Git). Without it, `Route.*Args` resolve to error types, and the rules see `any` (for example, `prefer-typed-schema-decoder` then reports form values as already typed). Both states have zero D findings. Slice W runs `react-router typegen` before type-aware lint, as `check-types` does, so the result does not depend on the local checkout.

The D fixes follow these forms:

- Failure channels: an explicit error union or inference instead of `unknown`; `EffectSdkFailure<Group, Operation>` (`@vektorprogrammet/sdk/effect`) for a generated SDK operation; a `Data.TaggedError` instead of the global `Error`.
- Combinators: `Effect.orElseSucceed`, `Effect.mapError`, `Effect.ignore`, and `Effect.asVoid` for the `Effect.catch` and `Effect.map` forms; `Result.try` for synchronous `try/catch` in a generator; one `Effect.provide` of merged layers.
- Values: `Struct.assign` where a class instance is copied into a plain object; an explicit comparator that keeps the previous order (`Order.String`, or a numeric difference); an arrow or `bind` for an unbound method.
- Text: a precise type instead of `String(unknown)`; `formText` (`apps/dashboard/app/lib/form-text.ts`) for a form field; objects instead of mixed-type tuples in JavaScript files; `new Request(input).url` and `new Response(body).json()` in fetch doubles.

Slice E2 (`apps/backend`, counted with the wiring configuration of `build/effect-lint-errors-0926`) stopped at 430 of 450 findings. Done: every `prefer-schema-over-json` site in HTTP handlers (through `jsonText` in `apps/backend/src/http-api/problem.ts`, which encodes with `Schema.fromJsonString(Schema.Unknown)` and so writes the bytes `JSON.stringify` wrote), the `instance-of-schema` sites in `admission/http-context.ts` and `http-api/transport.ts`, and both `unsafe-effect-type-assertion` sites. `@effect/vitest` is a backend devDependency; backend tests use `it.live` for PostgreSQL, HTTP, filesystem, timer, and clock tests and `it.effect` for pure ones, as slice E1 does. Remaining, in order:

1. Receipt file custody (82 findings): make `ReceiptFileStore` Effect-returning on Effect `FileSystem`/`Path` in `receipt/filesystem.ts`, `r2.ts`, `import-snapshot.ts`, and `reviewed-import.ts`. Also convert `payment-account.ts` (`Data.TaggedError` whose `message` getter returns the code), `outbox-drain.ts`, `drain-main.ts` (`Config`), their unit tests, and the call sites in `tools/e2e/run-legacy-receipt-{import,rehearsal}.ts`, `tools/e2e/legacy-receipt-snapshot.ts`, and `tools/verification/receipt-import-rehearsal.ts`. Keep every safety property: `wx` with mode 0o600, fsync before link and rename, the EEXIST-tolerant hard-link reservation, the EXDEV copy fallback, and the realpath containment check. Match `NotFound` and `AlreadyExists` with `Effect.catchReason("PlatformError", …)`; EXDEV is `Unknown`, and its Node error is the reason's cause. The one planned suppression is `effecttsgo/node-builtin-import` on the `O_NOFOLLOW` open in `import-snapshot.ts`: `FileSystem.open` has no such flag.
2. Delivery transport (29 findings): move `deliverJson` to Effect `HttpClient`, remove `DeliveryFetch`, and update its consumers, `mail/http.ts` (a permanent rejection is a 4xx `HttpDeliveryFailure` status), `onboarding/delivery.ts` (`Crypto.Crypto`), `password-recovery/drain-main.ts` (`Config`), the application, receipt delivery, and Cloudflare mail tests (`HttpClient.make` fakes), and the tools call sites. Keep the request identical to today: `FetchHttpClient.RequestInit` `{ redirect: "error" }` around the execute, and `HttpClient.TracerPropagationEnabled` false so that no `traceparent` or `b3` header is added. Discard the body unread with `Effect.scoped(Stream.toPull(response.stream))`, whose finalizer cancels the reader; verify this at runtime.
3. After slice E1 lands its Effect-returning Identity and AuthEngine interfaces (`b846b919` on `refactor/effect-diagnostics-e1-0926`, whose backend callers migrate in step 1 of E1's remaining steps): `router.ts` (`BackendAuthHandler` methods return `Effect<…, IdentityEngineError>`, `backendHttpHandler` and `internalBackendHttpHandler` return `Effect<Response>`, and `main.ts` runs them once in `Bun.serve`), the `instance-of-schema` sites in `router.ts`, `authority.ts`, and `http-api/system.ts`, `global-date` in `authority.ts`, and `main.ts` (`process.env` through `Config`, the shutdown sequence as an Effect program).
4. Small sites: `onboarding/http.ts:365` (`Crypto.Crypto` `randomUUIDv4`, with `BunCrypto.layer` in the test platform layer), `organization/http.ts` `readBoundedText` (the reader loop of `http-api/read-json.ts`), and `profile/http.ts:174` (parse with `Schema.fromJsonString(Schema.Unknown)`, then decode the patch, so the errors stay `request.malformed` and `validation.failed`).
5. Test harness and tests: `apps/backend/test/postgres.ts` and `test/database.ts` return Effects (a `ManagedRuntime` owns the per-file cluster; the per-test database is released in `afterEach`), `src/test/native-http.ts` serves each request with `Effect.acquireUseRelease` around `HttpRouter.toWebHandler`, and every `*.test.ts` body becomes `it.live`/`it.effect` (311 `async-function` sites and the test `global-date`, `new-promise`, and `node-builtin-import` sites). `apps/backend/test/runtime.ts` is deleted when its last caller is converted.

Slice E3 is done. Its fixes follow these forms:

- Errors: `Data.TaggedError` with the previous tag, codes, and message (a `message` getter where the message derives from fields); construction sites pass one object.
- Platform: `DomainFileSystem` fails with `PlatformError` and runs on the Effect `FileSystem` and `Path` services (`@effect/platform-bun` layers), which also write the OpenAPI projection and read the D1 migration.
- Programs: `Effect.gen` instead of async functions; `Effect.exit` with `Cause.squash` where a test or proof observes a failure; `Deferred` and forked fibers instead of hand-built promises; a scoped layer instead of a mutable module runtime; `Effect.abortSignal` for a test's request lifetime.
- Values: `Schema.fromJsonString` (with `space: 2` for the reports) instead of `JSON`; `DateTime` and `normalizeRfc3339Instant` instead of the `Date` constructor; `canonicalJson` to compare row snapshots; `Console.log` in the examples.
