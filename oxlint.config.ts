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
      files: ["packages/domain/src/**/*.ts"],
      role: "effect-library",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["packages/database/src/**/*.ts"],
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
      files: ["packages/sdk/src/**/*.ts"],
      role: "effect-library",
      platform: "portable",
      strictness: "recommended",
    }),
    group({
      files: ["apps/backend/src/main.ts", "infra/**/*.ts", "scripts/**/*.ts"],
      role: "composition-root",
      platform: "node",
      strictness: "recommended",
    }),
    group({
      files: ["apps/backend/src/**/*.ts"],
      role: "runtime-adapter",
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
  ],
} satisfies ExpandInput;

export default defineConfig({
  ...expandDomains(effectConfig),
  ignorePatterns: [
    "apps/server/**",
    "**/build/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.react-router/**",
    "**/.wrangler/**",
  ],
});
