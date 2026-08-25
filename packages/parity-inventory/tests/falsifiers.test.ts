import { Effect } from "effect";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeRuntimeLayer } from "../node-runtime.js";
import { validateReportBundle, type ProjectionObservation } from "../src/schema.js";
import { collectApiOperations, type ApiCollection } from "../src/api.js";
import { collectRoutes } from "../src/routes.js";
import { hasDuplicateJsonMembers } from "../src/json-safety.js";
import {
  acceptedIntentRevisionRefId,
  loadAcceptedIntentRegister,
  type IntentSourceInput,
} from "../src/coverage.js";
import {
  createManifestContextFromSnapshots,
  effectiveIgnoreRule,
  finalizeManifest,
  isUnsafeSourcePath,
  sanitizeScalar,
  sourceTextSafetyReason,
  unsafeEnvSourceTextReason,
  unsafeScalarReason,
  unsafeSourceScalarReason,
  unsafeSqlSourceTextReason,
  unsafeSourceTextReason,
} from "../src/source-manifest.js";
import { COMMITTED_PROJECTIONS, run, type FalsifierId } from "../src/runner.js";
import { readPinnedIntentRegisterEffect, scanRootEffect } from "../src/runtime.js";
import {
  canonicalRuntimeEvidenceBytes,
  makeRuntimeEvidenceReceipt,
  makeRuntimeEvidenceRegister,
} from "../src/runtime-evidence.js";
import { canonicalJson, sha256 } from "../src/canonical.js";
const repoRoot = join(import.meta.dir, "../../..");

const falsifiers: readonly FalsifierId[] = [
  "F0_deterministic_replay",
  "F1_missing_required_source",
  "F2_source_hash_drift",
  "F3_duplicate_legacy_route",
  "F4_dead_unimported_source",
  "F5_missing_counterpart",
  "F6_extra_counterpart",
  "F7_method_path_mismatch",
];

describe("C0 and C1 fixture falsifiers", () => {
  for (const falsifierId of falsifiers) {
    test(`${falsifierId} uses the frozen synthetic fixture tree`, async () => {
      const result = await Effect.runPromise(
        run({
          root: `/tmp/functional-parity-missing-${falsifierId}`,
          legacyRoot: `/tmp/functional-parity-missing-legacy-${falsifierId}`,
          mode: "fixture_injection",
          falsifierId,
        }).pipe(Effect.provide(NodeRuntimeLayer)),
      );
      expect(result.exitCode).toBe(13);
      expect(result.report.status).toBe("falsifier_passed");
      expect(result.report.falsifier_id).toBe(falsifierId);
    });
  }

  for (const falsifierId of [
    "F8_openapi_stale",
    "F9_runtime_unavailable",
    "F10_static_runtime_mismatch",
    "F16_h3_authority_copy",
  ] as const) {
    test(`${falsifierId} preserves C1 authority boundaries`, async () => {
      const result = await Effect.runPromise(
        run({ root: ".", legacyRoot: ".", mode: "fixture_injection", falsifierId }).pipe(
          Effect.provide(NodeRuntimeLayer),
        ),
      );
      expect(result.exitCode).toBe(13);
      expect(result.report.status).toBe("falsifier_passed");
      expect(result.report.openapi_reconciliation_ref).toBe("openapi-reconciliation.json");
      expect(result.artifacts?.apiOperations.inventory_kind).toBe("api_operation");
      if (falsifierId === "F8_openapi_stale") {
        expect(result.artifacts?.report).toMatchObject({ status: "stale", exit_code: 5 });
        expect(result.artifacts?.openapiReconciliation.status).toBe("stale");
      } else if (falsifierId === "F9_runtime_unavailable") {
        expect(result.artifacts?.report).toMatchObject({
          status: "runtime_unavailable",
          exit_code: 10,
        });
      } else if (falsifierId === "F10_static_runtime_mismatch") {
        expect(
          result.artifacts?.apiRows.some(
            (row) =>
              row.status === "changed" &&
              row.observation_kinds.includes("static_source") &&
              row.observation_kinds.includes("runtime_resolution"),
          ),
        ).toBe(true);
      } else {
        const h3Copy = result.artifacts?.apiOperations.rows.find(
          (row) =>
            "uri_template" in row.details &&
            row.details.uri_template === "/fixture/h3-authority-copy",
        );
        expect(h3Copy).toBeDefined();
        if (h3Copy === undefined) throw new Error("H3 authority copy row missing");
        expect(h3Copy).toMatchObject({
          authority_line: "cross_line",
          status: "unresolved",
          observation_kinds: ["derived_h3"],
        });
        expect(result.report.failures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "schema_invalid",
              reason_code: "H3_DERIVATION_ONLY",
              row_ids: [h3Copy.row_id],
            }),
          ]),
        );
      }
    });
  }
});
test("C1 H3 derivation dedup preserves unique route rows and all edge contracts", async () => {
  const result = await Effect.runPromise(
    run({
      root: ".",
      legacyRoot: ".",
      mode: "fixture_injection",
      falsifierId: "F0_deterministic_replay",
    }).pipe(Effect.provide(NodeRuntimeLayer)),
  );
  const artifacts = result.artifacts;
  if (artifacts === undefined) throw new Error("fixture artifacts unavailable");
  const allRows = [
    ...artifacts.legacyRoutes.rows,
    ...artifacts.monoRoutes.rows,
    ...artifacts.apiOperations.rows,
  ];
  expect(new Set(artifacts.monoRoutes.rows.map((row) => row.row_id)).size).toBe(
    artifacts.monoRoutes.rows.length,
  );
  expect(new Set(allRows.map((row) => row.row_id)).size).toBe(allRows.length);
  const edgeNames = [
    ...artifacts.monoRoutes.derivation_edges,
    ...artifacts.apiOperations.derivation_edges,
  ]
    .map((edge) => edge.derivation)
    .sort();
  expect([...new Set(edgeNames)]).toEqual(
    [
      "E-H3-CANONICALIZATION",
      "E-H3-RECONCILIATION",
      "E-H3-RESOURCE-DERIVATION",
      "E-H3-ROUTE-DERIVATION",
    ].sort(),
  );
  expect(
    artifacts.monoRoutes.observations.some(
      (observation) => observation.label === "h3_route_inventory",
    ),
  ).toBe(true);
  expect(
    artifacts.apiOperations.observations.some(
      (observation) => observation.label === "h3_resource_inventory",
    ),
  ).toBe(true);
  for (const edge of [
    ...artifacts.monoRoutes.derivation_edges,
    ...artifacts.apiOperations.derivation_edges,
  ]) {
    expect(edge.from_ref_ids.length).toBeGreaterThan(0);
    expect(edge.to_row_ids.length).toBeGreaterThan(0);
  }
});
const c3ReceiptMatrix = [
  ["F11_intent_missing_or_stale", "accepted_intent_invalid", "ACCEPTED_INTENT_MISSING"],
  ["F12_uncovered_journey", "gaps_found", "COVERAGE_REF_REQUIRED"],
  ["F15_secret_or_pii_input", "source_unavailable", "UNSAFE_SOURCE"],
  ["F17_locale_order", "stale", "LOCALE_ORDER_CANONICAL"],
  ["F18_stale_artifact_diff", "stale", "STALE_ARTIFACT"],
  ["F19_ignore_residual_precedence", "stale", "RESIDUAL_PRECEDENCE"],
] as const satisfies readonly [FalsifierId, string, string][];

describe("C3 falsifier receipts", () => {
  for (const [falsifierId, failureStatus, reasonCode] of c3ReceiptMatrix) {
    test(`${falsifierId} emits a causal sanitized receipt`, async () => {
      const result = await Effect.runPromise(
        run({ root: ".", legacyRoot: ".", mode: "fixture_injection", falsifierId }).pipe(
          Effect.provide(NodeRuntimeLayer),
        ),
      );
      expect(result.exitCode).toBe(13);
      expect(result.report.status).toBe("falsifier_passed");
      expect(result.report.falsifier_id).toBe(falsifierId);
      const receipts = result.report.failures.filter(
        (failure) => failure.reason_code === reasonCode,
      );
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) {
        expect(receipt.status).toBe(failureStatus);
        expect(receipt.row_ids).toEqual([...new Set(receipt.row_ids)].sort());
        expect(receipt.source_ref_ids).toEqual([...new Set(receipt.source_ref_ids)].sort());
      }
      if (falsifierId === "F12_uncovered_journey") {
        const receipt = receipts[0];
        expect(receipt?.row_ids.length).toBe(1);
        expect(
          result.artifacts?.routeRows.some(
            (row) => row.row_id === receipt?.row_ids[0] && row.status === "uncovered",
          ),
        ).toBe(true);
      }
      if (falsifierId === "F15_secret_or_pii_input") {
        expect(JSON.stringify(result.report)).not.toContain("sk_live_fixture_secret");
      }
      expect(result.report.verification.forbidden_states_empty).toBe(false);
    });
  }
});
const terminalReport = (
  mode: "diff" | "write",
  status: "zero_gap" | "projection_written",
  exitCode: 0 | 14,
  deterministicDiff: "equal" | "not_run",
): Record<string, unknown> => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-zero-gap-report/v1",
  status,
  exit_code: exitCode,
  mode,
  falsifier_id: null,
  projection_write:
    mode === "write"
      ? { status: "written", target_ref: "evidence/functional-parity" }
      : { status: "not_requested", target_ref: null },
  source_manifest_sha256: sha256("{}"),
  inventory_artifact_sha256: { "source-manifest.json": sha256("{}") },
  row_counts: {},
  status_counts: {},
  failures: [],
  mismatches: [],
  openapi_reconciliation_ref: "openapi-reconciliation.json",
  verification: {
    canonical_json: "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline",
    schema_validation: true,
    cross_reference_validation: true,
    deterministic_diff: deterministicDiff,
    forbidden_states_empty: true,
  },
});

test("terminal diff publishes only a clean zero-gap receipt", () => {
  const report = terminalReport("diff", "zero_gap", 0, "equal");
  expect(report).toMatchObject({
    status: "zero_gap",
    exit_code: 0,
    mode: "diff",
    projection_write: { status: "not_requested" },
    verification: { deterministic_diff: "equal", forbidden_states_empty: true },
  });
  expect(canonicalJson(report)).toBe(canonicalJson(JSON.parse(canonicalJson(report))));
});

test("terminal write promotion is exit fourteen and does not run diff", () => {
  const report = terminalReport("write", "projection_written", 14, "not_run");
  expect(report).toMatchObject({
    status: "projection_written",
    exit_code: 14,
    mode: "write",
    projection_write: { status: "written", target_ref: "evidence/functional-parity" },
    verification: { deterministic_diff: "not_run" },
  });
});
test("terminal claims require the closed generated artifact bundle", async () => {
  const result = await Effect.runPromise(
    run({
      root: ".",
      legacyRoot: ".",
      mode: "fixture_injection",
      falsifierId: "F0_deterministic_replay",
    }).pipe(Effect.provide(NodeRuntimeLayer)),
  );
  const artifacts = result.artifacts;
  if (artifacts === undefined) throw new Error("fixture artifacts unavailable");
  const observation: ProjectionObservation = {
    entries: [],
    bytes: Object.fromEntries(COMMITTED_PROJECTIONS.map((name) => [name, null])),
    writeReceipt: false,
  };
  const forgedZeroGap = terminalReport(
    "diff",
    "zero_gap",
    0,
    "equal",
  ) as unknown as typeof artifacts.report;
  const forgedProjectionWritten = terminalReport(
    "write",
    "projection_written",
    14,
    "not_run",
  ) as unknown as typeof artifacts.report;
  expect(validateReportBundle({ ...artifacts, report: forgedZeroGap }, observation)).toBe(false);
  expect(validateReportBundle({ ...artifacts, report: forgedProjectionWritten }, observation)).toBe(
    false,
  );
});
const gitFixture = (): string => {
  const root = mkdtempSync("/tmp/functional-parity-git-");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "parity@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "parity-test"]);
  return root;
};

