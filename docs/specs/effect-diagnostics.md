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
| E1 | `effectNative` rules in `packages/database` (`async-function` 376 and the rest) | 489 | In progress: 354 left on `6fd23eb9` (branch `refactor/effect-diagnostics-e1-0926`); see Remaining steps |
| E2 | `effectNative` rules in `apps/backend` | 450 on `282da16f` | In progress: 243 left after the delivery transport (branch `refactor/effect-diagnostics-e2c-0926`); see Remaining steps |
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
- `effecttsgo/node-builtin-import` on the `node:fs/promises` import of `apps/backend/src/receipt/import-snapshot.ts`: Effect `FileSystem.open` has no `O_NOFOLLOW` flag, and the snapshot reader must refuse a symlink that replaces the checked path at open time.

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

Slice E2 (`apps/backend`, counted with the wiring configuration of `build/effect-lint-errors-0926`) stands at 243 of 450 findings. Done: every `prefer-schema-over-json` site in HTTP handlers (through `jsonText` in `apps/backend/src/http-api/problem.ts`, which encodes with `Schema.fromJsonString(Schema.Unknown)` and so writes the bytes `JSON.stringify` wrote), the `instance-of-schema` sites in `admission/http-context.ts` and `http-api/transport.ts`, both `unsafe-effect-type-assertion` sites, and receipt file custody. `ReceiptFileStore` returns Effects: `makeReceiptFileStore` builds the local store on Effect `FileSystem` and `Path`, the R2 store wraps its bucket calls, and the store fails with `ReceiptFileStoreError`, which each caller maps to its previous outcome. `readSnapshotFile` fails with `ReceiptSnapshotFileRejected`, whose `reason` is the quarantine reason the importers record, and `PaymentAccountCustodyError` is a `Data.TaggedError` whose `message` is its code. The delivery transport is done too: `deliverJson` sends through Effect `HttpClient` with `FetchHttpClient.RequestInit` `{ redirect: "error" }` and `HttpClient.TracerPropagationEnabled` false, and discards the body with `Effect.scoped(Stream.toPull(response.stream))`. A probe against a raw socket found the request bytes equal to those of the former fetch transport, the body reader cancelled without a read, and the provider signal aborted when the timeout failure arrives. The consumers take the client when they are built: contact delivery, `HttpMailLive`, `ReceiptDeliveryLive`, and `HttpRecruitmentNotificationsLive` are layers that require `HttpClient`, `publicApplicationHttpEffects` and `schoolServiceNotificationDelivery` are Effects that return the interpreter, and `drainOnboardingDelivery` requires `HttpClient` and `Crypto`. Handlers reach both per request, so `main.ts` and the tools compositions provide the platform through `HttpRouter.provideRequest`, and `TestPlatform` adds `FetchHttpClient.layer` and `BunCrypto.layer`. `apps/backend/src/test/platform.ts` gives backend tests the Bun `FileSystem` and `Path`. The Bun composition roots that now select `BunServices` (`apps/backend/src/receipt/drain-main.ts` and `tools/e2e/run-legacy-{candidate-rehearsal,receipt-import,receipt-rehearsal}.ts`) join the `effect/no-cross-runtime` override for Bun composition roots in `oxlint.config.ts`; slice W keeps them there. `@effect/vitest` is a backend devDependency; backend tests run one Effect program each: `it.effect` for pure tests, `it.live` when a test reads real time, and `layer(L, { excludeTestServices: true })` for tests that need platform services, where `it.effect` runs with the live clock, as slice E1 does. Remaining, in order:

3. On E1's Effect-returning Identity and AuthEngine interfaces, whose callers E1 migrated (it also cleared the `instance-of-schema` sites in `authority.ts` and `http-api/system.ts` and the `global-date` site in `authority.ts`): `router.ts` (`BackendAuthHandler` methods return `Effect<…, IdentityEngineError>`, `backendHttpHandler` and `internalBackendHttpHandler` return `Effect<Response>`, and `main.ts` runs them once in `Bun.serve`), the `instance-of-schema` sites in `router.ts`, and `main.ts` (`process.env` through `Config`, the shutdown sequence as an Effect program).
4. Small sites (4 findings): `onboarding/http.ts:365` (`Crypto.Crypto` `randomUUIDv4`, with `BunCrypto.layer` in the test platform layer), `organization/http.ts` `readBoundedText` (the reader loop of `http-api/read-json.ts`), and `profile/http.ts:174` (parse with `Schema.fromJsonString(Schema.Unknown)`, then decode the patch, so the errors stay `request.malformed` and `validation.failed`).
5. Test harness and tests (228 findings): `apps/backend/test/postgres.ts` and `test/database.ts` return Effects (a `ManagedRuntime` owns the per-file cluster; the per-test database is released in `afterEach`), `src/test/native-http.ts` serves each request with `Effect.acquireUseRelease` around `HttpRouter.toWebHandler`, and every `*.test.ts` body becomes `it.live`/`it.effect` (311 `async-function` sites and the test `global-date`, `new-promise`, and `node-builtin-import` sites). `apps/backend/test/runtime.ts` is deleted when its last caller is converted.

