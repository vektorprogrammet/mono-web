import {
  antipattern,
  correctness,
  effectNative,
  recommended,
  style,
} from "@effect/tsgo/oxlint-presets";
import { defineConfig, type OxlintConfig } from "oxlint";
import {
  DEFAULT_PLUGIN_NAME,
  expandDomains,
  RULE_NAMES,
  type ExpandInput,
  type OxlintConfigFragment,
} from "@phibkro/oxlint-effect-plugin";

// Every Effect language-service rule that `@effect/tsgo` ships is an error: its correctness,
// antipattern, style, and effectNative presets. They need type information. The two React
// applications are the exception: apps/homepage and apps/dashboard keep the recommended and
// correctness rules without the effectNative ones, because React components and Playwright specs
// build on the platform APIs those rules replace.
const effectTsgoPresets = [recommended, correctness, antipattern, style, effectNative];

const reactApplicationFiles = ["apps/homepage/**", "apps/dashboard/**"];

const presetRules = (presets: ReadonlyArray<OxlintConfig>, severity: "error" | "off") =>
  Object.fromEntries(
    presets.flatMap((preset) => Object.keys(preset.rules ?? {})).map((rule) => [rule, severity]),
  );

// The Effect rules of the React applications: recommended and correctness, less effectNative.
const reactApplicationRules = () => {
  const kept = new Set(
    [recommended, correctness]
      .flatMap((preset) => Object.keys(preset.rules ?? {}))
      .filter((rule) => !Object.hasOwn(effectNative.rules ?? {}, rule)),
  );

  return Object.fromEntries(
    Object.keys(presetRules(effectTsgoPresets, "error")).map((rule) => [
      rule,
      kept.has(rule) ? "error" : "off",
    ]),
  );
};

// Bun implements these Node modules, and the Bun groups import them beside Bun's own modules.
// The rule admits extra modules but no globals, so these files import `process` and `Buffer` too.
const bunNodeModules = {
  "no-cross-runtime": {
    extraAllowedModules: [
      "node:assert/strict",
      "node:buffer",
      "node:child_process",
      "node:crypto",
      "node:events",
      "node:fs",
      "node:fs/promises",
      "node:http",
      "node:module",
      "node:net",
      "node:os",
      "node:path",
      "node:process",
      "node:timers/promises",
      "node:url",
    ],
  },
};

