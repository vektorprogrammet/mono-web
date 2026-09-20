import { defineConfig } from "oxlint";
import { expandDomains, type ExpandInput, type RuleName } from "@phibkro/oxlint-effect-plugin";

const advisorySeverity = Object.fromEntries(
  [
    "no-ambient-console",
    "no-ambient-authority",
    "no-cross-runtime",
    "no-premature-execution",
    "no-native-promise-control-flow",
    "no-raw-json-parse",
    "no-untyped-throw",
  ].map((rule) => [rule, "warn"]),
) as Record<RuleName, "warn">;

const group = <T extends Omit<ExpandInput["groups"][number], "severityOverrides">>(
  input: T,
): T & { readonly severityOverrides: Record<RuleName, "warn"> } => ({
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
    group({
      files: ["packages/parity-inventory/src/**/*.ts"],
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
      files: ["infra/**/*.ts", "scripts/**/*.ts"],
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
        "infra/alchemy/scripts/docs-cli.test.ts",
        "packages/parity-inventory/tests/claim-evidence.test.ts",
        "packages/parity-inventory/tests/cli-contract.test.ts",
        "packages/parity-inventory/tests/convention-alias.test.ts",
        "packages/parity-inventory/tests/journey-evidence.test.ts",
        "packages/parity-inventory/tests/legacy-journey-evidence.test.ts",
        "packages/parity-inventory/tests/unsafe-diagnostics.test.ts",
      ],
      rules: {
        // Bun owns these exact suites; they deliberately exercise Node-compatible filesystem seams.
        "effect/no-cross-runtime": "off",
      },
    },
    {
      files: ["infra/host/password-recovery-check.ts", "scripts/changelog.ts"],
      rules: {
        // These Bun entrypoints intentionally use Bun-native lifecycle APIs beside Node compatibility APIs.
        "effect/no-cross-runtime": "off",
      },
    },
  ],
  ignorePatterns: [
    "apps/server/**",
    "**/build/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.react-router/**",
    "**/.wrangler/**",
  ],
});
