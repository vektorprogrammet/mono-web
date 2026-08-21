import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE_REF = /^src-[a-f0-9]{64}$/;
const REVISION_REF = /^rev-[A-Za-z0-9:_-]{1,160}$/;

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing prerequisite: ${name} is required to emit runtime evidence`);
  }
  return value;
};

export async function emitRuntimeEvidenceReceipt({ journeyRefId, stepIds, fixtureId }) {
  const outputPath = requiredEnvironment("RUNTIME_EVIDENCE_RECEIPT_PATH");
  const legacyRevisionRefId = requiredEnvironment("RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID");
  const monoRevisionRefId = requiredEnvironment("RUNTIME_EVIDENCE_MONO_REVISION_REF_ID");
  const runnerSourceRefIds = requiredEnvironment("RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!REVISION_REF.test(legacyRevisionRefId) || !REVISION_REF.test(monoRevisionRefId)) {
    throw new Error("Runtime evidence revision references are malformed");
  }
  if (runnerSourceRefIds.length === 0 || runnerSourceRefIds.some((value) => !SOURCE_REF.test(value))) {
    throw new Error("Runtime evidence runner source references are malformed");
  }
  const {
    canonicalRuntimeEvidenceBytes,
    makeRuntimeEvidenceReceipt,
    makeRuntimeEvidenceRegister,
    runtimeEvidenceDigest,
  } = await import("../../../packages/parity-inventory/src/runtime-evidence.ts");
  const normalizedStepIds = [...new Set(stepIds)].sort();
  const runnerDigest = runtimeEvidenceDigest({
    runner_source_ref_ids: runnerSourceRefIds,
    journey_ref_id: journeyRefId,
    step_ids: normalizedStepIds,
    runner_revision: "runner-inputs-v1",
  });
  const fixtureDigest = runtimeEvidenceDigest({ fixture_id: fixtureId, fixture_revision: "fixture-inputs-v1" });
  const artifactDigest = runtimeEvidenceDigest({
    artifact: "sanitized-browser-journey",
    journey_ref_id: journeyRefId,
    step_ids: normalizedStepIds,
    result: "passed",
  });
  const receipt = makeRuntimeEvidenceReceipt({
    journey_ref_id: journeyRefId,
    step_ids: normalizedStepIds,
    legacy_revision_ref_id: legacyRevisionRefId,
    mono_revision_ref_id: monoRevisionRefId,
    runner_source_ref_ids: runnerSourceRefIds,
    runner_digest: runnerDigest,
    fixture_digest: fixtureDigest,
    environment_kind: "local_disposable",
    exit_code: 0,
    result: "passed",
    artifact_digest: artifactDigest,
  });
  const bytes = canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt]));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { encoding: "utf8" });
  return receipt.receipt_ref_id;
}