// Oxlint matches override globs without extglob support, so `!(…)` patterns match nothing.
// Groups therefore use plain globs, ordered from broad sources to narrow exceptions:
// the last matching group decides every Effect rule for a file (see `totalOverrides`).
const effectConfig = {
  technology: "effect-v4",
  groups: [
    {
      files: ["packages/domain/src/**/*.ts"],
      role: "effect-library",
      platform: "node",
      strictness: "strict",
    },
    {
      // Rows, stored documents, and migration files reach the database adapters as external data.
      files: ["packages/database/src/**/*.ts"],
      role: "runtime-adapter",
      platform: "node",
      boundaries: ["external-data"],
      strictness: "strict",
    },
    {
      files: ["packages/rpc/src/client.ts"],
      role: "effect-library",
      platform: "portable",
      strictness: "strict",
    },
    {
      // HTTP requests, provider responses, and stored files reach the backend adapters as external data.
      files: ["apps/backend/src/**/*.ts"],
      role: "runtime-adapter",
      platform: "node",
      boundaries: ["external-data"],
      strictness: "strict",
    },
    {
      files: ["packages/domain/src/placements/*.ts"],
      role: "effect-library",
      platform: "portable",
      strictness: "strict",
    },
    {
      files: [
        "packages/domain/src/organization/lifecycle.ts",
        "packages/domain/src/identity/access.ts",
        "packages/database/src/organization/lifecycle-postgres.ts",
        "packages/database/src/identity-access.ts",
      ],
      role: "effect-library",
      platform: "portable",
      strictness: "strict",
    },
    {
      // The script client builds its own runtime and runs each RPC for Promise callers.
      files: ["packages/rpc/src/script-client.ts"],
      role: "composition-root",
      platform: "portable",
      strictness: "strict",
    },
    {
      files: [
        "packages/database/runtime/**/*-main.ts",
        "packages/database/src/**/*-main.ts",
        "packages/database/src/**/*-cli.ts",
        // The Better Auth CLI loads this configuration as its program.
        "packages/database/src/auth-schema-generator.config.ts",
        "tools/acceptance/**/*.ts",
        "tools/verification/**/*.ts",
      ],
      role: "composition-root",
      platform: "node",
      strictness: "strict",
    },
    {
      files: ["**/*.test.ts", "**/*.spec.ts", "**/e2e/**/*.ts"],
      role: "test",
      platform: "node",
      strictness: "strict",
    },
    {
      files: [
        "apps/dashboard/app/lib/preview-*.test.ts",
        "apps/dashboard/app/foldkit/content/view.test.ts",
        "apps/dashboard/app/foldkit/dated-school-service/view.test.ts",
      ],
      role: "test",
      platform: "browser",
      strictness: "strict",
    },
    {
      files: ["apps/backend/src/test/**/*.ts", "packages/database/src/test-support/platform.ts"],
      role: "runtime-adapter",
      platform: "bun",
      boundaries: ["external-data"],
      strictness: "strict",
    },
    {
      // Bun runs these composition roots and the journey runtimes that they share.
      files: [
        "apps/backend/src/main.ts",
        "apps/backend/src/**/*-main.ts",
        "apps/docs/scripts/sync-pages.ts",
        "tools/acceptance/onboarding-check.ts",
        "tools/acceptance/password-recovery-check.ts",
        "tools/acceptance/substitute-outcome-check.ts",
        "tools/acceptance/recommendation-check.ts",
        "tools/e2e/golden-harness.ts",
        "tools/e2e/golden-harness-self-test.ts",
        "tools/e2e/golden-reimbursement.ts",
        "tools/e2e/legacy-candidate-native-journey.ts",
        "tools/e2e/legacy-organization-rehearsal-runtime.ts",
        "tools/e2e/public-application-outbox-driver.ts",
        "tools/e2e/receipt-delivery-sink.ts",
        "tools/e2e/record-native-recruitment-invitation-response.ts",
        "tools/e2e/record-native-recruitment-invitation.ts",
        "tools/e2e/run-legacy-*.ts",
        "tools/scripts/changelog.ts",
        "tools/scripts/land.ts",
        "tools/scripts/require-legacy-data-profile.ts",
        "tools/source-safety/src/check.ts",
        "tools/verification/completion-receipt-postgres-proof-main.ts",
        "tools/verification/current-assignment-cohort-cli.ts",
        "tools/verification/current-assignment-cohort-main.ts",
        "tools/verification/current-assignment-cohort-rehearsal.ts",
        "tools/verification/identity-cohort-rehearsal.ts",
        "tools/verification/organization-import-rehearsal-main.ts",
        "tools/verification/receipt-import-rehearsal.ts",
        "tools/verification/recommendation-preupgrade-fixture.ts",
      ],
      role: "composition-root",
      platform: "bun",
      strictness: "strict",
      ruleOptions: bunNodeModules,
    },
    {
      // Bun runs these suites, and the journeys take their file locks through Bun's FFI.
      files: [
        "tools/conventions/tests/*.test.ts",
        "tools/e2e/safe-file-io.ts",
        "tools/scripts/tests/*.test.ts",
        "tools/source-safety/tests/source-safety.test.ts",
      ],
      role: "test",
      platform: "bun",
      strictness: "strict",
      ruleOptions: bunNodeModules,
    },
  ],
} satisfies ExpandInput;

// `expandDomains` lists only the rules that apply to a group, so a rule enabled by an earlier,
// broader group would stay on for files of a later group where it does not apply.
// Turning every other plugin rule off in each override makes the last matching group total.
const totalOverrides = (fragment: OxlintConfigFragment): OxlintConfigFragment => ({
  ...fragment,
  overrides: fragment.overrides.map((override) => ({
    ...override,
    rules: {
      ...Object.fromEntries(RULE_NAMES.map((name) => [`${DEFAULT_PLUGIN_NAME}/${name}`, "off"])),
      ...override.rules,
    },
  })),
});

// Export maps own package access; these restrictions also close relative-import bypasses.
const crossPackageSourceImportMessage =
  "Import another workspace package through its export map, not its source path.";