const putFixture = (root: string, path: string, text: string): void => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
};
const createIntentAuthority = (
  root: string,
  legacyRoot: string,
): { readonly path: string; readonly directory: string } => {
  let selectedRevisionRefIds = ["rev-legacy-test", "rev-mono-intent-test"];
  try {
    const legacy = Effect.runSync(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = Effect.runSync(
      scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    selectedRevisionRefIds = [legacy.revisionRefId, acceptedIntentRevisionRefId(context)].sort();
  } catch {
    // Source-root drift is the subject of several tests; the authority must still be independently pinned.
  }
  const intentPayload = {
    intent_ref_id: "intent://test-authority",
    intent_revision: "test-authority-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: [],
    purpose: "coverage" as const,
    disposition: null,
    row_ids: [],
    canonical_signatures: [],
    inventory_kinds: [],
    journey_ref_ids: ["intent://test-journey"],
  };
  const journeyPayload = {
    journey_ref_id: "intent://test-journey",
    journey_key: "test-authority-journey",
    intent_ref_id: "intent://test-authority",
    journey_revision: "test-authority-journey-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: [],
    steps: [],
    coverage_scope: "accepted_non_user_facing" as const,
  };
  const register = {
    schema_version: "functional-parity-accepted-intent/v1" as const,
    intents: [{ ...intentPayload, intent_digest: sha256(canonicalJson(intentPayload)) }],
    journeys: [{ ...journeyPayload, journey_digest: sha256(canonicalJson(journeyPayload)) }],
  };
  const directory = gitFixture();
  const path = join(directory, "accepted-intent.json");
  writeFileSync(path, canonicalJson(register), "utf8");
  execFileSync("git", ["-C", directory, "add", "--", "accepted-intent.json"]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "intent-authority"]);
  return { path, directory };
};
const createEvidenceAuthority = (
  intentPath: string,
): { readonly path: string; readonly directory: string } => {
  const accepted = JSON.parse(readFileSync(intentPath, "utf8")) as {
    readonly journeys: readonly [
      {
        readonly journey_ref_id: string;
        readonly selected_revision_ref_ids: readonly string[];
        readonly source_ref_ids: readonly string[];
        readonly steps: readonly { readonly step_id: string }[];
      },
    ];
  };
  const journey = accepted.journeys[0];
  if (journey === undefined) throw new Error("fixture journey authority is unavailable");
  const receipt = makeRuntimeEvidenceReceipt({
    journey_ref_id: journey.journey_ref_id,
    step_ids: [journey.steps[0]?.step_id ?? "fixture-step"],
    legacy_revision_ref_id:
      journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-legacy-")) ??
      "rev-legacy-test",
    mono_revision_ref_id:
      journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-mono-")) ??
      "rev-mono-intent-test",
    runner_source_ref_ids:
      journey.source_ref_ids.length > 0 ? journey.source_ref_ids : [`src-${"0".repeat(64)}`],
    runner_digest: sha256("test-runner-input"),
    fixture_digest: sha256("test-fixture-input"),
    environment_kind: "ci_non_production",
    exit_code: 1,
    result: "failed",
    artifact_digest: sha256("test-artifact"),
  });
  const directory = gitFixture();
  const path = join(directory, "runtime-evidence.json");
  writeFileSync(
    path,
    canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt])),
    "utf8",
  );
  execFileSync("git", ["-C", directory, "add", "--", "runtime-evidence.json"]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "runtime-evidence-authority"]);
  return { path, directory };
};
const intentContextFor = async (
  text: string,
): Promise<{
  readonly context: ManifestContext;
  readonly monoRoot: string;
  readonly legacyRoot: string;
  readonly intentInput: IntentSourceInput;
}> => {
  const monoRoot = gitFixture();
  const legacyRoot = gitFixture();
  execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "legacy-fixture"]);
  const legacy = await Effect.runPromise(
    scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
  );
  const mono = await Effect.runPromise(
    scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
  );
  const context = createManifestContextFromSnapshots(legacy, mono);
  return {
    context,
    monoRoot,
    legacyRoot,
    intentInput: {
      path: "authority/accepted-intent.json",
      bytes: Buffer.from(text, "utf8"),
      revisionRefId: "rev-intent-fixture",
      repositoryRef: "external_intent_authority",
      revision: "intent-fixture-v1",
      blobOid: "intent-fixture-blob",
      digest: "",
    },
  };
};
const runWithIntentAuthority = async (root: string, legacyRoot: string, mode: "diff" | "write") => {
  const authority = createIntentAuthority(root, legacyRoot);
  const evidenceAuthority = createEvidenceAuthority(authority.path);
  try {
    return await Effect.runPromise(
      run({
        root,
        legacyRoot,
        intentRegisterPath: authority.path,
        evidenceRegisterPath: evidenceAuthority.path,
        mode,
      }).pipe(Effect.provide(NodeRuntimeLayer)),
    );
  } finally {
    rmSync(authority.directory, { recursive: true, force: true });
    rmSync(evidenceAuthority.directory, { recursive: true, force: true });
  }
};
test("accepted-intent decoder rejects PII, duplicate members, and noncanonical JSON", async () => {
  const pii = await intentContextFor(
    '{"schema_version":"functional-parity-accepted-intent/v1","intents":[],"journeys":[],"note":"sk_live_fixture_secret"}',
  );
  const duplicate = await intentContextFor(
    '{"schema_version":"functional-parity-accepted-intent/v1","intents":[],"intents":[],"journeys":[]}',
  );
  const noncanonical = await intentContextFor(
    '{ "schema_version": "functional-parity-accepted-intent/v1", "intents": [], "journeys": [] }',
  );
  try {
    expect(loadAcceptedIntentRegister(pii.context, pii.intentInput)).toMatchObject({
      register: null,
      issues: [
        expect.objectContaining({ reasonCode: "UNSAFE_SOURCE", status: "accepted_intent_invalid" }),
      ],
    });
    expect(loadAcceptedIntentRegister(duplicate.context, duplicate.intentInput)).toMatchObject({
      register: null,
      issues: [
        expect.objectContaining({
          reasonCode: "INTENT_DUPLICATE_KEY",
          status: "accepted_intent_invalid",
        }),
      ],
    });
    expect(
      loadAcceptedIntentRegister(noncanonical.context, noncanonical.intentInput),
    ).toMatchObject({
      register: null,
      issues: [
        expect.objectContaining({
          reasonCode: "INTENT_NOT_CANONICAL",
          status: "accepted_intent_invalid",
        }),
      ],
    });
  } finally {
    rmSync(pii.monoRoot, { recursive: true, force: true });
    rmSync(pii.legacyRoot, { recursive: true, force: true });
    rmSync(duplicate.monoRoot, { recursive: true, force: true });
    rmSync(duplicate.legacyRoot, { recursive: true, force: true });
    rmSync(noncanonical.monoRoot, { recursive: true, force: true });
    rmSync(noncanonical.legacyRoot, { recursive: true, force: true });
  }
});
test("projection state cannot provide accepted intent authority", async () => {
  const fixture = await intentContextFor(
    '{"schema_version":"functional-parity-accepted-intent/v1","intents":[],"journeys":[]}',
  );
  try {
    expect(loadAcceptedIntentRegister(fixture.context)).toMatchObject({
      register: null,
      path: null,
      issues: [
        expect.objectContaining({
          reasonCode: "ACCEPTED_INTENT_MISSING",
          status: "accepted_intent_invalid",
        }),
      ],
    });
  } finally {
    rmSync(fixture.monoRoot, { recursive: true, force: true });
    rmSync(fixture.legacyRoot, { recursive: true, force: true });
  }
});
test("external intent authority must remain clean while pinned", () => {
  const legacy = gitFixture();
  const mono = gitFixture();
  const authority = createIntentAuthority(mono, legacy);
  try {
    writeFileSync(
      authority.path,
      '{"schema_version":"functional-parity-accepted-intent/v1","intents":[],"journeys":[],"changed":true}',
      "utf8",
    );
    expect(() =>
      Effect.runSync(
        readPinnedIntentRegisterEffect(authority.path, legacy, mono).pipe(
          Effect.provide(NodeRuntimeLayer),
        ),
      ),
    ).toThrow();
  } finally {
    rmSync(authority.directory, { recursive: true, force: true });
    rmSync(mono, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  }
});
test("real target API identities and normalized H3 edges do not invoke ambient runtime", async () => {
  const sourceRoot = join(import.meta.dir, "../../..");
  const monoRoot = gitFixture();
  const legacyRoot = gitFixture();
  const copiedPaths = new Set([
    "evidence/security-h3/0015/source-manifest.json",
    "evidence/security-h3/0015/route-collector.json",
    "evidence/security-h3/0015/current-route-inventory.json",
    "evidence/security-h3/0015/current-resource-inventory.json",
    "apps/server/tools/security-h3/0015/generate.ts",
    "packages/sdk/legacy-symfony-openapi.snapshot.json",
  ]);
  const sourceManifest = JSON.parse(
    readFileSync(join(sourceRoot, "evidence/security-h3/0015/source-manifest.json"), "utf8"),
  ) as readonly { readonly path: string }[];
  for (const source of sourceManifest) copiedPaths.add(source.path);
  try {
    for (const path of copiedPaths) {
      const target = join(monoRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(sourceRoot, path)));
    }
    execFileSync("git", ["-C", monoRoot, "add", "."]);
    execFileSync("git", ["-C", monoRoot, "commit", "-qm", "real-target-probe"]);
    execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "empty-legacy-probe"]);
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    const routes = await Effect.runPromise(
      collectRoutes(context, sha256("real-target-probe"), undefined, true).pipe(
        Effect.provide(NodeRuntimeLayer),
      ),
    );
    const api = await Effect.runPromise(
      collectApiOperations(context, sha256("real-target-probe"), routes.mono.rows, false).pipe(
        Effect.provide(NodeRuntimeLayer),
      ),
    );
    const staticRows = api.rows.filter((row) => row.observation_kinds.includes("static_source"));
    const deleteOperation = staticRows.find((row) => {
      if (!("operation_name" in row.details)) return false;
      return (
        row.details.operation_name === "Delete" &&
        row.details.method === "DELETE" &&
        row.details.uri_template === "/admin/admission-periods/{id}"
      );
    });
    const openApi = JSON.parse(
      readFileSync(join(sourceRoot, "packages/sdk/legacy-symfony-openapi.snapshot.json"), "utf8"),
    ) as {
      readonly paths?: Record<string, Record<string, { readonly operationId?: string } | null>>;
    };
    expect(staticRows.length).toBeGreaterThan(0);
    expect(deleteOperation).toBeDefined();
    const staticContent = staticRows.filter(
      (row) =>
        "resource_class_ref" in row.details &&
        row.details.resource_class_ref === "App\\Content\\Infrastructure\\Entity\\StaticContent" &&
        row.details.operation_name === "GetCollection",
    );
    expect(staticContent).toHaveLength(1);
    expect(staticContent[0]?.observation_kinds).toContain("derived_h3");
    const sourceBackedRouteKeys = new Set([
      JSON.stringify(["/opptak", "GET"]),
      JSON.stringify(["/opptak/{shortName}", "ANY"]),
      JSON.stringify(["/avdeling/{shortName}", "ANY"]),
      JSON.stringify(["/opptak/avdeling/{id}", "GET"]),
    ]);
    const sourceBackedRoutes = api.h3RouteRows.filter(
      (row) =>
        row.observation_kinds.includes("static_source") &&
        row.observation_kinds.includes("derived_h3") &&
        "path_template" in row.details &&
        sourceBackedRouteKeys.has(JSON.stringify([row.details.path_template, row.details.method])),
    );
    expect(
      new Set(
        sourceBackedRoutes.map((row) =>
          "path_template" in row.details
            ? JSON.stringify([row.details.path_template, row.details.method])
            : "",
        ),
      ),
    ).toEqual(sourceBackedRouteKeys);
    expect(
      api.h3RouteRows.some(
        (row) =>
          row.authority_line === "cross_line" &&
          "path_template" in row.details &&
          sourceBackedRouteKeys.has(
            JSON.stringify([row.details.path_template, row.details.method]),
          ),
      ),
    ).toBe(false);
    expect(openApi.paths?.["/api/admin/admission-periods/{id}"]?.delete?.operationId).toBe(
      "api_adminadmission-periods_id_delete",
    );
    expect(api.reconciliation.committed_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(api.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID")).toBe(
      false,
    );
    expect(api.inventory.derivation_edges.length).toBeGreaterThan(0);
    expect(
      api.inventory.derivation_edges.some(
        (edge) => edge.edge_type === "observed_inventory" && edge.to_row_ids.length > 0,
      ),
    ).toBe(true);
    expect(
      api.inventory.derivation_edges.every(
        (edge) => edge.from_ref_ids.length > 0 && edge.to_row_ids.length > 0,
      ),
    ).toBe(true);
    expect(api.failures.some((failure) => failure.reasonCode === "RUNTIME_UNAVAILABLE")).toBe(true);
  } finally {
    rmSync(monoRoot, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
test("OpenAPI route keys remain structural while credential and schema values fail closed", async () => {
  const runFixture = async (
    openApiPayload: Record<string, unknown>,
    runtimePayload: unknown,
  ): Promise<{
    readonly result: ApiCollection;
    readonly openApiAvailability: string | null;
  }> => {
    const monoRoot = gitFixture();
    const legacyRoot = gitFixture();
    try {
      putFixture(
        monoRoot,
        "packages/sdk/legacy-symfony-openapi.snapshot.json",
        JSON.stringify(openApiPayload),
      );
      execFileSync("git", ["-C", monoRoot, "add", "."]);
      execFileSync("git", ["-C", monoRoot, "commit", "-qm", "openapi-safety-boundary"]);
      execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "empty-legacy"]);
      const mono = await Effect.runPromise(
        scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const legacy = await Effect.runPromise(
        scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const context = createManifestContextFromSnapshots(legacy, mono);
      const result = await Effect.runPromise(
        collectApiOperations(context, sha256("openapi-safety-boundary"), [], true, undefined, {
          path: "openapi-safety-runtime.json",
          bytes: Buffer.from(JSON.stringify(runtimePayload), "utf8"),
        }).pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const openApiObservation = [...context.runtimeObservations]
        .reverse()
        .find((observation) => observation.collector_kind === "openapi_projection");
      return { result, openApiAvailability: openApiObservation?.availability ?? null };
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  };
  const operation = {
    method: "PUT",
    uri_template: "/api/me/password",
    operation_id: "read_me_password",
  };
  const wrapperDocument = {
    openapi: "3.1.0",
    info: { title: "Fixture API", version: "1.0.0" },
    paths: {
      paths: {
        "/api/me/password": {
          put: { operationId: "read_me_password", responses: { "200": { description: "OK" } } },
        },
      },
    },
    components: {},
  };
  const safe = await runFixture(wrapperDocument, [operation]);
  expect(safe.openApiAvailability).toBe("available");
  expect(safe.result.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE")).toBe(
    false,
  );
  const prototype = await runFixture(wrapperDocument, [
    { ...operation, uri_template: "__proto__" },
  ]);
  expect(prototype.openApiAvailability).toBe("available");
  expect(prototype.result.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE")).toBe(
    false,
  );
  expect(Object.prototype).not.toHaveProperty("put");
  const twoRouteDocument = {
    ...wrapperDocument,
    paths: {
      paths: {
        "/api/me/password": {
          put: { operationId: "read_me_password", responses: { "200": { description: "OK" } } },
        },
        "/api/me/profile": {
          put: {
            operationId: "read_me_profile",
            responses: { "200": { description: "OK" } },
            password: { example: "concrete-second-route-secret" },
          },
        },
      },
    },
  };
  const twoRoute = await runFixture(twoRouteDocument, [operation]);
  expect(
    twoRoute.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(true);

  const credentialDocument = {
    ...wrapperDocument,
    paths: {
      "/api/me/password/password-secret": {
        put: { operationId: "read_me_password", responses: { "200": { description: "OK" } } },
      },
    },
  };
  const credential = await runFixture(credentialDocument, [operation]);
  expect(
    credential.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(true);

  const schemaDocument = {
    ...wrapperDocument,
    paths: {
      "/api/me/password": {
        put: { operationId: "read_me_password", responses: { "200": { description: "OK" } } },
      },
    },
    components: {
      schemas: {
        Credential: {
          properties: {
            password: {
              example: "correct-horse-battery-staple",
              examples: ["another-concrete-secret"],
              default: "concrete-default-secret",
              defaults: ["another-concrete-default"],
              value: "concrete-value-secret",
              values: ["another-concrete-value"],
            },
          },
        },
      },
    },
  };
  const schema = await runFixture(schemaDocument, [operation]);
  expect(
    schema.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(true);

  const nonOpenApi = await runFixture(
    { paths: { "/api/me/password": { operationId: "read_me_password" } } },
    { paths: { "/api/me/password": { operationId: "read_me_password" } } },
  );
  expect(nonOpenApi.result.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE")).toBe(
    true,
  );
  const validDocument = {
    openapi: "3.1.0",
    info: { title: "Fixture API", version: "1.0.0" },
    paths: {
      "/api/me/password": {
        put: { operationId: "read_me_password", responses: { "200": { description: "OK" } } },
      },
    },
    components: {},
  };
  const metadataSchema = {
    type: "object",
    properties: {
      token: { type: "string", format: "uuid", readOnly: true },
      email: { type: "string", format: "email", writeOnly: false },
      phone: { type: "string", format: "phone", nullable: true },
      userId: { type: "integer", format: "int64", readOnly: true },
    },
  };
  const metadataDocument = {
    ...validDocument,
    components: {
      schemas: {
        Metadata: metadataSchema,
        PasswordChangeInput: metadataSchema,
        PasswordResetExecute: metadataSchema,
        PasswordResetRequest: metadataSchema,
      },
    },
  };
  const metadata = await runFixture(metadataDocument, [operation]);
  expect(
    metadata.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(false);
  const placeholderDocument = {
    ...validDocument,
    components: {
      schemas: {
        Credential: {
          properties: {
            token: {
              example: "${TOKEN}",
              examples: ["fixture"],
              default: "placeholder",
              defaults: ["${TOKEN}"],
              value: "not-a-secret",
              values: ["test"],
              const: "${TOKEN}",
              enum: ["changeme"],
            },
          },
        },
      },
    },
  };
  const placeholder = await runFixture(placeholderDocument, [operation]);
  expect(
    placeholder.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(false);
  for (const carrier of ["example", "default", "enum", "const"]) {
    const sensitiveDocument = {
      ...validDocument,
      components: {
        schemas: {
          Credential: {
            properties: {
              token: {
                [carrier]: carrier === "enum" ? ["concrete-enum-secret"] : "concrete-schema-secret",
              },
            },
          },
        },
      },
    };
    const sensitive = await runFixture(sensitiveDocument, [operation]);
    expect(
      sensitive.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
    ).toBe(true);
  }
  const descriptionDocument = {
    ...validDocument,
    components: {
      schemas: {
        Credential: {
          properties: {
            token: { description: "password=concrete-description-secret" },
          },
        },
      },
    },
  };
  const description = await runFixture(descriptionDocument, [operation]);
  expect(
    description.result.failures.some((failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID"),
  ).toBe(true);
  const nestedMetadataDocument = {
    ...validDocument,
    components: {
      schemas: {
        Nested: {
          properties: {
            profile: {
              properties: {
                token: {
                  type: "array",
                  items: { type: "string", readOnly: true },
                },
              },
            },
          },
        },
      },
    },
  };
  const nestedMetadata = await runFixture(nestedMetadataDocument, [operation]);
  expect(
    nestedMetadata.result.failures.some(
      (failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID",
    ),
  ).toBe(false);
  const nestedSensitiveDocument = {
    ...validDocument,
    components: {
      schemas: {
        Nested: {
          properties: {
            profile: {
              properties: {
                token: {
                  allOf: [{ type: "string" }, { items: { default: "concrete-nested-secret" } }],
                },
              },
            },
          },
        },
      },
    },
  };
  const nestedSensitive = await runFixture(nestedSensitiveDocument, [operation]);
  expect(
    nestedSensitive.result.failures.some(
      (failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID",
    ),
  ).toBe(true);
  const ordinaryPayloadDocument = {
    ...validDocument,
    paths: {
      "/api/me/password": {
        put: {
          operationId: "read_me_password",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { properties: { password: "concrete-payload-secret" } },
                },
              },
            },
          },
        },
      },
    },
  };
  const ordinaryPayload = await runFixture(ordinaryPayloadDocument, [operation]);
  expect(
    ordinaryPayload.result.failures.some(
      (failure) => failure.reasonCode === "OPENAPI_SCHEMA_INVALID",
    ),
  ).toBe(true);
});
test("shared JSON member safety rejects nested duplicates before decoding", () => {
  expect(
    hasDuplicateJsonMembers(
      '{"openapi":"3.1.0","paths":{"paths":{"/api/me/password":{"put":{}},"/api/me/password":{"put":{}}}}}',
    ),
  ).toBe(true);
  expect(
    hasDuplicateJsonMembers(
      '{"components":{"schemas":{"Credential":{"properties":{"password":{"example":"fixture"}},"properties":{"token":{"example":"fixture"}}}}}}',
    ),
  ).toBe(true);
  expect(
    hasDuplicateJsonMembers(
      '{"openapi":"3.1.0","paths":{"paths":{"/api/me/password":{"put":{}}}}}',
    ),
  ).toBe(false);
  expect(hasDuplicateJsonMembers('{"openapi":"3.1.0"')).toBe(true);
});
test("nonvalid JSON member scans reject runtime fixtures before digest or observation capture", async () => {
  const runFixtureBytes = async (bytes: Uint8Array) => {
    const monoRoot = gitFixture();
    const legacyRoot = gitFixture();
    try {
      const mono = await Effect.runPromise(
        scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const legacy = await Effect.runPromise(
        scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const context = createManifestContextFromSnapshots(legacy, mono);
      const result = await Effect.runPromise(
        collectApiOperations(context, sha256("json-member-prehash-boundary"), [], true, undefined, {
          path: "api-operations-malformed.json",
          bytes,
        }).pipe(Effect.provide(NodeRuntimeLayer)),
      );
      return {
        result,
        observations: [...context.runtimeObservations],
        sources: [...context.sources],
      };
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  };
  const depth = 50_000;
  const nested = `[${"[".repeat(depth)}0${"]".repeat(depth)}]`;
  const stackDeepDuplicate = `{"operations":[{"method":"GET","uri_template":"/safe","operation_id":"safe"}],"deep":0,"deep":${nested},"deep":0}`;
  const truncated = '{"operations":[{"method":"GET","uri_template":"/safe","operation_id":"safe"}]';
  expect(JSON.parse(stackDeepDuplicate)).toMatchObject({
    operations: [{ operation_id: "safe" }],
    deep: 0,
  });
  expect(hasDuplicateJsonMembers(stackDeepDuplicate)).toBe(true);
  for (const [text, expectedReason] of [
    [stackDeepDuplicate, "SOURCE_PARSE_ERROR"],
    [truncated, "SOURCE_PARSE_ERROR"],
  ] as const) {
    const bytes = new TextEncoder().encode(text);
    const rawDigest = sha256(bytes);
    const capture = await runFixtureBytes(bytes);
    expect(capture.result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ reasonCode: expectedReason })]),
    );
    expect(
      capture.observations.some(
        (observation) =>
          observation.stdout_sha256 === rawDigest ||
          observation.stderr_sha256 === rawDigest ||
          observation.result_sha256 === rawDigest,
      ),
    ).toBe(false);
    expect(
      capture.sources.some(
        (source) =>
          source.path === "fixture://runtime/api-operations-malformed.json" &&
          source.sha256 !== null,
      ),
    ).toBe(false);
  }
});
test("malformed and unsafe OpenAPI documents remain schema-invalid and write-blocked", async () => {
  const payloads = [
    {
      openapi: "3.1.0",
      info: { title: "Fixture API", version: "1.0.0" },
      paths: { "/fixture/api": { get: { operationId: "fixture_api" } } },
      components: {},
    },
    {
      openapi: "3.1.0",
      info: { title: "Fixture API", version: "1.0.0" },
      paths: {
        "/fixture/api": {
          get: { responses: { "200": { $ref: "#/components/responses/constructor" } } },
        },
      },
      components: { responses: {} },
    },
    { openapi: "3.1", info: { title: "Fixture API", version: "1.0.0" }, paths: {}, components: {} },
    {
      openapi: "3.1.0",
      info: { title: "Fixture API", version: "1.0.0" },
      paths: { paths: {} },
      components: {},
    },
    {
      openapi: "3.1.0",
      info: { title: "Fixture API", version: "1.0.0" },
      paths: {},
      components: { responses: [] },
    },
  ] as const;
  for (const payload of payloads) {
    const monoRoot = gitFixture();
    const legacyRoot = gitFixture();
    try {
      putFixture(
        monoRoot,
        "apps/server/src/App/Api/Resource/Fixture.php",
        "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(operations: [new Get(uriTemplate: '/fixture/api', name: 'fixture_api')])]\nfinal class FixtureResource {}\n",
      );
      putFixture(monoRoot, "apps/server/bin/console", "<?php\n");
      putFixture(monoRoot, "apps/server/vendor/autoload.php", "<?php\n");
      putFixture(
        monoRoot,
        "packages/sdk/legacy-symfony-openapi.snapshot.json",
        JSON.stringify(payload),
      );
      execFileSync("git", ["-C", monoRoot, "add", "."]);
      execFileSync("git", ["-C", monoRoot, "add", "-f", "apps/server/vendor/autoload.php"]);
      execFileSync("git", ["-C", monoRoot, "commit", "-qm", "openapi-boundary"]);
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.report.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "schema_invalid",
            reason_code: "OPENAPI_SCHEMA_INVALID",
          }),
        ]),
      );
      expect(receipt.report.projection_write).toMatchObject({ status: "blocked" });
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  }
});
test("API resource trivia is accepted while unterminated block comments fail closed", async () => {
  const collectFixture = async (source: string): Promise<ApiCollection> => {
    const monoRoot = gitFixture();
    const legacyRoot = gitFixture();
    try {
      putFixture(monoRoot, "apps/server/src/App/Api/Resource/Fixture.php", source);
      execFileSync("git", ["-C", monoRoot, "add", "."]);
      execFileSync("git", ["-C", monoRoot, "commit", "-qm", "api-resource-trivia"]);
      execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "empty-legacy"]);
      const legacy = await Effect.runPromise(
        scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const mono = await Effect.runPromise(
        scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      return await Effect.runPromise(
        collectApiOperations(
          createManifestContextFromSnapshots(legacy, mono),
          sha256(source),
          [],
          true,
          undefined,
          { path: "api-resource-trivia.json", bytes: Buffer.from("[]", "utf8") },
        ).pipe(Effect.provide(NodeRuntimeLayer)),
      );
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  };
  const validSource =
    "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(operations: [new Get(uriTemplate: '/fixture/api', name: 'fixture_api')])]\n/** declaration trivia */\nfinal class FixtureResource {}\n";
  const valid = await collectFixture(validSource);
  expect(valid.failures.some((failure) => failure.reasonCode === "SOURCE_PARSE_ERROR")).toBe(false);
  expect(
    valid.rows.some(
      (row) =>
        "resource_class_ref" in row.details &&
        row.details.resource_class_ref === "App\\Fixture\\Api\\Resource\\FixtureResource",
    ),
  ).toBe(true);

  const malformed = await collectFixture(
    validSource.replace("/** declaration trivia */", "/* declaration trivia"),
  );
  expect(malformed.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR" }),
    ]),
  );
});
test("runtime defaults resolve omitted API metadata while explicit conflicts remain changed", async () => {
  const monoRoot = gitFixture();
  const legacyRoot = gitFixture();
  try {
    putFixture(
      monoRoot,
      "apps/server/src/App/Api/Resource/Fixture.php",
      "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(shortName: 'Fixture', operations: [new Get(uriTemplate: '/fixture/api', name: 'fixture_api')])]\nfinal class FixtureResource {}\n",
    );
    putFixture(
      monoRoot,
      "apps/server/src/App/Api/Resource/Defaulted.php",
      "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(operations: [new Get()])]\nfinal class DefaultedResource {}\n",
    );
    putFixture(
      monoRoot,
      "apps/server/var/parity/api-operations.json",
      JSON.stringify([
        {
          resource_class_ref: "App\\Fixture\\Api\\Resource\\FixtureResource",
          resource_key: "RuntimeFixture",
          operation_name: "Get",
          method: "GET",
          uri_template: "/fixture/runtime-conflict",
          operation_id: "fixture_api",
          provider_ref: "App\\Fixture\\Api\\State\\RuntimeProvider",
          schema_ref: "RuntimeSchema",
        },
        {
          resource_class_ref: "App\\Fixture\\Api\\Resource\\DefaultedResource",
          resource_key: "DefaultedResource",
          operation_name: "Get",
          method: "GET",
          uri_template: "/defaulted_resources/{id}{._format}",
          operation_id: "_api_/defaulted_resources/{id}{._format}_get",
          provider_ref: "ApiPlatform\\State\\ProviderInterface",
          processor_ref: "ApiPlatform\\State\\ProcessorInterface",
          schema_ref: "App\\Fixture\\Api\\Resource\\DefaultedResource",
        },
      ]),
    );
    putFixture(
      monoRoot,
      "packages/sdk/legacy-symfony-openapi.snapshot.json",
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Fixture API", version: "1.0.0" },
        paths: {
          "/fixture/api": {
            get: { operationId: "fixture_api", responses: { "200": { description: "OK" } } },
          },
        },
        components: {},
      }),
    );
    execFileSync("git", ["-C", monoRoot, "add", "."]);
    execFileSync("git", ["-C", monoRoot, "commit", "-qm", "metadata-mismatch"]);
    execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "empty-legacy"]);
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const api = await Effect.runPromise(
      collectApiOperations(
        createManifestContextFromSnapshots(legacy, mono),
        sha256("metadata-mismatch"),
        [],
        true,
        undefined,
        {
          path: "apps/server/var/parity/api-operations.json",
          bytes: readFileSync(join(monoRoot, "apps/server/var/parity/api-operations.json")),
        },
      ).pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const changedRows = api.rows.filter(
      (row) =>
        row.status === "changed" &&
        row.observation_kinds.includes("static_source") &&
        row.observation_kinds.includes("runtime_resolution"),
    );
    expect(changedRows.length).toBe(1);
    expect(changedRows[0]?.reason_codes).toContain("STATIC_RUNTIME_MISMATCH");
    const defaultedStaticRow = api.rows.find(
      (row) =>
        row.observation_kinds.includes("static_source") &&
        "resource_class_ref" in row.details &&
        row.details.resource_class_ref === "App\\Fixture\\Api\\Resource\\DefaultedResource",
    );
    expect(defaultedStaticRow).toMatchObject({
      status: "covered",
      observation_kinds: ["static_source", "runtime_resolution"],
      reason_codes: [],
    });
  } finally {
    rmSync(monoRoot, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
test("canonical JSON preserves prototype-named own keys and digest distinctions", () => {
  const aliased = JSON.parse(
    '{"components":{"schemas":{"__proto__":{"type":"string"}}}}',
  ) as Record<string, unknown>;
  const empty = JSON.parse('{"components":{"schemas":{}}}') as Record<string, unknown>;
  const canonical = canonicalJson(aliased);
  expect(canonical).toContain('"__proto__"');
  expect(JSON.parse(canonical)).toEqual(aliased);
  expect(sha256(canonical)).not.toBe(sha256(canonicalJson(empty)));
});
test("OpenAPI prototype-named component changes stale the zero-operation reconciliation", async () => {
  const monoRoot = gitFixture();
  const legacyRoot = gitFixture();
  try {
    putFixture(monoRoot, "apps/server/var/parity/api-operations.json", "[]");
    putFixture(
      monoRoot,
      "packages/sdk/legacy-symfony-openapi.snapshot.json",
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Fixture API", version: "1.0.0" },
        paths: {},
        components: { schemas: JSON.parse('{"__proto__":{"type":"string"}}') },
      }),
    );
    execFileSync("git", ["-C", monoRoot, "add", "."]);
    execFileSync("git", ["-C", monoRoot, "commit", "-qm", "openapi-alias"]);
    execFileSync("git", ["-C", legacyRoot, "commit", "--allow-empty", "-qm", "empty-legacy"]);
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const api = await Effect.runPromise(
      collectApiOperations(
        createManifestContextFromSnapshots(legacy, mono),
        sha256("openapi-alias"),
        [],
        true,
        undefined,
        {
          path: "apps/server/var/parity/api-operations.json",
          bytes: readFileSync(join(monoRoot, "apps/server/var/parity/api-operations.json")),
        },
      ).pipe(Effect.provide(NodeRuntimeLayer)),
    );
    expect(api.reconciliation.status).toBe("stale");
    expect(api.reconciliation.committed_document_sha256).not.toBe(
      api.reconciliation.regenerated_document_sha256,
    );
    expect(api.failures.some((failure) => failure.reasonCode === "STALE_OPENAPI_PROJECTION")).toBe(
      true,
    );
  } finally {
    rmSync(monoRoot, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
const cliReport = (
  root: string,
  legacyRoot: string,
  mode: "diff" | "write" = "diff",
): {
  readonly status: number | null;
  readonly report: Record<string, unknown>;
  readonly output: string;
} => {
  const authority = createIntentAuthority(root, legacyRoot);
  const evidenceAuthority = createEvidenceAuthority(authority.path);
  try {
    const process = spawnSync(
      "bun",
      [
        "run",
        "cli.ts",
        "--root",
        root,
        "--legacy-root",
        legacyRoot,
        "--intent-register",
        authority.path,
        "--evidence-register",
        evidenceAuthority.path,
        "--mode",
        mode,
      ],
      { cwd: join(import.meta.dir, ".."), encoding: "utf8" },
    );
    const output = process.stdout;
    return {
      status: process.status,
      report: JSON.parse(output) as Record<string, unknown>,
      output,
    };
  } finally {
    rmSync(authority.directory, { recursive: true, force: true });
    rmSync(evidenceAuthority.directory, { recursive: true, force: true });
  }
};
const putParityBaseline = (legacyRoot: string, monoRoot: string, legacyRouting: string): void => {
  putFixture(legacyRoot, "app/config/routing.yml", legacyRouting);
  putFixture(
    legacyRoot,
    "src/AppBundle/Controller/Api/FixtureController.php",
    "<?php\nfinal class FixtureApi {}\n",
  );
  putFixture(
    legacyRoot,
    "src/AppBundle/Controller/FixtureController.php",
    "<?php\nfinal class FixtureController {}\n",
  );
  putFixture(
    legacyRoot,
    "src/AppBundle/Service/Fixture.php",
    "<?php\nfinal class FixtureService {}\n",
  );
  putFixture(
    monoRoot,
    "apps/server/config/routes.yaml",
    "fixture:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /safe\n    methods: [GET]\n",
  );
  putFixture(
    monoRoot,
    "apps/server/src/App/Api/Resource/Fixture.php",
    "<?php\nfinal class FixtureResource {}\n",
  );
  putFixture(
    monoRoot,
    "apps/server/src/App/Fixture/Controller/FixtureController.php",
    "<?php\nfinal class FixtureController {}\n",
  );
  putFixture(
    monoRoot,
    "apps/server/src/App/Controller/FixtureController.php",
    "<?php\nfinal class FixtureController2 {}\n",
  );
  putFixture(
    monoRoot,
    "apps/server/src/App/Infrastructure/Fixture.php",
    "<?php\nfinal class FixtureInfrastructure {}\n",
  );
  putFixture(
    monoRoot,
    "apps/homepage/src/routes/home.tsx",
    "export default function Home(){return null}\n",
  );
  putFixture(
    monoRoot,
    "apps/server/tools/security-h3/0015/generate.ts",
    "export const fixture = true\n",
  );
};

test("unsafe parsed scalars produce identical blocked receipts", () => {
  const roots = [
    mkdtempSync("/tmp/functional-parity-scalar-a-"),
    mkdtempSync("/tmp/functional-parity-scalar-b-"),
  ];
  const routes = [
    "first:\n  path: /safe/:token\n  defaults: { _controller: :sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\nsecond:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\n",
    "second:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\nfirst:\n  path: /safe/:token\n  defaults: { _controller: :sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\n",
  ];
  try {
    const outputs: string[] = [];
    for (const [index, root] of roots.entries()) {
      const legacyRoot = join(root, "legacy");
      const monoRoot = join(root, "mono");
      putParityBaseline(legacyRoot, monoRoot, routes[index] ?? routes[0] ?? "");
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.status).toBe(6);
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      expect(receipt.output).not.toContain("sk_live_");
      expect(receipt.output).not.toContain("university.no");
      outputs.push(receipt.output);
    }
    expect(outputs[0]).toBe(outputs[1]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("fixture injection ignores poisoned authority-root paths", async () => {
  const directory = mkdtempSync("/tmp/functional-parity-poison-");
  const poisonRoot = join(directory, "authority-file");
  writeFileSync(poisonRoot, "sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3\n", "utf8");
  try {
    const result = await Effect.runPromise(
      run({
        root: poisonRoot,
        legacyRoot: poisonRoot,
        mode: "fixture_injection",
        falsifierId: "F0_deterministic_replay",
      }).pipe(Effect.provide(NodeRuntimeLayer)),
    );
    expect(result.exitCode).toBe(13);
    expect(result.report.status).toBe("falsifier_passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("runtime abort receipts remain schema-valid and non-promotable", () => {
  const unsafe = mkdtempSync("/tmp/functional-parity-receipt-unsafe-");
  const dirty = gitFixture();
  const symlink = mkdtempSync("/tmp/functional-parity-receipt-symlink-");
  const roots: readonly [string, number][] = [
    [unsafe, 6],
    [dirty, 7],
    [symlink, 6],
  ];
  const legacyRoots = roots.map(() => gitFixture());
  try {
    putFixture(unsafe, "src/user@university.no.php", "<?php\n");
    putFixture(dirty, "safe.txt", "before\n");
    execFileSync("git", ["-C", dirty, "add", "."]);
    execFileSync("git", ["-C", dirty, "commit", "-qm", "fixture"]);
    writeFileSync(join(dirty, "safe.txt"), "after\n", "utf8");
    mkdirSync(join(symlink, "target"), { recursive: true });
    symlinkSync(join(symlink, "target"), join(symlink, "link"));
    for (const [index, [root, expectedExit]] of roots.entries()) {
      const receipt = cliReport(root, legacyRoots[index] ?? legacyRoots[0] ?? root);
      expect(receipt.report.status).toBe(
        expectedExit === 7 ? "source_hash_drift" : "source_unavailable",
      );
      expect(receipt.report).toMatchObject({
        exit_code: expectedExit,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      const verification = receipt.report.verification as Record<string, unknown>;
      expect(verification.schema_validation).toBe(false);
      expect(verification.cross_reference_validation).toBe(false);
      expect(verification.deterministic_diff).toBe("different");
      expect(receipt.output).not.toContain("user@university.no");
    }
  } finally {
    for (const root of roots) rmSync(root[0], { recursive: true, force: true });
    for (const legacyRoot of legacyRoots) rmSync(legacyRoot, { recursive: true, force: true });
  }
});

describe("C0 source traversal safety", () => {
  test("reads captured Git paths with non-ASCII names", async () => {
    const root = gitFixture();
    try {
      const path = "apps/server/src/App/Foo/Controller/TorPekerPåTekst1.png";
      putFixture(root, path, "fixture-bytes\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
      const snapshot = await Effect.runPromise(
        scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const nonAscii = snapshot.files.find((file) => file.path === path);
      expect(new TextDecoder().decode(nonAscii?.bytes ?? new Uint8Array())).toContain(
        "fixture-bytes",
      );
      expect(nonAscii?.unsafe).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects unsafe PII paths before manifest construction", async () => {
    const root = gitFixture();
    const piiPath = "apps/server/src/App/Foo/Controller/user@university.no.php";
    try {
      putFixture(root, piiPath, "<?php\nfinal class User {}\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
      await expect(
        Effect.runPromise(scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer))),
      ).rejects.toMatchObject({
        operation: "scan_root",
        message: expect.stringContaining("unsafe source metadata"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("uses value-independent failure for differing unsafe scalars", async () => {
    const roots = [gitFixture(), gitFixture()];
    const unsafePaths = [
      "apps/server/src/App/Foo/Controller/user@university.no.php",
      "apps/server/src/App/Foo/Controller/other@university.no.php",
    ];
    try {
      const failures: Array<{ readonly operation: string; readonly message: string }> = [];
      for (const [index, root] of roots.entries()) {
        putFixture(root, unsafePaths[index] ?? unsafePaths[0], "<?php\nfinal class User {}\n");
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
        try {
          await Effect.runPromise(
            scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
          );
        } catch (error) {
          failures.push({
            operation: (error as { operation?: string }).operation ?? "",
            message: (error as Error).message,
          });
        }
      }
      expect(failures).toHaveLength(2);
      expect(failures[0]).toEqual(failures[1]);
      expect(failures[0]?.message).toBe(
        "unsafe source metadata encountered before manifest construction",
      );
      expect(JSON.stringify(failures)).not.toContain("user@university.no");
      expect(JSON.stringify(failures)).not.toContain("other@university.no");
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows source code beneath logs-named directories", async () => {
    const root = gitFixture();
    try {
      const path = "src/AppBundle/Controller/logs/Token.php";
      putFixture(root, "src/AppBundle/Controller/Safe.php", "<?php\nfinal class Safe {}\n");
      putFixture(root, path, "<?php\n$token = 'fixture';\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
      const snapshot = await Effect.runPromise(
        scanRootEffect(root, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const file = snapshot.files.find((entry) => entry.path === path);
      expect(file?.unsafe).toBe(false);
      expect(file?.digest).toMatch(/^sha256:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects every ignored parseable authority file", async () => {
    const root = gitFixture();
    try {
      putFixture(root, ".gitignore", "app/config/routing.yml\\n");
      putFixture(root, "app/config/routing.yml", "home:\\n  path: /home\\n");
      execFileSync("git", ["-C", root, "add", ".gitignore"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
      await expect(
        Effect.runPromise(scanRootEffect(root, "legacy").pipe(Effect.provide(NodeRuntimeLayer))),
      ).rejects.toMatchObject({
        operation: "scan_root",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores legacy var logs before reading bytes", async () => {
    const root = mkdtempSync("/tmp/functional-parity-tree-");
    try {
      const path = "var/logs/.gitkeep";
      putFixture(root, path, "\xff\xfe");
      const snapshot = await Effect.runPromise(
        scanRootEffect(root, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const file = snapshot.files.find((entry) => entry.path === path);
      expect(file?.bytes).toBeNull();
      expect(file?.byteLength).toBeNull();
      expect(file?.digest).toBeNull();
      expect(effectiveIgnoreRule("legacy", path)?.pattern).toBe("var/logs/**");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("CLI write returns fixed unsafe report without projection artifacts", () => {
    const roots = [gitFixture(), gitFixture()];
    const unsafePaths = [
      "apps/server/src/App/Foo/Controller/user@university.no.php",
      "apps/server/src/App/Foo/Controller/other@university.no.php",
    ];
    const legacyRoots = roots.map(() => gitFixture());
    try {
      const reports: string[] = [];
      for (const [index, root] of roots.entries()) {
        putFixture(root, unsafePaths[index] ?? unsafePaths[0], "<?php\nfinal class User {}\n");
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
        const receipt = cliReport(root, legacyRoots[index] ?? legacyRoots[0] ?? root, "write");
        const cli = { status: receipt.status, stderr: "", stdout: receipt.output };
        expect(cli.status).toBe(6);
        expect(cli.stderr).not.toContain("user@university.no");
        expect(cli.stderr).not.toContain("other@university.no");
        reports.push(cli.stdout);
      }
      expect(reports[0]).toBe(reports[1]);
      const report = JSON.parse(reports[0] ?? "{}") as Record<string, unknown>;
      expect(report.status).toBe("source_unavailable");
      expect(report.projection_write).toEqual({ status: "blocked", target_ref: null });
      expect(report.source_manifest_sha256).toBeNull();
      expect(report.inventory_artifact_sha256).toEqual({});
      expect(report.verification).toMatchObject({
        schema_validation: false,
        cross_reference_validation: false,
      });
      expect(reports.join("\n")).not.toContain("user@university.no");
      expect(reports.join("\n")).not.toContain("other@university.no");
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      for (const legacyRoot of legacyRoots) rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

describe("source safety boundary", () => {
  test("blocks only unsafe path classes before hashing", () => {
    for (const path of [
      "config/credentials.json",
      "keys/server.pem",
      "var/backups/db.sql",
      "payloads/request.ndjson",
      "apps/server/config/jwt/private.pem",
      "apps/server/config/jwt/public.pem",
    ]) {
      expect(isUnsafeSourcePath(path)).toBe(true);
    }
    for (const path of [
      ".env",
      ".env.local",
      "apps/homepage/.env.example",
      "apps/dashboard/.env.example",
      "apps/server/.env.test",
      "apps/server/.env.staging",
      "migrations/0001.sql",
      "app/Resources/assets/js/ckeditor/skins/bootstrapck/npm-debug.log",
      "var/logs/.gitkeep",
    ]) {
      expect(isUnsafeSourcePath(path)).toBe(false);
    }
  });

  describe("safe source census regressions", () => {
    test("classifies tracked legacy logs before reading or hashing bytes", async () => {
      const root = gitFixture();
      try {
        const paths = [
          "var/logs/.gitkeep",
          "app/Resources/assets/js/ckeditor/skins/bootstrapck/npm-debug.log",
        ];
        for (const path of paths) {
          const target = join(root, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from([0xff, 0xfe, 0xfd]));
        }
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "ignored-logs"]);
        const snapshot = await Effect.runPromise(
          scanRootEffect(root, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
        );
        const context = createManifestContextFromSnapshots(snapshot, snapshot);
        for (const path of paths) {
          const file = snapshot.files.find((entry) => entry.path === path);
          const census = context.rootCensus.find(
            (entry) => entry.root_ref === "legacy" && entry.path === path,
          );
          expect(file).toMatchObject({
            bytes: null,
            byteLength: null,
            digest: null,
            availability: "available",
            unsafe: false,
          });
          expect(census).toMatchObject({
            path,
            classification: "ignored",
            byte_length: null,
            sha256: null,
            source_ref_ids: [],
          });
          expect(census?.ignore_rule_id).toMatch(/^ignore-[a-f0-9]{64}$/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    test("keeps fixture bytes out of the root census and source-set digest", async () => {
      const root = gitFixture();
      const path = "apps/server/var/parity/api-operations.json";
      const payload = JSON.stringify([
        {
          resource_class_ref: "App\\Fixture\\Api\\Resource\\FixtureResource",
          operation_name: "Get",
          method: "GET",
          uri_template: "/fixture",
          operation_id: "fixture_get",
        },
      ]);
      try {
        putFixture(root, path, payload);
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "fixture-runtime"]);
        const snapshot = await Effect.runPromise(
          scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
        );
        const baselineContext = createManifestContextFromSnapshots(snapshot, snapshot);
        const baselineBytes = new TextEncoder().encode(
          payload.replace("fixture_get", "fixture_other"),
        );
        await Effect.runPromise(
          collectApiOperations(
            baselineContext,
            sha256("fixture-boundary-baseline"),
            [],
            true,
            undefined,
            { path, bytes: baselineBytes },
          ).pipe(Effect.provide(NodeRuntimeLayer)),
        );
        const baseline = finalizeManifest(baselineContext);
        const context = createManifestContextFromSnapshots(snapshot, snapshot);
        const bytes = readFileSync(join(root, path));
        await Effect.runPromise(
          collectApiOperations(context, sha256("fixture-boundary"), [], true, undefined, {
            path,
            bytes,
          }).pipe(Effect.provide(NodeRuntimeLayer)),
        );
        const manifest = finalizeManifest(context);
        const census = manifest.root_census.find((entry) => entry.path === path);
        expect(snapshot.files.find((entry) => entry.path === path)).toMatchObject({
          bytes: null,
          byteLength: null,
          digest: null,
          availability: "available",
        });
        expect(census).toMatchObject({
          path,
          classification: "ignored",
          byte_length: null,
          sha256: null,
          source_ref_ids: [],
        });
        expect(manifest.source_set_sha256).toBe(baseline.source_set_sha256);
        expect(JSON.stringify(manifest.root_census)).not.toContain("fixture_get");
        expect(manifest.sources.find((source) => source.out_of_band === true)).toMatchObject({
          path: `fixture://runtime/${path}`,
          byte_length: bytes.byteLength,
          sha256: sha256(bytes),
          capture_mode: "runtime",
          out_of_band: true,
        });
        expect(
          manifest.runtime_observations.some((observation) => observation.out_of_band === true),
        ).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("allows the real test env class with explicit sentinels and preserves staging flags", () => {
      const envPath = "apps/server/.env.test";
      const envBytes = new TextEncoder().encode(
        "APP_ENV=test\nAPP_SECRET=test_app_secret_for_testing_only\nDATABASE_URL=sqlite:///:memory:\nJWT_PASSPHRASE=\n",
      );
      expect(sourceTextSafetyReason(envPath, envBytes)).toBeNull();
      expect(unsafeEnvSourceTextReason(new TextDecoder().decode(envBytes), envPath)).toBeNull();
      const staging = readFileSync(join(repoRoot, "apps/server/.env.staging"), "utf8");
      expect(staging).not.toContain("DATABASE_URL=");
      expect(staging).toContain("APP_ENV=staging");
      expect(staging).toContain("SLACK_DISABLED=true");
      expect(staging).toContain("SMS_DISABLE=true");
    });

    test("accepts migration 0012 DDL comparisons without digest admission", () => {
      const migrationPath =
        "packages/database/migrations/0012-native-recruitment-invitation-response.sql";
      const migration = readFileSync(join(repoRoot, migrationPath));
      const migrationText = new TextDecoder().decode(migration);
      expect(unsafeSqlSourceTextReason(migrationText, migrationPath)).toBeNull();
      expect(sourceTextSafetyReason(migrationPath, migration)).toBeNull();
      expect(
        unsafeSqlSourceTextReason(
          "CREATE TABLE outbox (payload_json jsonb CHECK (jsonb_typeof(payload_json) = 'object'));",
        ),
      ).toBeNull();
      expect(
        unsafeSqlSourceTextReason("SELECT user_id FROM users WHERE user_id = current_user;"),
      ).toBeNull();
    });

    test("rejects sensitive UPDATE SET and procedural assignments", () => {
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE outbox SET payload_json = '{\"responseMessage\":\"concrete\"}'::jsonb WHERE effect_id = 'effect-1';",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(unsafeSqlSourceTextReason("api_token := 'concrete-token';")).toBe("UNSAFE_SOURCE");
      expect(unsafeSqlSourceTextReason("SET password TO 'concrete-password';")).toBe(
        "UNSAFE_SOURCE",
      );
      expect(unsafeSqlSourceTextReason("SET LOCAL api_token TO 'concrete-token';")).toBe(
        "UNSAFE_SOURCE",
      );
      expect(unsafeSqlSourceTextReason("SELECT @password = 'concrete-password';")).toBe(
        "UNSAFE_SOURCE",
      );
    });

    test("rejects procedural sensitive assignments without treating comparisons as writes", () => {
      const assertUnsafeAssignment = (statement: string): void => {
        expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
        expect(
          sourceTextSafetyReason(
            "packages/database/migrations/procedural-sensitive-assignment.sql",
            new TextEncoder().encode(statement),
          ),
        ).toBe("UNSAFE_SOURCE");
      };
      assertUnsafeAssignment("password = 'concrete-password';");
      assertUnsafeAssignment("api_token = 'concrete-token';");
      assertUnsafeAssignment(`
        CREATE FUNCTION rotate_credentials(should_rotate boolean) RETURNS void
        LANGUAGE plpgsql AS $procedure$
        BEGIN
          password = 'concrete-password';
          IF should_rotate THEN
            api_token = 'concrete-token';
          END IF;
        END;
        $procedure$;
      `);
      for (const comparison of [
        "SELECT user_id FROM users WHERE password = $1;",
        "SELECT user_id FROM users JOIN credentials ON credentials.password = $1;",
        "CREATE TABLE credential_check (password text, confirmation text, CHECK (password = confirmation));",
        `DO $procedure$
         BEGIN
           IF password = $1 THEN
             NULL;
           END IF;
         END;
         $procedure$;`,
      ]) {
        expect(unsafeSqlSourceTextReason(comparison)).toBeNull();
        expect(
          sourceTextSafetyReason(
            "packages/database/migrations/sensitive-comparison.sql",
            new TextEncoder().encode(comparison),
          ),
        ).toBeNull();
      }
    });

    test("allows strict parameterized INSERT SELECT recordsets", () => {
      const statement = `
        INSERT INTO person_contact_profiles (person_id, email, revision)
        SELECT seed_row.person_id, seed_row.email, seed_row.revision
        FROM jsonb_to_recordset($1::jsonb) AS seed_row(
          person_id text,
          email text,
          revision integer
        )
        WHERE TRUE
        ON CONFLICT (person_id) DO NOTHING;
      `;
      expect(unsafeSqlSourceTextReason(statement)).toBeNull();
      expect(
        sourceTextSafetyReason(
          "packages/database/migrations/parameterized-recordset-fixture.sql",
          new TextEncoder().encode(statement),
        ),
      ).toBeNull();
      const seedPath = "apps/dashboard/e2e/native-team-interest-mailing-list-seed.sql";
      const seed = readFileSync(join(repoRoot, seedPath));
      expect(unsafeSqlSourceTextReason(new TextDecoder().decode(seed), seedPath)).toBeNull();
      expect(sourceTextSafetyReason(seedPath, seed)).toBeNull();
    });

    test("rejects literal, VALUES, and mixed recordset INSERTs", () => {
      for (const statement of [
        "INSERT INTO person_profiles (person_id) VALUES ('person-literal');",
        "INSERT INTO person_profiles (person_id) VALUES ($1);",
        `INSERT INTO person_profiles (person_id, first_name)
         SELECT seed_row.person_id, 'Literal'
         FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text, first_name text);`,
        `INSERT INTO person_profiles (person_id, revision)
         SELECT seed_row.person_id, 0
         FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text, revision integer);`,
        `INSERT INTO person_profiles (person_id)
         SELECT seed_row.person_id
         FROM jsonb_to_recordset('[{"person_id":"person-literal"}]'::jsonb)
           AS seed_row(person_id text);`,
      ]) {
        expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
      }
    });
    test("rejects comment stacking and malformed recordset aliases", () => {
      const safeRecordset = `
        INSERT INTO person_profiles (person_id)
        SELECT seed_row.person_id
        FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text);
      `;
      for (const statement of [
        `${safeRecordset}
         /* stacked literal DML must not inherit the first statement's authority */
         INSERT INTO person_profiles (person_id) VALUES ('person-literal');`,
        `${safeRecordset}
         -- assignment after a safe statement remains independently classified
         UPDATE users SET password = 'concrete-password';`,
        `${safeRecordset}
         SELECT @password = 'concrete-password';`,
        "/*!50000 INSERT INTO person_profiles (person_id) VALUES ('person-literal') */;",
        `INSERT/**/INTO person_profiles (person_id)
         SELECT seed_row.person_id
         FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text, email text);`,
        `INSERT INTO person_profiles (person_id)
         SELECT other_row.person_id
         FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text);`,
        `INSERT INTO person_profiles (person_id)
         SELECT seed_row.person_id
         FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text;`,
      ]) {
        expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
      }
    });

    test("allows the real migration DDL and rejects literal SQL data", () => {
      const migrationPath = "packages/domain/src/tutor/migrations/0001-tutor-event-store.sql";
      const migration = readFileSync(join(repoRoot, migrationPath));
      expect(sourceTextSafetyReason(migrationPath, migration)).toBeNull();
      expect(unsafeSqlSourceTextReason(new TextDecoder().decode(migration))).toBeNull();
      expect(unsafeSqlSourceTextReason("CREATE TABLE users (id TEXT NOT NULL);")).toBeNull();
      expect(unsafeSqlSourceTextReason("UPDATE users SET password = '${PASSWORD}';")).toBeNull();
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET `password` /*!50000 = 'correct-horse-battery-staple' */;",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET \"auth.secret\" /*!50000 = 'correct-horse-battery-staple' */;",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET password = '/*correct-horse-battery-staple*/';",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason("UPDATE users SET password = '--correct-horse-battery-staple';"),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason("SET @JWT_PASSPHRASE := 'correct-horse-battery-staple';"),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason("UPDATE users SET [password] = 'correct-horse-battery-staple';"),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET \"password\" = '--correct-horse-battery-staple';",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET password = '${PASSWORD}'; # password = 'secret'",
        ),
      ).toBeNull();
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET password /*!50000\n-- ignored\n= 'correct-horse-battery-staple'\n*/;",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(unsafeSqlSourceTextReason("/*!50000 SET password = 'secret' /* nested */ */;")).toBe(
        "UNSAFE_SOURCE",
      );
      expect(unsafeSqlSourceTextReason("/* unterminated password = 'secret';")).toBe(
        "UNSAFE_SOURCE",
      );
      expect(
        unsafeSqlSourceTextReason("INSERT INTO users (email) VALUES ('alice@university.no');"),
      ).toBe("UNSAFE_SOURCE");
      expect(unsafeSqlSourceTextReason("UPDATE users SET password = 'concrete-password';")).toBe(
        "UNSAFE_SOURCE",
      );
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET (\"password\", \"display_name\") = ('correct-horse-battery-staple', 'Alice');",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeSqlSourceTextReason(
          "UPDATE users SET ((`password`), [display_name]) = ('concrete-password', 'Alice');",
        ),
      ).toBe("UNSAFE_SOURCE");
    });
    test("rejects quoted sensitive collector stream assignments before hashing", () => {
      for (const output of [
        'fatal: {"password":"correct-horse-battery-staple"}',
        '{"password":"correct-horse-battery-staple"',
        "password = correct-horse-battery-staple",
        '{"api_key":"concrete-key"}',
        '{"properties":{"newPassword":{"example":"correct-horse-battery-staple"}}}',
        '{"properties":{"client.secret":{"default":"correct-horse-battery-staple"}}}',
        '{"properties":{"newPassword":{"example":"correct-horse-battery-staple"}',
        '{"properties":{"newPassword":{"examples":["correct-horse-battery-staple"]}}}',
        '{"properties":{"newPassword":{"defaults":["correct-horse-battery-staple"]}}}',
        '{"properties":{"newPassword":{"values":["correct-horse-battery-staple"]}}}',
      ]) {
        expect(unsafeSourceTextReason(output)).toBe("UNSAFE_SOURCE");
      }
      expect(
        unsafeSourceTextReason('{"properties":{"newPassword":{"example":"${PASSWORD}"}}}'),
      ).toBeNull();
      expect(
        unsafeSourceTextReason('{"properties":{"newPassword":{"examples":["${PASSWORD}"]}}}'),
      ).toBeNull();
      expect(unsafeSourceTextReason('{"operationId":"fixture_api"}')).toBeNull();
    });

    test("rejects malicious env and SQL before any digest or source ID", async () => {
      expect(
        unsafeEnvSourceTextReason(
          "APP_SECRET=test_app_secret_for_testing_only",
          "apps/server/.env.test",
        ),
      ).toBeNull();
      expect(
        unsafeEnvSourceTextReason(
          "APP_SECRET=test_app_secret_for_testing_only",
          "apps/server/.env.production",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(
        unsafeEnvSourceTextReason(
          "APP.SECRET=test_app_secret_for_testing_only",
          "apps/server/.env.test",
        ),
      ).toBe("UNSAFE_SOURCE");
      expect(unsafeEnvSourceTextReason("CLIENT.SECRET=", "apps/server/.env.test")).toBeNull();
      expect(unsafeEnvSourceTextReason("APP_ENV=@placeholder@", "apps/server/.env.test")).toBe(
        "UNSAFE_SOURCE",
      );
      const cases = [
        ["apps/server/.env.test", "DATABASE_URL=mysql://vektor:concrete-secret@db/app\n"],
        ["apps/server/.env.test", "JWT_PASSPHRASE=@correct-horse-battery-staple@\n"],
        ["apps/server/.env.test", "APP.SECRET=@correct-horse-battery-staple@\n"],
        ["apps/server/.env.production", "APP_SECRET=@credential@\n"],
        ["apps/server/.env.production", "APP_PHONE=@phone@\n"],
        ["apps/server/.env.production", "APP_SECRET=@correct-horse-battery-staple@\n"],
        ["apps/server/.env.production", "APP_SECRET=${PRODUCTION_SECRET}\n"],
        ["apps/server/.env.production", "APP_SECRET=<operator-supplied-secret>\n"],
        [
          "packages/domain/src/tutor/migrations/0002-malicious.sql",
          "INSERT INTO users (email) VALUES ('alice@university.no');\n",
        ],
        [
          "packages/domain/src/tutor/migrations/0003-malicious-tuple.sql",
          "UPDATE users SET (\"password\", \"display_name\") = ('correct-horse-battery-staple', 'Alice');\n",
        ],
        [
          "packages/domain/src/tutor/migrations/0004-malicious-executable-comment.sql",
          "UPDATE users SET `password` /*!50000 = 'correct-horse-battery-staple' */;\n",
        ],
      ] as const;
      for (const [path, contents] of cases) {
        const root = gitFixture();
        try {
          putFixture(root, path, contents);
          execFileSync("git", ["-C", root, "add", "."]);
          execFileSync("git", ["-C", root, "commit", "-qm", "unsafe-source"]);
          await expect(
            Effect.runPromise(scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer))),
          ).rejects.toMatchObject({
            operation: "scan_root",
            message: "unsafe source content encountered before manifest construction",
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });

    test("rejects invalid UTF-8 in matched textual source before hashing", async () => {
      const root = gitFixture();
      try {
        const path = join(root, "apps/server/.env.test");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from([0x41, 0xff, 0xfe]));
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "invalid-utf8"]);
        await expect(
          Effect.runPromise(scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer))),
        ).rejects.toMatchObject({
          operation: "scan_root",
          message: "invalid UTF-8 source content encountered before manifest construction",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("excludes the projection mount before source enumeration", async () => {
      const root = gitFixture();
      try {
        putFixture(
          root,
          "evidence/functional-parity/unsafe.env",
          "DATABASE_URL=mysql://vektor:secret@db/app\n",
        );
        execFileSync("git", ["-C", root, "add", "."]);
        execFileSync("git", ["-C", root, "commit", "-qm", "projection"]);
        const snapshot = await Effect.runPromise(
          scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
        );
        expect(
          snapshot.files.some((entry) => entry.path.startsWith("evidence/functional-parity/")),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("keeps authority source paths hashable", () => {
    for (const path of [
      "app/config/routing.yml",
      "composer.lock",
      "tests/AppBundle/Service/CompanyEmailMakerTest.php",
      "tests/AppBundle/Controller/TeamInterestControllerTest.php",
      "src/AppBundle/Controller/AccessRuleController.php",
      "apps/server/src/App/Interview/Infrastructure/Subscriber/InterviewSubscriber.php",
      "apps/server/tests/AppBundle/Api/AdminUserWriteApiTest.php",
      "apps/homepage/src/routes/_home.team.bergen.styret.tsx",
      "apps/server/tools/security-h3/0015/generate.ts",
    ]) {
      expect(isUnsafeSourcePath(path)).toBe(false);
    }
  });
  test("keeps real-tree-shaped hashed assets hashable", async () => {
    const root = gitFixture();
    const hashedAsset =
      "apps/server/src/App/Content/Controller/Asset_9f2A7c4E1dB8cF0a7E3d9C5b1A6f2D8e4.png";
    try {
      putFixture(root, hashedAsset, "fixture-bytes\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
      const snapshot = await Effect.runPromise(
        scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const asset = snapshot.files.find((file) => file.path === hashedAsset);
      expect(asset?.unsafe).toBe(false);
      expect(unsafeSourceScalarReason(hashedAsset, "path")).toBeNull();
      expect(
        unsafeSourceScalarReason("Asset_9f2A7c4E1dB8cF0a7E3d9C5b1A6f2D8e4", "symbol"),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("blocks credential-bearing owner symbols before source IDs", () => {
    for (const symbol of [
      "sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3Controller",
      "ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3",
      "[github_token_redacted]",
      "Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1Controller",
      "App\\Content\\Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1Controller::index",
    ]) {
      expect(unsafeSourceScalarReason(symbol, "symbol")).toBe("UNSAFE_SOURCE");
    }
    expect(
      unsafeSourceScalarReason("App\\Content\\Controller\\HomeController::index", "symbol"),
    ).toBeNull();
  });
  test("blocks standard credential formats in every emitted scalar", () => {
    for (const [value, field] of [
      ["sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller"],
      ["ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3", "route_name"],
      ["AKIA1234567890ABCDEF", "resource"],
      ["xoxb-12345678-1234567890", "controller"],
      ["AIzaSyA1234567890abcdefghijkl", "route_name"],
      [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1",
        "_controller",
      ],
      ["Authorization: Bearer Ab9xY7qP4wR8tU2nM6kL9zC3", "resource"],
      ["Basic YTpi", "controller"],
      ["Bearer abc.def~ghi", "route_name"],
      ["[github_token_redacted]", "controller"],
      ["svc:token=REAL_SECRET", "_controller"],
    ] as const) {
      expect(unsafeScalarReason(value, field)).toBe("UNSAFE_SOURCE");
      expect(sanitizeScalar(value, field)).toBeNull();
    }
    expect(unsafeScalarReason("AppBundle:Token:index", "controller")).toBeNull();
    expect(unsafeScalarReason(":sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller")).toBe(
      "UNSAFE_SOURCE",
    );
    expect(sanitizeScalar(":sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller")).toBeNull();
    expect(
      unsafeSourceScalarReason("apps/server/src/App/Token/Issuer.php", "source_path"),
    ).toBeNull();
    expect(unsafeSourceScalarReason("src/token=REAL_SECRET.php", "source_path")).toBe(
      "UNSAFE_SOURCE",
    );
    expect(unsafeSourceScalarReason("password-reset.spec.ts", "source_path")).toBeNull();
    expect(unsafeScalarReason("reset_password", "route_name")).toBeNull();
    expect(unsafeScalarReason("forgot_password", "route_name")).toBeNull();
    expect(unsafeScalarReason("profile_edit_password", "route_name")).toBeNull();
    expect(unsafeScalarReason("token", undefined)).toBeNull();
    expect(sanitizeScalar("token")).toBe("token");
  });

  test("blocks unsafe controller tokens before write promotion", async () => {
    const root = mkdtempSync("/tmp/functional-parity-controller-token-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    try {
      putFixture(
        legacyRoot,
        "app/config/routing.yml",
        'unsafe_controller:\n  path: /safe\n  defaults: { _controller: sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\nunsafe_resource:\n  resource: ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3\n  path: /resource\n  methods: [GET]\nunsafe_assignment:\n  path: /assignment\n  defaults: { _controller: "svc:token=REAL_SECRET" }\n  methods: [GET]\nunsafe_basic:\n  path: /basic\n  defaults: { _controller: "Basic YTpi" }\n  methods: [GET]\nunsafe_bearer_resource:\n  resource: "Bearer abc.def~ghi"\n  path: /bearer\n  methods: [GET]\n"Bearer abc.def~ghi":\n  path: /bearer-name\n  methods: [GET]\nunsafe_jwt_controller:\n  path: /jwt\n  defaults: { _controller: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1 }\n  methods: [GET]\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1:\n  path: /jwt-name\n  methods: [GET]\n',
      );
      putFixture(
        monoRoot,
        "apps/server/config/routes.yaml",
        "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n",
      );
      await expect(runWithIntentAuthority(monoRoot, legacyRoot, "write")).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks YAML and PHP opaque methods before report promotion", () => {
    const cases = [
      {
        routing: "unsafe_yaml:\n  path: /unsafe-yaml\n  methods: [OpaqueCredentialMethod]\n",
        controller: "<?php\nfinal class FixtureController {}\n",
        needle: "OpaqueCredentialMethod",
      },
      {
        routing: "safe:\n  path: /safe\n  methods: [GET]\n",
        controller:
          '<?php\n/** @Route(path="/unsafe-php", methods={"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1"}) */\nfinal class FixtureController {}\n',
        needle: "eyJhbGciOiJIUzI1NiJ9",
      },
      {
        routing: "safe:\n  path: /safe\n  methods: [GET]\n",
        controller:
          '<?php\n/** @Route(path="/unsafe-php", methods={"GET]Bearer Ab9xY7qP4wR8tU2nM6kL9zC3"}) */\nfinal class FixtureController {}\n',
        needle: "GET]Bearer",
      },
    ] as const;
    const roots = cases.map(() => mkdtempSync("/tmp/functional-parity-method-"));
    try {
      for (const [index, root] of roots.entries()) {
        const legacyRoot = join(root, "legacy");
        const monoRoot = join(root, "mono");
        const fixture = cases[index] ?? cases[0];
        putParityBaseline(legacyRoot, monoRoot, fixture.routing);
        putFixture(legacyRoot, "src/AppBundle/Controller/MethodController.php", fixture.controller);
        const receipt = cliReport(monoRoot, legacyRoot, "write");
        expect(receipt.status).toBe(6);
        expect(receipt.report).toMatchObject({
          status: "source_unavailable",
          exit_code: 6,
          source_manifest_sha256: null,
          inventory_artifact_sha256: {},
          projection_write: { status: "blocked", target_ref: null },
          verification: { schema_validation: false, cross_reference_validation: false },
        });
        expect(receipt.output).not.toContain(fixture.needle);
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
  test("blocks namespaced opaque controller owners before report promotion", () => {
    const root = mkdtempSync("/tmp/functional-parity-namespaced-owner-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    const token = "Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1";
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n");
      putFixture(
        legacyRoot,
        "src/AppBundle/Controller/OpaqueController.php",
        `<?php\nnamespace App\\Content;\nfinal class ${token}Controller { /** @Route(path="/safe", methods={"GET"}) */ public function index(): void {} }\n`,
      );
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.status).toBe(6);
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      expect(receipt.output).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects decoy and duplicate PHP method fields", () => {
    const root = mkdtempSync("/tmp/functional-parity-method-duplicate-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    const token = "Bearer abc.def~ghi";
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n");
      putFixture(
        monoRoot,
        "apps/server/src/App/Fixture/Controller/MethodController.php",
        `<?php\nfinal class MethodController { #[Route(path: "/decoy", name: "methods: [GET],", /* methods: ["GET"], [ */ methods: ["${token}"], methods: ["GET"])] public function index(): void {} }\n`,
      );
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.status).toBe(6);
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      expect(receipt.output).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects PHP trivia between method key and value", () => {
    const root = mkdtempSync("/tmp/functional-parity-method-trivia-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    const token = "Bearer abc.def~ghi";
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n");
      putFixture(
        monoRoot,
        "apps/server/src/App/Fixture/Controller/MethodTriviaController.php",
        `<?php\nfinal class MethodTriviaController { #[Route(path: "/opaque", name: "opaque", methods /* field trivia */ : /* value trivia */ ["${token}"])] public function index(): void {} }\n`,
      );
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.status).toBe(6);
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      expect(receipt.output).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects bare-CR PHP method trivia", () => {
    for (const [label, trivia] of [
      ["slash", "// trivia\r"],
      ["hash", "# trivia\r"],
    ] as const) {
      const root = mkdtempSync(`/tmp/functional-parity-method-cr-${label}-`);
      const legacyRoot = join(root, "legacy");
      const monoRoot = join(root, "mono");
      const token = "Bearer abc.def~ghi";
      try {
        putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n");
        putFixture(
          monoRoot,
          `apps/server/src/App/Fixture/Controller/MethodCr${label}.php`,
          `<?php\nfinal class MethodCr${label} { #[Route(path: "/opaque", name: "opaque", methods ${trivia}: ["${token}"])] public function index(): void {} }\n`,
        );
        const receipt = cliReport(monoRoot, legacyRoot, "write");
        expect(receipt.status).toBe(6);
        expect(receipt.report).toMatchObject({
          status: "source_unavailable",
          exit_code: 6,
          source_manifest_sha256: null,
          inventory_artifact_sha256: {},
          projection_write: { status: "blocked", target_ref: null },
        });
        expect(receipt.output).not.toContain(token);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("blocks actual sensitive scalars but keeps semantic placeholders", () => {
    for (const [value, field] of [
      ["https://example.invalid/callback?token={token}", "path"],
      ["email", undefined],
      ["token", undefined],
      ["{token}", "token"],
      ["alice@university.no", undefined],
      ["+47 912 34 567", undefined],
      ["Ab9!xY7#qP4$wR8%tU2&nM6@kL9*zC3", "secret"],
    ] as const) {
      if (
        value === "alice@university.no" ||
        value.startsWith("+47") ||
        field === "secret" ||
        field === "token"
      )
        expect(unsafeScalarReason(value, field)).toBe("UNSAFE_SOURCE");
      else expect(sanitizeScalar(value, field)).toBe(value);
    }
  });
  test("allows route placeholders but blocks literal route PII and credentials", () => {
    expect(unsafeScalarReason("/reset/{token}", "path")).toBeNull();
    for (const value of [
      "/reset?token=REAL_SECRET",
      "/contact/alice@university.no",
      "/call/+47 912 34 567",
    ]) {
      expect(unsafeScalarReason(value, "path")).toBe("UNSAFE_SOURCE");
      expect(sanitizeScalar(value, "path")).toBeNull();
    }
  });
  test("blocks exact credential, phone, entropy, and controller payloads", async () => {
    for (const value of [
      "/contact/user@university.no",
      "/call/+4791234567",
      "/reset/Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1",
      "/reset/0123456789abcdef0123456789abcdef",
      "/oauth?client_secret=REAL_SECRET",
    ]) {
      expect(unsafeScalarReason(value, "path")).toBe("UNSAFE_SOURCE");
      expect(sanitizeScalar(value, "path")).toBeNull();
    }
    expect(unsafeScalarReason("/assets/0123456789abcdef0123456789abcdef", "path")).toBeNull();
    expect(unsafeScalarReason("/reset/{token}", "path")).toBeNull();
    expect(unsafeScalarReason("/reset/<token>", "path")).toBeNull();
    expect(unsafeScalarReason("/reset/:token", "path")).toBeNull();
    const root = mkdtempSync("/tmp/functional-parity-controller-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    try {
      putFixture(
        legacyRoot,
        "app/config/routing.yml",
        "one:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\ntwo:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\n",
      );
      putFixture(
        monoRoot,
        "apps/server/config/routes.yaml",
        "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n",
      );
      await expect(runWithIntentAuthority(monoRoot, legacyRoot, "write")).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("blocks projection writes for unsafe route scalars", async () => {
    const root = mkdtempSync("/tmp/functional-parity-route-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    try {
      putFixture(
        legacyRoot,
        "app/config/routing.yml",
        "unsafe:\n  path: /reset?token=REAL_SECRET\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [GET]\n",
      );
      putFixture(
        monoRoot,
        "apps/server/config/routes.yaml",
        "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n",
      );
      await expect(runWithIntentAuthority(monoRoot, legacyRoot, "write")).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("blocks composed route PII before receipt promotion", () => {
    const root = mkdtempSync("/tmp/functional-parity-composed-pii-");
    const legacyRoot = join(root, "legacy");
    const monoRoot = join(root, "mono");
    const hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    try {
      putParityBaseline(
        legacyRoot,
        monoRoot,
        `unsafe_email:\n  path: /notify/user@example.invalid/alice@university.no\n  methods: [GET]\nunsafe_phone:\n  path: /call/+4791234567/${hex}\n  methods: [GET]\n`,
      );
      const receipt = cliReport(monoRoot, legacyRoot, "write");
      expect(receipt.status).toBe(6);
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      });
      expect(receipt.output).not.toContain("alice@university.no");
      expect(receipt.output).not.toContain("+4791234567");
      expect(receipt.output).not.toContain(hex);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