Slice E3 is done. Its fixes follow these forms:

- Errors: `Data.TaggedError` with the previous tag, codes, and message (a `message` getter where the message derives from fields); construction sites pass one object.
- Platform: `DomainFileSystem` fails with `PlatformError` and runs on the Effect `FileSystem` and `Path` services (`@effect/platform-bun` layers), which also write the OpenAPI projection and read the D1 migration.
- Programs: `Effect.gen` instead of async functions; `Effect.exit` with `Cause.squash` where a test or proof observes a failure; `Deferred` and forked fibers instead of hand-built promises; a scoped layer instead of a mutable module runtime; `Effect.abortSignal` for a test's request lifetime.
- Values: `Schema.fromJsonString` (with `space: 2` for the reports) instead of `JSON`; `DateTime` and `normalizeRfc3339Instant` instead of the `Date` constructor; `canonicalJson` to compare row snapshots; `Console.log` in the examples.

### E1 (packages/database)

Count with the wiring configuration of `build/effect-lint-errors-0926`. Its override globs are relative to the configuration file, so a copy in another directory needs every repository glob prefixed with `**/`.

Done on the E1 branch:

- Identity, AuthEngineService, `OAuthCredentialAuthority.resolve`, OAuthClientOperator, and PasswordRecovery return Effects with typed failures (`IdentitySessionFailure`, `IdentityEngineError`, `OAuthClientOperatorError`). `resolve` and `resolveInTransaction` take `now?: DateTime.Utc`.
- `auth-live.ts`, `password-recovery.ts`, `oauth-live.ts`, `oauth-config.ts`, `auth-engine.ts`, `password-codec.ts`, and `service-principal-grants-live.ts` have no findings.
- `pg-pool.ts` holds `pgQuery`, `pgWithClient`, `pgTransaction`, and `PgQueryError` for the raw node-postgres modules.
- `makeBetterAuthCallbackRunner` (`auth-engine.ts`, construct category `runtime-bridge`) runs the Effect behind a Better Auth Promise callback in a fiber set of the engine layer's scope. The password-recovery callbacks, the credential lifecycle hooks, the access database hooks, and the password codec use it. A hook fails with the `APIError` it threw before; a raw rejection stays a defect, which the runner rejects with unchanged. better-call's `ctx.json` answers synchronously although its type is a Promise, so the hooks resolve it with `Promise.resolve`.
- The OAuth release barrier returns `Effect<Response>` and answers every failure and defect with the 503 `temporarily_unavailable` body (`Effect.catchCause`). `OAuthReleaseHandler` and `OAuthIntrospectionHandler` name the handler contracts; `AuthLive` maps introspection failures with `engineFailure`.
- The password codec keeps one running derivation per process and at most eight waiting ones (module `Semaphore`s, admission through `withPermitsIfAvailable`) and fails with the tagged `PasswordHashCapacityError` and `PasswordInputTooLongError`.
- Service-principal grants map every failure except `ServicePrincipalGrantAuthorityError` to the PersistenceFailure of the operation, including a persisted row outside its schema (`PersistedRowRejected`).
- Verification for the auth modules: the OAuth and service-principal grants tracer mains, the identity PostgreSQL proof (same evidence as before), and `auth-live.test.ts` with `AUTH_TEST_PG_URL`, each against a disposable cluster. The OAuth tracer's code exchange answers 503 on a cluster in a time zone with daylight saving time when the 30-day refresh window crosses a change (for example Europe/Oslo in late September): the check `absolute_expires_at = created_at + interval '30 days'` of `auth.oauth_refresh_families` adds calendar days in the session time zone. The code before E1 fails the same way; run the tracers with `TZ=UTC`.
- Test convention, agreed with E2: `@effect/vitest`, one Effect program per test (`it.effect`, or `it.live` when the code reads the clock), and `layer(L, { excludeTestServices: true, timeout })` for suite resources. The named form is required when the layer spans nested describes, because the anonymous form then builds inside the first test. `schools.test.ts` follows it.

Steps, in order:

