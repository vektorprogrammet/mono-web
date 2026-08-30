import { Effect } from "effect";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeRuntimeLayer } from "../node-runtime.js";
import { canonicalJson, sha256 } from "../src/canonical.js";
import { collectC2 } from "../src/effects.js";
import { createManifestContextFromSnapshots } from "../src/source-manifest.js";
import { scanRootEffect } from "../src/runtime.js";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures/integration-scanner");

test("preview workers resolve lexical owners and outbound integration contracts", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-integration-scanner-legacy-");
  const monoRoot = mkdtempSync("/tmp/parity-integration-scanner-mono-");
  const fixturePaths = [
    ["worker.ts", "infra/alchemy/preview/worker.ts"],
    ["apex-worker.ts", "infra/alchemy/preview/apex-worker.ts"],
  ] as const;

  try {
    for (const [fixturePath, targetPath] of fixturePaths) {
      const target = join(monoRoot, targetPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(FIXTURE_ROOT, fixturePath), "utf8"), "utf8");
    }
    const declarationPath = join(monoRoot, "packages/declarations.ts");
    mkdirSync(dirname(declarationPath), { recursive: true });
    writeFileSync(
      declarationPath,
      "export function fetch(request: Request): Request { return request }\nexport class GoogleClient { fetch(request: Request): Request { return request } }\n",
      "utf8",
    );

    const [legacy, mono] = await Promise.all([
      Effect.runPromise(
        scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      ),
      Effect.runPromise(scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer))),
    ]);
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = collectC2(context, sha256("preview-worker-integration-regression"));
    const rowsByPath = new Map(
      fixturePaths.map(([, path]) => [
        path,
        result.integrations.rows.filter((row) =>
          row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === path),
        ),
      ]),
    );
    const workerRows = rowsByPath.get("infra/alchemy/preview/worker.ts") ?? [];
    const apexRows = rowsByPath.get("infra/alchemy/preview/apex-worker.ts") ?? [];
    const regressionRows = [...workerRows, ...apexRows];

    expect(workerRows).toHaveLength(3);
    expect(
      workerRows
        .map((row) => row.details)
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right), "en", { sensitivity: "variant" }),
        ),
    ).toEqual(
      [
        {
          provider_ref: "cloudflare-containers",
          direction: "outbound",
          protocol: "http",
          endpoint_ref: null,
          credential_slot_ref: null,
          call_site_ref: "infra/alchemy/preview/worker.ts#fetch",
          contract_ref: null,
          effect_classes: ["outbound"],
        },
        {
          provider_ref: "cloudflare-service-binding:Dashboard",
          direction: "outbound",
          protocol: "http",
          endpoint_ref: null,
          credential_slot_ref: null,
          call_site_ref: "infra/alchemy/preview/worker.ts#fetch->env.Dashboard.fetch",
          contract_ref: null,
          effect_classes: ["outbound"],
        },
        {
          provider_ref: "cloudflare-service-binding:Homepage",
          direction: "outbound",
          protocol: "http",
          endpoint_ref: null,
          credential_slot_ref: null,
          call_site_ref: "infra/alchemy/preview/worker.ts#fetch->env.Homepage.fetch",
          contract_ref: null,
          effect_classes: ["outbound"],
        },
      ].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right), "en", { sensitivity: "variant" }),
      ),
    );

    expect(apexRows).toHaveLength(3);
    expect(
      apexRows.map((row) => ({
        provider_ref: "provider_ref" in row.details ? row.details.provider_ref : null,
        endpoint_ref: "endpoint_ref" in row.details ? row.details.endpoint_ref : null,
        call_site_ref: "call_site_ref" in row.details ? row.details.call_site_ref : null,
        effect_classes: "effect_classes" in row.details ? row.details.effect_classes : [],
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          provider_ref: "BACKEND_ORIGIN",
          endpoint_ref: "https://origin-api.example.test",
          call_site_ref: "infra/alchemy/preview/apex-worker.ts#fetch->BACKEND_ORIGIN",
          effect_classes: ["outbound"],
        },
        {
          provider_ref: "cloudflare-service-binding:Homepage",
          endpoint_ref: null,
          call_site_ref: "infra/alchemy/preview/apex-worker.ts#fetch->env.Homepage.fetch",
          effect_classes: ["outbound"],
        },
        {
          provider_ref: "cloudflare-service-binding:Dashboard",
          endpoint_ref: null,
          call_site_ref: "infra/alchemy/preview/apex-worker.ts#fetch->env.Dashboard.fetch",
          effect_classes: ["outbound"],
        },
      ]),
    );
    expect(regressionRows.every((row) => row.status !== "duplicate")).toBe(true);
    expect(regressionRows.every((row) => !row.reason_codes.includes("UNKNOWN_INTEGRATION"))).toBe(
      true,
    );
    expect(
      result.failures.some(
        (failure) =>
          failure.reasonCode === "DUPLICATE_CANONICAL_IDENTITY" &&
          failure.rowIds.some((rowId) => regressionRows.some((row) => row.row_id === rowId)),
      ),
    ).toBe(false);
    expect(
      result.integrations.rows.filter((row) =>
        row.source_ref_ids.some(
          (ref) => context.sourcePathById.get(ref)?.path === "packages/declarations.ts",
        ),
      ),
    ).toEqual([]);
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
    rmSync(monoRoot, { recursive: true, force: true });
  }
});