const crossPackageSourceImportPatterns = [
  {
    regex: "^(\\./)?(\\.\\./)+([^./][^/]*/)?[^./][^/]*/src(/|$)",
    message: crossPackageSourceImportMessage,
  },
];

const productImportPatterns = [
  ...crossPackageSourceImportPatterns,
  {
    regex: "(^|/)tools/(verification|acceptance|e2e)(/|$)",
    message: "Product code must not depend on verification executables.",
  },
];

const browserImportPatterns = [
  {
    regex: "(^|/)(database|pg|postgres)(/|$)|^@effect/sql-pg($|/)|^effect/unstable/sql($|/)",
    message: "Browser-safe modules must not import PostgreSQL adapters.",
  },
];

const expandedEffectConfig = totalOverrides(expandDomains(effectConfig));

// Effect.provide belongs at an entry point, which the rule cannot recognise itself: its
// documentation asks to disable it there. The entry points are the files that `effectConfig`
// declares as composition roots or tests, and the backend test harness that serves them.
const entryPointFiles = [
  ...new Set(
    effectConfig.groups
      .filter((group) => group.role === "composition-root" || group.role === "test")
      .flatMap((group) => group.files),
  ),
  "apps/backend/src/test/**/*.ts",
  // The proofs, rehearsals, and examples of the domain and database packages run as programs, and
  // the runtimes they share provide each proof its own database or platform.
  "packages/domain/runtime/**/*.ts",
  "packages/database/runtime/**/*.ts",
  "packages/database/examples/**/*.ts",
  "packages/database/src/receipt/file-proof.ts",
  "packages/database/src/rule-reconciliation-migration-postgres-proof.ts",
];

