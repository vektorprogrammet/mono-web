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
  const passed = tests.length > 0 &&
    tests.every((spec) =>
      spec.ok &&
      spec.tests.length > 0 &&
      spec.tests.every((test) => test.resultStatuses.length > 0 && test.resultStatuses.every((status) => status === "passed")));
  if (!passed) throw new Error("Runtime evidence requires a non-empty passing Playwright report");
  return jsonBytes({ tests });
};
export const runtimeEvidenceOutcome = (sanitizedBytes) => {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sanitizedBytes));
  } catch {
    throw new Error("Runtime evidence artifact is not valid sanitized JSON");
  }
  const tests = value && typeof value === "object" && Array.isArray(value.tests) ? value.tests : [];
  const passed = tests.length > 0 &&
    tests.every((spec) =>
      spec && spec.ok === true &&
      Array.isArray(spec.tests) && spec.tests.length > 0 &&
      spec.tests.every((test) =>
        test && Array.isArray(test.resultStatuses) && test.resultStatuses.length > 0 &&
        test.resultStatuses.every((status) => status === "passed")));
  if (!passed) throw new Error("Runtime evidence requires a non-empty passing Playwright report");
  return { result: "passed", exit_code: 0 };
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
  runnerSourceInputBytes,
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
  const contentAddressedRevisionRef = /^rev-(?:legacy|mono)-(?:[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$/;
  const { unsafeScalarReason } = await import("../../../packages/parity-inventory/src/source-manifest.ts");
  if (!JOURNEY_REF.test(journeyRefId) || unsafeScalarReason(journeyRefId, "journey_ref_id") !== null) {
    throw new Error("Runtime evidence journey reference is malformed or unsafe");
  }
  if (
    !REVISION_REF.test(legacyRevisionRefId) ||
    !REVISION_REF.test(monoRevisionRefId) ||
    (!contentAddressedRevisionRef.test(legacyRevisionRefId) && unsafeScalarReason(legacyRevisionRefId, "legacy_revision_ref_id") !== null) ||
    (!contentAddressedRevisionRef.test(monoRevisionRefId) && unsafeScalarReason(monoRevisionRefId, "mono_revision_ref_id") !== null)
  ) {
    throw new Error("Runtime evidence revision references are malformed or unsafe");
  }
  if (
    runnerSourceRefIds.length === 0 ||
    new Set(runnerSourceRefIds).size !== runnerSourceRefIds.length ||
    runnerSourceRefIds.some((value) => !SOURCE_REF.test(value))
  ) {
    throw new Error("Runtime evidence runner source references are malformed");
  }
  if (!Array.isArray(runnerSourceInputBytes) || runnerSourceInputBytes.length !== runnerSourceRefIds.length) {
    throw new Error("Runtime evidence runner source inputs do not match source references");
  }
  const sourceInputs = new Map();
  for (const input of runnerSourceInputBytes) {
    if (input === null || typeof input !== "object" || !SOURCE_REF.test(input.sourceRefId)) {
      throw new Error("Runtime evidence runner source input reference is malformed");
    }
    if (sourceInputs.has(input.sourceRefId)) throw new Error("Runtime evidence runner source inputs are duplicated");
    sourceInputs.set(input.sourceRefId, asBytes(input.bytes, `runner source input ${input.sourceRefId}`));
  }
  if (sourceInputs.size !== runnerSourceRefIds.length || runnerSourceRefIds.some((sourceRefId) => !sourceInputs.has(sourceRefId))) {
    throw new Error("Runtime evidence runner source inputs do not match source references");
  }
  const normalizedStepIds = [...new Set(stepIds)].sort();
  if (normalizedStepIds.length === 0 || normalizedStepIds.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Runtime evidence step identifiers are malformed");
  }
  const runnerDigestParts = [...sourceInputs.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([sourceRefId, bytes]) => [sourceRefId, sha256Bytes(bytes)]);
  const runnerDigest = sha256Bytes(new TextEncoder().encode(JSON.stringify(runnerDigestParts)));
  const sanitizedArtifactBytes = asBytes(artifactBytes, "sanitized artifact bytes");
  const outcome = runtimeEvidenceOutcome(sanitizedArtifactBytes);
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
    runner_digest: runnerDigest,
    fixture_digest: sha256Bytes(asBytes(fixtureInputBytes, `fixture input bytes for ${fixtureId}`)),
    exit_code: outcome.exit_code,
    result: outcome.result,
    artifact_digest: sha256Bytes(sanitizedArtifactBytes),
  });
  const bytes = canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt]));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { encoding: "utf8" });
  return receipt.receipt_ref_id;
}
