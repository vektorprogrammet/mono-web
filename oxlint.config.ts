import { defineConfig } from "oxlint";
import { expandDomains, type ExpandInput, type RuleName } from "@phibkro/oxlint-effect-plugin";

const advisorySeverity = {
  "no-ambient-console": "warn",
  "no-ambient-authority": "warn",
  "no-cross-runtime": "warn",
  "no-premature-execution": "warn",
  "no-native-promise-control-flow": "warn",
  "no-raw-json-parse": "warn",
  "no-untyped-throw": "warn",
} satisfies Partial<Record<RuleName, "warn">>;

const group = <T extends Omit<ExpandInput["groups"][number], "severityOverrides">>(
  input: T,
): T & { readonly severityOverrides: typeof advisorySeverity } => ({
  ...input,
  severityOverrides: advisorySeverity,
});

const effectConfig = {
  technology: "effect-v4",
  groups: [
    group({
      files: ["packages/domain/src/**/!(*.test|*.spec).ts"],
      role: "effect-library",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["packages/database/src/**/!(*.test|*.spec|*-main|*-cli).ts"],
      role: "runtime-adapter",
      platform: "node",
      strictness: "recommended",
    }),
    {
      files: [
        "packages/domain/src/organization/lifecycle.ts",
        "packages/domain/src/identity/access.ts",
        "packages/database/src/organization/lifecycle-postgres.ts",
        "packages/database/src/identity-access.ts",
      ],
      role: "effect-library",
      platform: "portable",
      strictness: "recommended",
      severityOverrides: { "no-ambient-authority": "error" },
    },
    group({
      files: ["tools/parity/src/**/*.ts"],
      role: "application",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["packages/sdk/src/**/!(*.test|*.spec).ts"],
      role: "effect-library",
      platform: "portable",
      strictness: "recommended",
    }),
    group({
      files: ["apps/backend/src/**/!(main|*.test|*.spec|*-main).ts"],
      role: "runtime-adapter",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["infra/**/*.ts", "scripts/**/*.ts", "tools/preview-host/**/*.ts"],
      role: "composition-root",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["**/*.test.ts", "**/*.spec.ts", "**/e2e/**/*.ts"],
      role: "test",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["apps/dashboard/app/lib/preview-*.test.ts"],
      role: "test",
      platform: "browser",
      strictness: "recommended",
    }),
    group({
      files: ["apps/backend/src/test/**/*.ts"],
      role: "runtime-adapter",
      platform: "bun",
      strictness: "recommended",
    }),
    group({
      files: [
        "apps/backend/src/main.ts",
        "apps/backend/src/**/*-main.ts",
        "packages/database/src/**/*-main.ts",
        "packages/database/src/**/*-cli.ts",
      ],
      role: "composition-root",
      platform: "node",
      strictness: "recommended",
    }),
  ],
} satisfies ExpandInput;

const expandedEffectConfig = expandDomains(effectConfig);

export default defineConfig({
  ...expandedEffectConfig,
  jsPlugins: [
    ...expandedEffectConfig.jsPlugins,
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
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
      files: ["apps/backend/src/main.ts"],
      rules: {
        // Bun's backend root intentionally combines platform-bun with Node-compatible process APIs.
        "effect/no-cross-runtime": "off",
      },
    },
    {
      files: [
        "apps/backend/src/native-operation.ts",
        "packages/database/src/oauth-live.ts",
        "packages/database/src/password-recovery.ts",
        "packages/sdk/src/effect-client.ts",
        "packages/sdk/src/promise.ts",
      ],
      rules: {
        // These named adapters are the explicit Effect-to-Promise or synchronous interoperability seam.
        "effect/no-premature-execution": "off",
      },
    },
    {
      files: [
        "tools/parity/tests/claim-evidence.test.ts",
        "tools/parity/tests/cli-contract.test.ts",
        "tools/parity/tests/convention-alias.test.ts",
        "tools/parity/tests/journey-evidence.test.ts",
        "tools/parity/tests/legacy-journey-evidence.test.ts",
        "tools/parity/tests/unsafe-diagnostics.test.ts",
      ],
      rules: {
        // Bun owns these exact suites; they deliberately exercise Node-compatible filesystem seams.
        "effect/no-cross-runtime": "off",
      },
    },
    {
      files: ["tools/preview-host/password-recovery-check.ts", "scripts/changelog.ts"],
      rules: {
        // These Bun entrypoints intentionally use Bun-native lifecycle APIs beside Node compatibility APIs.
        "effect/no-cross-runtime": "off",
      },
    },
  ],
  ignorePatterns: [
    "apps/server/**",
    "tools/oxlint/anti-slop/**",
    "**/build/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.react-router/**",
    "**/.wrangler/**",
  ],
});