export default defineConfig({
  ...expandedEffectConfig,
  extends: effectTsgoPresets,
  options: { typeAware: true },
  // Oxlint's correctness rules, the type-aware ones included, are errors like every other rule.
  categories: { correctness: "error" },
  jsPlugins: [
    ...expandedEffectConfig.jsPlugins,
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    ...presetRules(effectTsgoPresets, "error"),
    "no-restricted-imports": ["error", { patterns: crossPackageSourceImportPatterns }],
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    // Clusters start only through startDisposablePostgres in tools/postgres, which gates readiness.
    "anti-slop/no-hand-rolled-postgres": "error",
    "anti-slop/no-json-text-parameter": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    // The RPC client posts with a trailing slash and a probe without; paths go through the predicates.
    "anti-slop/no-rpc-path-comparison": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    ...expandedEffectConfig.overrides,
    {
      files: ["apps/*/src/**", "apps/dashboard/app/**", "packages/*/src/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: productImportPatterns }],
      },
    },
    {
      files: ["apps/homepage/src/**", "apps/dashboard/app/**", "packages/{domain,rpc}/src/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [...productImportPatterns, ...browserImportPatterns],
          },
        ],
      },
    },
    // Source-import exemptions. Each entry names why an export-map import is not yet possible.
    {
      // No package manifest: Bun's isolated linker gives these scripts no workspace dependencies.
      files: ["tools/acceptance/**"],
      rules: {
        "no-restricted-imports": "off",
      },
    },
    {
      // Advisory locks go through lockAdvisory, whose registered keys own the lock identity.
      files: ["apps/**", "packages/**"],
      rules: { "anti-slop/no-raw-advisory-lock-sql": "error" },
    },
    {
      // The construct owns the advisory-lock SQL.
      files: ["packages/database/src/advisory-lock.ts"],
      rules: { "anti-slop/no-raw-advisory-lock-sql": "off" },
    },
    {
      // SQL shifts instants by elapsed time or in a named zone, never by calendar days in the
      // session TimeZone (migration 0077).
      files: ["apps/**", "packages/**", "tools/**"],
      rules: { "anti-slop/no-zoneless-calendar-interval": "error" },
    },
    {
      // The rule's own cases, the upgrade proof that replays the statements before migration
      // 0077, and the schema check's planted calendar shifts hold the pattern on purpose.
      files: [
        "tools/oxlint/anti-slop/rules/no-zoneless-calendar-interval.test.ts",
        "packages/database/src/oauth-refresh-window.test.ts",
        "packages/database/src/schema-calendar-arithmetic.test.ts",
      ],
      rules: { "anti-slop/no-zoneless-calendar-interval": "off" },
    },
    {
      // The definition of the RPC endpoint predicates compares the paths it names.
      files: ["packages/rpc/src/api.ts"],
      rules: { "anti-slop/no-rpc-path-comparison": "off" },
    },
    {
      // Unit leadership decides authority only through the reach interpreter (O8-11).
      files: ["apps/*/src/**", "apps/dashboard/app/**", "packages/*/src/**"],
      rules: { "anti-slop/no-leadership-reach": "error" },
    },
    {
      // The interpreter reads leadership; the Organization adapters persist and project it; tests
      // construct projections.
      files: [
        "packages/domain/src/authz/reach.ts",
        "packages/database/src/organization/authority-postgres.ts",
        "packages/database/src/organization/lifecycle-postgres.ts",
        "packages/database/src/organization/postgres.ts",
        "packages/database/src/organization/reviewed-cohort.ts",
        "packages/database/src/test-support/**",
        "packages/database/src/**/*-main.ts",
        "**/*.test.ts",
      ],
      rules: { "anti-slop/no-leadership-reach": "off" },
    },
    {
      // Raw node-postgres files, pending Effect-SQL migration. Remove an entry when its file
      // moves to Effect SQL and lockAdvisory; do not add a raw-pg twin of the construct.
      files: [
        "packages/database/runtime/service-principal-grants-postgres-tracer-main.ts",
        "packages/database/src/historical-service-cohort.ts",
        "packages/database/src/identity-cohort.ts",
        "packages/database/src/oauth-live.ts",
        "packages/database/src/organization/reviewed-cohort.ts",
        "packages/database/src/password-recovery.ts",
        "packages/database/src/person-cohort.ts",
        "packages/database/src/placements/current-assignment-cohort.ts",
        "packages/database/src/service-principal-grants-live.ts",
      ],
      rules: { "anti-slop/no-raw-advisory-lock-sql": "off" },
    },
    {
      // Journey fixtures derive window bounds from tools/e2e/journey-clock.ts, so none expires.
      // Hosted journeys run in a depth-1 checkout, so journey code reads no Git history.
      // Journeys reserve ports through reserveLoopbackPorts in tools/postgres, never by a probe.
      // Journeys serve a build of the current source, never a Vite dev server.
      files: [
        "apps/*/e2e/**",
        "apps/*/playwright*.config.ts",
        "tools/e2e/**",
        "tools/acceptance/**",
        "tools/verification/**",
        "tools/postgres/**",
      ],
      rules: {
        "anti-slop/no-literal-window-instant": "error",
        "anti-slop/no-git-history": "error",
        "anti-slop/no-port-probe": "error",
        "anti-slop/no-dev-server": "error",
      },
    },
    {
      // The interactive organization preview (ORGANIZATION_LIFECYCLE_PREVIEW) edits live source
      // and runs no test, so it keeps a dev server; the journey in the same runner serves the build.
      files: ["apps/dashboard/e2e/run-real-native-organization-administration.mjs"],
      rules: { "anti-slop/no-dev-server": "off" },
    },
    {
      // Foldkit views key each per-entry element whose controls dispatch messages built from the
      // entry, so a reorder never moves one entry's commands onto another (hosted run 36240534206).
      files: ["apps/dashboard/app/foldkit/**"],
      rules: { "anti-slop/no-unkeyed-command-row": "error" },
    },
    {
      // No type checker reads plain JavaScript, so an unimported name in a .mjs file reaches CI only as a runtime
      // ReferenceError (Order in the schools runner, hosted run 36260017312). Bun names its globals.
      files: ["**/*.mjs"],
      env: { node: true, browser: true, es2024: true },
      globals: { Bun: "readonly", HTMLRewriter: "readonly" },
      rules: { "no-undef": "error" },
    },
    { files: entryPointFiles, rules: { "effecttsgo/strict-effect-provide": "off" } },
    // Last, so no broader group decides the Effect rules of the React applications.
    { files: reactApplicationFiles, rules: reactApplicationRules() },
  ],
  ignorePatterns: [
    "tools/oxlint/anti-slop/**",
    "apps/docs/components/mdxcn/**",
    "**/build/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.react-router/**",
    "**/.wrangler/**",
  ],
});