1. Done: the interface callers. `authority.ts` and `http-api/system.ts` call Identity and `OAuthCredentialAuthority` directly and match `IdentitySessionNotFound` and `IdentitySessionExpired` by tag; `main.ts` and `tools/e2e/legacy-candidate-native-journey.ts` run the AuthEngine operations through their runtime; the Identity and `OAuthCredentialAuthority` mocks return Effects, and an unexpected call dies. Two tests lost their subject, because the Identity failure channel is typed: "maps an unknown session provider rejection" in `authority.schools.test.ts` and the "unknown provider failure" row in `router.test.ts`.
2. Done (`b73e2c06`): `oauth-live.ts` handlers and `oauth-config.ts`. `verifyOAuthBootState`, `inTransaction`, and `appendAuditAsync` are removed.
3. Done (`2a9fba0e`): `auth-engine.ts`, `password-codec.ts` and its test, and the callers in `apps/backend/src/onboarding/http.ts` (`Effect.orDie`, as `Effect.promise` did), `tools/verification/credential-race.ts`, and `identity-cohort-rehearsal.ts`. `onboarding-account.ts` needed no change.
4. Done (`6fd23eb9`): `service-principal-grants-live.ts`. Its test waits for the Effect form of `withPostgresTestDatabase` (step 6).
5. Cohorts: `cohort-cli.ts` and the three `*-cohort-cli.ts`, `organization/reviewed-cohort.ts`, `receipt/reviewed-cohort.ts`, the cohort tests and rehearsals, and every `tools/e2e` and `tools/verification` call site. `readPrivateCohortJson` keeps its atomic `O_RDONLY | O_NOFOLLOW` open, because effect `FileSystem.open` takes no `O_NOFOLLOW`. It needs one listed `effecttsgo/node-builtin-import` suppression. Tool call sites become `Effect.runPromise(...)`: it rejects with the squashed failure, so the `instanceof` assertions of the rehearsals keep working. The cohort failures follow the E3 error form, with a `message` getter that returns the code.
6. Migration readers: `migrations.ts`, `migration-registry.ts`, `migration-manifest-cli.ts`, `rule-reconciliation-migration-postgres-proof.ts`, and `test-support/postgres.ts`. `withPostgresTestDatabase` becomes `(use: (pool) => Effect) => Effect`. `effect/no-cross-runtime` admits `@effect/platform-bun` only in a composition root or a runtime adapter that declares platform bun. Lead decision: tests get FileSystem and Path from a runtime-adapter module of `packages/database` that declares platform bun in `oxlint.config.ts` (and in the wiring branch); the package itself stays node. `apps/backend/src/test/platform.ts` is the precedent.
7. The other tests, per the convention: `database.test.ts`, `migrations.test.ts`, `content.test.ts`, `outbox-lifecycle.test.ts`, `applicant-progress.test.ts`, `content/postgres.test.ts`, `team-application/service.test.ts`, `authz/delegation-postgres.test.ts`, the two `test-support/disposable-*-backfill.test.ts`, `placements/postgres.test.ts`, `onboarding.test.ts`, `service-principal-grants-live.test.ts`, the smaller tests, the dsl block of `auth-live.test.ts`, `password-recovery.test.ts`, and `test/runtime.ts`. `tools/verification` tests also import `test/runtime.ts`, so it either stays without its `async` function or moves with them.
8. `runtime/*` mains, and the small production sites: `receipt/outbox.ts`, `receipt/settlement.ts`, `receipt/postgres.ts`, `organization/lifecycle-postgres.ts`, `authz/delegation-postgres.ts`, `onboarding/postgres.ts`, `content/postgres.ts`, and `examples/placements-read-scopes.ts`.

After step 4 (`6fd23eb9`), 354 findings remain: 67 in `src` outside tests, 69 in `runtime/`, and 218 in tests.

Uncommitted sub-agent work for steps 5 and 7 lies in stash `e1-subagent-wip-0926` of the shared repository, and in `tmp/e1-subagent-wip.patch` of the E1 worktree. Its files have not changed on the branch since the stash base `40de8ee4`, so `git checkout 'stash@{N}' -- <file>` restores them unchanged:

- Complete: `database.test.ts`, which adds two `effect/no-cross-runtime` findings (see step 6); `person-cohort.ts`, `historical-service-cohort.ts`, and `placements/current-assignment-cohort.ts`. Their callers are not migrated.
- Partial: `identity-cohort.ts`, which needs two blank lines; `content.test.ts`, `outbox-lifecycle.test.ts`, and `applicant-progress.test.ts`; and the second sub-agent's seven test files.
