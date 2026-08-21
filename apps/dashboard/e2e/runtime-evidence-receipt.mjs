import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE_REF = /^src-[a-f0-9]{64}$/;
const REVISION_REF = /^rev-[A-Za-z0-9:_-]{1,160}$/;
const JOURNEY_REF = /^intent:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value));

export const sanitizePlaywrightArtifact = (rawBytes) => {
  let report;
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes));
  } catch {
    throw new Error("Playwright JSON reporter output is not valid JSON");
  }
  const tests = [];
  const visitSuite = (suite) => {
    if (suite === null || typeof suite !== "object") return;
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (spec === null || typeof spec !== "object") continue;
        const specTests = Array.isArray(spec.tests) ? spec.tests : [];
        tests.push({
          title: typeof spec.title === "string" ? spec.title : "",
          ok: spec.ok === true,
          tests: specTests.map((test) => ({
            expectedStatus: test && typeof test.expectedStatus === "string" ? test.expectedStatus : "",
            resultStatuses: test && Array.isArray(test.results)
              ? test.results.map((result) => result && typeof result.status === "string" ? result.status : "").sort()
              : [],
          })),
        });
      }
    }
    if (Array.isArray(suite.suites)) for (const child of suite.suites) visitSuite(child);
  };
  if (report && Array.isArray(report.suites)) for (const suite of report.suites) visitSuite(suite);
  tests.sort((left, right) => {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  });
  return jsonBytes({ tests });
};
const sha256Bytes = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing prerequisite: ${name} is required to emit runtime evidence`);
  }
  return value;
};

const asBytes = (value, name) => {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`Missing prerequisite: ${name} must contain non-empty bytes`);
  }
  return value;
};

export async function emitRuntimeEvidenceReceipt({
  journeyRefId,
  stepIds,
  fixtureId,
  runnerInputBytes,
  fixtureInputBytes,
  artifactBytes,
}) {
  const receiptEnvironment = [
    "RUNTIME_EVIDENCE_RECEIPT_PATH",
    "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
  ];
  const configured = receiptEnvironment.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value.length > 0;
  });
  if (configured.length === 0) return null;
  const outputPath = requiredEnvironment("RUNTIME_EVIDENCE_RECEIPT_PATH");
  const legacyRevisionRefId = requiredEnvironment("RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID");
  const monoRevisionRefId = requiredEnvironment("RUNTIME_EVIDENCE_MONO_REVISION_REF_ID");
  const runnerSourceRefIds = requiredEnvironment("RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!JOURNEY_REF.test(journeyRefId)) throw new Error("Runtime evidence journey reference is malformed");
  if (!REVISION_REF.test(legacyRevisionRefId) || !REVISION_REF.test(monoRevisionRefId)) {
    throw new Error("Runtime evidence revision references are malformed");
  }
  if (runnerSourceRefIds.length === 0 || runnerSourceRefIds.some((value) => !SOURCE_REF.test(value))) {
    throw new Error("Runtime evidence runner source references are malformed");
  }
  const normalizedStepIds = [...new Set(stepIds)].sort();
  if (normalizedStepIds.length === 0 || normalizedStepIds.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Runtime evidence step identifiers are malformed");
  }
  const {
    canonicalRuntimeEvidenceBytes,
    makeRuntimeEvidenceReceipt,
    makeRuntimeEvidenceRegister,
  } = await import("../../../packages/parity-inventory/src/runtime-evidence.ts");
  const receipt = makeRuntimeEvidenceReceipt({
    journey_ref_id: journeyRefId,
    step_ids: normalizedStepIds,
    legacy_revision_ref_id: legacyRevisionRefId,
    mono_revision_ref_id: monoRevisionRefId,
    runner_source_ref_ids: runnerSourceRefIds,
    runner_digest: sha256Bytes(asBytes(runnerInputBytes, "runner input bytes")),
    fixture_digest: sha256Bytes(asBytes(fixtureInputBytes, `fixture input bytes for ${fixtureId}`)),
    environment_kind: "local_disposable",
    exit_code: 0,
    result: "passed",
    artifact_digest: sha256Bytes(asBytes(artifactBytes, "sanitized artifact bytes")),
  });
  const bytes = canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt]));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { encoding: "utf8" });
  return receipt.receipt_ref_id;
}