test("loopback-only guards require structural proof and preserve every near miss", async () => {
  const collectFixtures = async (
    fixturePaths: readonly (readonly [fixturePath: string, targetPath: string])[],
  ) => {
    const legacyRoot = mkdtempSync("/tmp/parity-integration-loopback-legacy-");
    const monoRoot = mkdtempSync("/tmp/parity-integration-loopback-mono-");
    try {
      for (const [fixturePath, targetPath] of fixturePaths) {
        const target = join(monoRoot, targetPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(FIXTURE_ROOT, fixturePath), "utf8"), "utf8");
      }
      const [legacy, mono] = await Promise.all([
        Effect.runPromise(
          scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
        ),
        Effect.runPromise(scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer))),
      ]);
      const context = createManifestContextFromSnapshots(legacy, mono);
      return {
        context,
        result: collectC2(context, sha256("loopback-integration-boundary-regression")),
      };
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
      rmSync(monoRoot, { recursive: true, force: true });
    }
  };

  const guardedPath = "packages/runtime/loopback-guard.ts";
  const remotePath = "packages/runtime/unguarded-network.ts";
  const baseline = await collectFixtures([
    ["loopback-guard.ts", guardedPath],
    ["unguarded-network.ts", remotePath],
  ]);
  const baselineRowsFor = (path: string) =>
    baseline.result.integrations.rows.filter((row) =>
      row.source_ref_ids.some((ref) => baseline.context.sourcePathById.get(ref)?.path === path),
    );
  expect(baselineRowsFor(guardedPath)).toEqual([]);
  expect(baselineRowsFor(remotePath)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "unresolved",
        reason_codes: expect.arrayContaining(["UNKNOWN_INTEGRATION"]),
        details: expect.objectContaining({
          endpoint_ref: "https://api.example.test/remote",
          protocol: "https",
        }),
      }),
    ]),
  );

  const nearMissFixtures = [
    "shadowed-fetch.ts",
    "imported-fetch.ts",
    "property-fetch.ts",
    "public-allowlist.ts",
    "string-guard.ts",
    "comment-guard.ts",
    "dead-guard.ts",
    "nested-guard.ts",
    "nonexecuting-rejection.ts",
    "unguarded-admission.ts",
  ] as const;
  for (const fixturePath of nearMissFixtures) {
    const targetPath = `packages/runtime/${fixturePath}`;
    const nearMiss = await collectFixtures([[fixturePath, targetPath]]);
    const rows = nearMiss.result.integrations.rows.filter((row) =>
      row.source_ref_ids.some(
        (ref) => nearMiss.context.sourcePathById.get(ref)?.path === targetPath,
      ),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unresolved",
          reason_codes: expect.arrayContaining(["UNKNOWN_INTEGRATION"]),
          details: expect.objectContaining({
            protocol: "http",
          }),
        }),
      ]),
    );
  }
});
