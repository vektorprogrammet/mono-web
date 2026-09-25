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
      files: [
        "packages/database/src/**/!(*.test|*.spec|*-main|*-cli).ts",
        "packages/placements/src/server/**/!(*.test|*.spec).ts",
      ],
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
      files: ["packages/placements/src/!(*.test|*.spec).ts"],
      role: "effect-library",
      platform: "portable",
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
      files: [
        "apps/dashboard/app/lib/preview-*.test.ts",
        "apps/dashboard/app/foldkit/dated-school-service/view.test.ts",
      ],
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
        "packages/database/runtime/**/*-main.ts",
        "tools/verification/**/!(*.test).ts",
        "tools/e2e/legacy-candidate-native-journey.ts",
        "packages/database/src/**/*-cli.ts",
      ],
      role: "composition-root",
      platform: "node",
      strictness: "recommended",
    }),
  ],
} satisfies ExpandInput;

// Export maps own package access; these restrictions also close relative-import bypasses.
const crossPackageSourceImportMessage =
  "Import another workspace package through its export map, not its source path.";

const crossPackageSourceImportPatterns = [
  {
    regex: "^(\\./)?(\\.\\./)+([^./][^/]*/)?[^./][^/]*/src(/|$)",
    message: crossPackageSourceImportMessage,
  },
];

// Same boundary without the SDK, whose export map resolves to built `dist/` unless the source condition is set.
const crossPackageSourceImportPatternsExceptSdk = [
  {
    regex:
      "^(\\./)?(\\.\\./)+(apps/[^/]+|tools/[^/]+|packages/(database|domain|http-api|placements)|[^./][^/]*)/src(/|$)",
    message: crossPackageSourceImportMessage,
  },
];

const productImportPatterns = [
  ...crossPackageSourceImportPatterns,
  {
    regex: "(^|/)tools/(verification|preview-host|e2e)(/|$)",
    message: "Product code must not depend on verification executables.",
  },
];

const placementPublicImportPatterns = [
  {
    regex: "(^|/)placements/(src|domain|adapters)(/|$)",
    message: "Use the Placements package export, not another module’s source path.",
  },
];

const browserImportPatterns = [
  {
    regex:
      "(^|/)(database|pg|postgres)(/|$)|^@effect/sql-pg($|/)|^effect/unstable/sql($|/)|^@vektorprogrammet/placements/server($|/)|(^|/)placements/(src/)?server(/|$)",
    message: "Browser-safe modules must not import PostgreSQL adapters.",
  },
];

const expandedEffectConfig = expandDomains(effectConfig);

export default defineConfig({
  ...expandedEffectConfig,
  jsPlugins: [
    ...expandedEffectConfig.jsPlugins,
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
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
      files: ["apps/*/src/**", "apps/dashboard/app/**", "packages/*/src/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: productImportPatterns }],
      },
    },
    {
      files: [
        "apps/*/src/**",
        "apps/dashboard/app/**",
        "packages/{domain,database,http-api,sdk}/src/**",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [...productImportPatterns, ...placementPublicImportPatterns] },
        ],
      },
    },
    {
      files: ["tools/{verification,preview-host,e2e}/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [...crossPackageSourceImportPatterns, ...placementPublicImportPatterns] },
        ],
      },
    },
    {
      files: [
        "apps/homepage/src/**",
        "apps/dashboard/app/**",
        "packages/{domain,http-api,sdk}/src/**",
        "packages/placements/src/*.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              ...productImportPatterns,
              ...placementPublicImportPatterns,
              ...browserImportPatterns,
            ],
          },
        ],
      },
    },
    {
      files: ["packages/placements/src/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              ...productImportPatterns,
              ...browserImportPatterns,
              {
                regex: "^\\./server(/|\\.)",
                message: "Portable Placements contracts must not import their server adapter.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["apps/backend/src/main.ts", "tools/e2e/legacy-candidate-native-journey.ts"],
      rules: {
        // These Bun composition roots combine platform-bun with Node-compatible process APIs.
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
    // Source-import exemptions. Each entry names why an export-map import is not yet possible.
    {
      // No package manifest: Bun's isolated linker gives these scripts no workspace dependencies.
      files: ["tools/preview-host/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: placementPublicImportPatterns }],
      },
    },
    {
      // Bun resolves the SDK to built `dist/` without `--conditions=@vektorprogrammet/source`; these drivers import its source.
      files: [
        "tools/e2e/placement-check.ts",
        "tools/verification/organization-import-rehearsal-main.ts",
        "tools/verification/receipt-import-rehearsal.ts",
        "tools/verification/receipt-reopen-observation.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              ...crossPackageSourceImportPatternsExceptSdk,
              ...placementPublicImportPatterns,
            ],
          },
        ],
      },
    },
    {
      // Parity evidence helpers have no export map, and the dashboard does not depend on parity.
      files: [
        "apps/dashboard/e2e/merge-runtime-evidence.mjs",
        "apps/dashboard/e2e/runtime-evidence-receipt.mjs",
      ],
      rules: { "no-restricted-imports": "off" },
    },
    {
      // Alchemy is outside the Bun workspace, with its own lockfile; this import is type-only.
      files: ["infra/alchemy/preview/apex-worker.ts"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
  ignorePatterns: [
    "apps/server/**",
    "tools/oxlint/anti-slop/**",
    "apps/docs/components/mdxcn/**",
    "**/build/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.react-router/**",
    "**/.wrangler/**",
  ],
});
