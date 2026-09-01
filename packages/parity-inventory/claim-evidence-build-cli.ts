#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  migrateAcceptedIntentV1,
  type AcceptedIntentV2,
  type AtomicOperationCatalog,
  type AuthorityPin,
  type Backend,
  type CapabilityEvidenceReceipt,
  validateAcceptedIntentV2,
  validateAtomicOperationCatalog,
  validateCapabilityEvidenceV2,
} from "./src/capability-parity.js";
import {
  buildCapabilityEvidenceReceipt,
  buildCapabilityRuntimeEvidenceV2,
  buildClaimSpecificAcceptedIntentV2,
  claimEvidencePlan,
  type ClaimEvidenceCatalogs,
  type ClaimEvidenceReceiptRef,
  type ClaimIntentEvidencePlan,
  type ClaimObservationPlanEntry,
} from "./src/claim-evidence.js";
import { canonicalJson, sha256, stableId } from "./src/canonical.js";
import {
  JourneyObservationArtifactSchema,
  type JourneyObservationArtifact,
  type NativeJourneyRunManifest,
} from "./src/journey-evidence.js";
import {
  LegacyJourneyObservationArtifactSchema,
  type LegacyJourneyObservationArtifact,
  type LegacyJourneyRunManifest,
  type LegacyJourneyRunRecord,
} from "./src/legacy-journey-evidence.js";
import { inspectJsonMembers, isJsonObject } from "./src/json-safety.js";
import { Schema } from "effect";

interface Options {
  readonly evidenceRoot: string;
  readonly intentAuthority: string;
  readonly legacyManifest: string | null;
  readonly runtimeAuthority: string;
}

const parseArguments = (arguments_: readonly string[]): Options => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("CLAIM_EVIDENCE_BUILD_ARGUMENTS_INVALID");
    }
    values.set(name, value);
  }
  const evidenceRoot = values.get("--evidence-root");
  const intentAuthority = values.get("--intent-authority");
  const legacyManifest = values.get("--legacy-manifest") ?? null;
  const runtimeAuthority = values.get("--runtime-authority");
  const recognized = [
    "--evidence-root",
    "--intent-authority",
    "--legacy-manifest",
    "--runtime-authority",
  ];
  if (
    [...values.keys()].some((name) => !recognized.includes(name)) ||
    evidenceRoot === undefined ||
    intentAuthority === undefined ||
    runtimeAuthority === undefined
  ) {
    throw new Error("CLAIM_EVIDENCE_BUILD_ARGUMENTS_INVALID");
  }
  return {
    evidenceRoot: resolve(evidenceRoot),
    intentAuthority: resolve(intentAuthority),
    legacyManifest: legacyManifest === null ? null : resolve(legacyManifest),
    runtimeAuthority: resolve(runtimeAuthority),
  };
};

const parseJson = (bytes: string, label: string): unknown => {
  if (inspectJsonMembers(bytes) !== "valid") throw new Error(`${label}:JSON_INVALID`);
  const value = JSON.parse(bytes) as unknown;
  if (canonicalJson(value) !== bytes) throw new Error(`${label}:JSON_NONCANONICAL`);
  return value;
};

const git = async (cwd: string, arguments_: readonly string[]): Promise<string> => {
  const child = Bun.spawn(["git", "-C", cwd, ...arguments_], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`CLAIM_EVIDENCE_GIT_FAILED:${stderr.trim()}`);
  return stdout.trim();
};

const pinExternalAuthority = async (path: string, value: unknown): Promise<AuthorityPin> => {
  const repositoryRoot = await git(dirname(path), ["rev-parse", "--show-toplevel"]);
  const authorityPath = relative(repositoryRoot, path).replaceAll("\\", "/");
  if (authorityPath.length === 0 || authorityPath.startsWith("../")) {
    throw new Error("CLAIM_EVIDENCE_AUTHORITY_PATH_INVALID");
  }
  if ((await git(repositoryRoot, ["status", "--porcelain"])) !== "") {
    throw new Error("CLAIM_EVIDENCE_EXTERNAL_AUTHORITY_DIRTY");
  }
  const revision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const [blobOid, liveBlobOid, bytes] = await Promise.all([
    git(repositoryRoot, ["rev-parse", `${revision}:${authorityPath}`]),
    git(repositoryRoot, ["hash-object", authorityPath]),
    readFile(path, "utf8"),
  ]);
  if (blobOid !== liveBlobOid) throw new Error("CLAIM_EVIDENCE_EXTERNAL_AUTHORITY_DRIFT");
  if (!isJsonObject(value) || typeof value.schema_version !== "string") {
    throw new Error("CLAIM_EVIDENCE_EXTERNAL_AUTHORITY_SCHEMA_MISSING");
  }
  return {
    authority_path: authorityPath,
    blob_oid: blobOid,
    digest: sha256(bytes),
    repository_ref: `external:${basename(repositoryRoot)}`,
    revision,
    source_schema_version: value.schema_version,
  };
};

const decodeCatalog = (value: unknown, label: string): AtomicOperationCatalog => {
  if (!validateAtomicOperationCatalog(value)) throw new Error(`${label}:ATOMIC_SCHEMA_INVALID`);
  return value;
};

const requirePlan = (
  plans: readonly ClaimIntentEvidencePlan[],
  intentRefId: string,
): ClaimIntentEvidencePlan => {
  const plan = plans.find((entry) => entry.intent_ref_id === intentRefId);
  if (plan === undefined) throw new Error(`CLAIM_EVIDENCE_PLAN_MISSING:${intentRefId}`);
  return plan;
};
type BuildTimeJourneyArtifact =
  | { readonly backend: "legacy_symfony"; readonly value: LegacyJourneyObservationArtifact }
  | { readonly backend: "native_effect"; readonly value: JourneyObservationArtifact };

const backendPlanFor = (plan: ClaimIntentEvidencePlan, backend: Backend) =>
  backend === "legacy_symfony" ? plan.backends.legacy_symfony : plan.backends.native_effect;

const methodObserved = (
  observation: ClaimObservationPlanEntry,
  plan: ClaimIntentEvidencePlan,
  backend: Backend,
  artifact: BuildTimeJourneyArtifact,
  run: { readonly result: string },
): boolean => {
  const backendPlan = backendPlanFor(plan, backend);
  if (artifact.backend !== backend) return false;
  const observations = artifact.value.observations;
  const operation = backendPlan.operation_nodes.find(
    (entry) => entry.node_id === observation.node_id,
  );
  const matching =
    operation === undefined
      ? []
      : observations.filter(
          (entry) =>
            entry.method === operation.method && entry.path_template === operation.path_template,
        );
  switch (observation.observation_method) {
    case "bounded_exit_status":
      return run.result === "passed";
    case "exact_http_operation":
      if (operation === undefined) return false;
      if (operation.witness_id === backendPlan.witness_ids.accepted) {
        return matching.some((entry) => entry.status >= 200 && entry.status < 300);
      }
      if (operation.witness_id === backendPlan.witness_ids.authorization) {
        return matching.some(
          (entry) => entry.status === 401 || entry.status === 403 || entry.status === 404,
        );
      }
      return operation.operation_semantic.includes("readback")
        ? matching.some((entry) => entry.status >= 200 && entry.status < 300)
        : matching.some((entry) => entry.status >= 400);
    case "authorization_boundary_request":
      return (
        includesSemantic(
          artifact.value.verified_semantics.precondition_ids,
          observation.precondition_id,
        ) &&
        matching.some(
          (entry) => entry.status === 401 || entry.status === 403 || entry.status === 404,
        )
      );
    case "user_visible_boundary_read":
      return (
        includesSemantic(
          artifact.value.verified_semantics.assertion_ids,
          observation.assertion_id,
        ) && observations.some((entry) => entry.status >= 200 && entry.status < 300)
      );
    case "invalid_transition_with_state_readback":
      return (
        includesSemantic(
          artifact.value.verified_semantics.rejection_ids,
          observation.rejection_id,
        ) &&
        matching.some((entry) => entry.status >= 400) &&
        observations.some(
          (entry) =>
            entry.observation_method === "fresh_http_read_after_write" &&
            entry.status >= 200 &&
            entry.status < 300,
        )
      );
    case "fresh_database_readback":
      return (
        includesSemantic(artifact.value.verified_semantics.effect_ids, observation.effect_id) &&
        artifact.value.database_observation.method === databaseMethodFor(backend) &&
        Object.values(artifact.value.database_observation.row_counts).every((count) => count > 0)
      );
    case "ordered_durable_outbox_readback":
      return (
        includesSemantic(artifact.value.verified_semantics.effect_ids, observation.effect_id) &&
        artifact.value.database_observation.method === databaseMethodFor(backend) &&
        outboxRowCount(artifact.value.database_observation.row_counts) > 0
      );
    case "second_fresh_http_read":
      return (
        includesSemantic(
          artifact.value.verified_semantics.freshness_ids,
          observation.freshness_id,
        ) &&
        matching.some(
          (entry) =>
            entry.observation_method === "fresh_http_read_after_write" &&
            entry.status >= 200 &&
            entry.status < 300,
        )
      );
    case "provider_delivery_observation":
      return false;
  }
};
const observedIds = (
  plan: ClaimIntentEvidencePlan,
  backend: Backend,
  artifact: BuildTimeJourneyArtifact,
  run: { readonly result: string },
): readonly string[] =>
  backendPlanFor(plan, backend).observations.flatMap((observation) => {
    if (!methodObserved(observation, plan, backend, artifact, run)) {
      throw new Error(
        `CLAIM_EVIDENCE_METHOD_NOT_OBSERVED:${plan.intent_ref_id}:${observation.observation_method}:${observation.observation_id}`,
      );
    }
    return [observation.observation_id];
  });

const databaseMethodFor = (backend: Backend): string =>
  backend === "legacy_symfony" ? "fresh_sqlite_read_back" : "fresh_psql_read_back";

const outboxRowCount = (rowCounts: Readonly<Record<string, number>>): number =>
  rowCounts.outbox ?? rowCounts.invitation_outbox ?? rowCounts.subscribers ?? 0;

const readArtifactFile = async (
  evidenceRoot: string,
  run: { readonly artifact_pointer: string; readonly intent_ref_id: string },
): Promise<string> => {
  const artifactPath = resolve(evidenceRoot, run.artifact_pointer);
  if (!artifactPath.startsWith(`${evidenceRoot}/`)) {
    throw new Error("CLAIM_EVIDENCE_ARTIFACT_PATH_INVALID");
  }
  const artifactBytes = await readFile(artifactPath, "utf8");
  if (sha256(artifactBytes) !== run.artifact_digest) {
    throw new Error(`CLAIM_EVIDENCE_ARTIFACT_DRIFT:${run.intent_ref_id}`);
  }
  return artifactBytes;
};

const buildNativeReceipt = async (
  acceptedIntent: AcceptedIntentV2,
  catalogs: ClaimEvidenceCatalogs,
  plans: readonly ClaimIntentEvidencePlan[],
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
  options: Options,
  runnerDigest: string,
  run: JourneyRunRecord,
): Promise<CapabilityEvidenceReceipt> => {
  if (run.runner_digest !== runnerDigest) {
    throw new Error(`CLAIM_EVIDENCE_RUNNER_DRIFT:${run.intent_ref_id}`);
  }
  const plan = requirePlan(plans, run.intent_ref_id);
  const artifactBytes = await readArtifactFile(options.evidenceRoot, run);
  const artifact = Schema.decodeUnknownSync(JourneyObservationArtifactSchema, {
    onExcessProperty: "error",
  })(parseJson(artifactBytes, "journey artifact"));
  if (artifact.intent_ref_id !== run.intent_ref_id) {
    throw new Error(`CLAIM_EVIDENCE_ARTIFACT_INTENT_MISMATCH:${run.intent_ref_id}`);
  }
  const receiptRef = receiptRefs.find(
    (entry) => entry.intent_ref_id === plan.intent_ref_id && entry.backend === "native_effect",
  );
  if (receiptRef === undefined) throw new Error("CLAIM_EVIDENCE_RECEIPT_REF_MISSING");
  return buildCapabilityEvidenceReceipt({
    accepted_intent: acceptedIntent,
    artifact_digest: run.artifact_digest,
    artifact_pointer: run.artifact_pointer,
    backend: "native_effect",
    catalogs,
    exit_code: 0,
    fixture_digest: run.fixture_digest,
    intent_ref_id: plan.intent_ref_id,
    observed_observation_ids: observedIds(
      plan,
      "native_effect",
      { backend: "native_effect", value: artifact },
      run,
    ),
    receipt_ref_id: receiptRef.receipt_ref_id,
    result: "passed",
    runner_digest: run.runner_digest,
  });
};

const buildLegacyReceipt = async (
  acceptedIntent: AcceptedIntentV2,
  catalogs: ClaimEvidenceCatalogs,
  plans: readonly ClaimIntentEvidencePlan[],
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
  options: Options,
  runnerDigest: string,
  run: LegacyJourneyRunRecord,
): Promise<CapabilityEvidenceReceipt> => {
  if (run.runner_digest !== runnerDigest) {
    throw new Error(`CLAIM_EVIDENCE_RUNNER_DRIFT:${run.intent_ref_id}`);
  }
  const plan = requirePlan(plans, run.intent_ref_id);
  const artifactBytes = await readArtifactFile(options.evidenceRoot, run);
  const artifact = Schema.decodeUnknownSync(LegacyJourneyObservationArtifactSchema, {
    onExcessProperty: "error",
  })(parseJson(artifactBytes, "legacy journey artifact"));
  if (artifact.intent_ref_id !== run.intent_ref_id) {
    throw new Error(`CLAIM_EVIDENCE_ARTIFACT_INTENT_MISMATCH:${run.intent_ref_id}`);
  }
  const receiptRef = receiptRefs.find(
    (entry) => entry.intent_ref_id === plan.intent_ref_id && entry.backend === "legacy_symfony",
  );
  if (receiptRef === undefined) throw new Error("CLAIM_EVIDENCE_RECEIPT_REF_MISSING");
  return buildCapabilityEvidenceReceipt({
    accepted_intent: acceptedIntent,
    artifact_digest: run.artifact_digest,
    artifact_pointer: run.artifact_pointer,
    backend: "legacy_symfony",
    catalogs,
    exit_code: 0,
    fixture_digest: run.fixture_digest,
    intent_ref_id: plan.intent_ref_id,
    observed_observation_ids: observedIds(
      plan,
      "legacy_symfony",
      { backend: "legacy_symfony", value: artifact },
      run,
    ),
    receipt_ref_id: receiptRef.receipt_ref_id,
    result: "passed",
    runner_digest: run.runner_digest,
  });
};

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const [legacyBytes, nativeBytes, intentBytes, runtimeBytes, manifestBytes, runnerBytes] =
    await Promise.all([
      readFile(resolve(options.evidenceRoot, "atomic-legacy.json"), "utf8"),
      readFile(resolve(options.evidenceRoot, "atomic-native.json"), "utf8"),
      readFile(options.intentAuthority, "utf8"),
      readFile(options.runtimeAuthority, "utf8"),
      readFile(resolve(options.evidenceRoot, "native-run-manifest.json"), "utf8"),
      readFile(resolve(import.meta.dir, "src/journey-evidence.ts")),
    ]);
  if (options.legacyManifest !== null) {
    // Kept for argument compatibility; the manifest itself lives in the evidence root.
  }
  const legacyManifestBytes =
    options.legacyManifest === null ? null : await readFile(options.legacyManifest, "utf8");
  const legacyRunnerBytes =
    options.legacyManifest === null
      ? null
      : await readFile(resolve(import.meta.dir, "src/legacy-journey-evidence.ts"));
  const catalogs: ClaimEvidenceCatalogs = {
    legacy: decodeCatalog(parseJson(legacyBytes, "atomic legacy"), "atomic legacy"),
    native: decodeCatalog(parseJson(nativeBytes, "atomic native"), "atomic native"),
  };
  const intentV1 = parseJson(intentBytes, "intent authority");
  const runtimeV1 = parseJson(runtimeBytes, "runtime authority");
  const manifest = parseJson(manifestBytes, "native run manifest") as NativeJourneyRunManifest;
  if (manifest.schema_version !== "claim-specific-journey-run/v1") {
    throw new Error("CLAIM_EVIDENCE_RUN_MANIFEST_SCHEMA_INVALID");
  }
  const legacyManifest =
    legacyManifestBytes === null || legacyRunnerBytes === null
      ? null
      : (parseJson(legacyManifestBytes, "legacy run manifest") as LegacyJourneyRunManifest);
  if (
    legacyManifest !== null &&
    legacyManifest.schema_version !== "claim-specific-legacy-journey-run/v1"
  ) {
    throw new Error("CLAIM_EVIDENCE_LEGACY_RUN_MANIFEST_SCHEMA_INVALID");
  }
  const [intentSourcePin, runtimeSourcePin] = await Promise.all([
    pinExternalAuthority(options.intentAuthority, intentV1),
    pinExternalAuthority(options.runtimeAuthority, runtimeV1),
  ]);
  const migrated = migrateAcceptedIntentV1(intentV1, intentSourcePin);
  const plans = claimEvidencePlan(catalogs);
  const receiptRefs: readonly ClaimEvidenceReceiptRef[] = plans.flatMap((plan) =>
    (["legacy_symfony", "native_effect"] as const).map((backend) => ({
      backend,
      intent_ref_id: plan.intent_ref_id,
      receipt_ref_id: stableId("receipt", {
        backend,
        intent_ref_id: plan.intent_ref_id,
        intent_revision: plan.intent_revision,
      }),
    })),
  );
  const acceptedIntent = buildClaimSpecificAcceptedIntentV2(migrated, catalogs, receiptRefs);
  if (!validateAcceptedIntentV2(acceptedIntent)) {
    throw new Error("CLAIM_EVIDENCE_ACCEPTED_INTENT_SCHEMA_INVALID");
  }
  const runnerDigest = sha256(runnerBytes);
  const nativeReceipts = await Promise.all(
    manifest.native.map((run) =>
      buildNativeReceipt(acceptedIntent, catalogs, plans, receiptRefs, options, runnerDigest, run),
    ),
  );
  const legacyReceipts =
    legacyManifest === null
      ? []
      : await Promise.all(
          legacyManifest.legacy.map((run) =>
            buildLegacyReceipt(
              acceptedIntent,
              catalogs,
              plans,
              receiptRefs,
              options,
              sha256(legacyRunnerBytes!),
              run,
            ),
          ),
        );
  const receipts = [...nativeReceipts, ...legacyReceipts];
  const runtimeEvidence = buildCapabilityRuntimeEvidenceV2(runtimeSourcePin, receipts);
  if (!validateCapabilityEvidenceV2(runtimeEvidence)) {
    throw new Error("CLAIM_EVIDENCE_RUNTIME_REGISTER_SCHEMA_INVALID");
  }
  const acceptedBytes = canonicalJson(acceptedIntent);
  const evidenceBytes = canonicalJson(runtimeEvidence);
  const acceptedPath = resolve(options.evidenceRoot, "accepted-intent-v2.json");
  const evidencePath = resolve(options.evidenceRoot, "capability-runtime-evidence-v2.json");
  await Promise.all([
    writeFile(acceptedPath, acceptedBytes, "utf8"),
    writeFile(evidencePath, evidenceBytes, "utf8"),
  ]);
  const legacyRunnerDigest = legacyRunnerBytes === null ? null : sha256(legacyRunnerBytes);
  const generationReceipt = {
    artifact_digests: Object.fromEntries(
      [...manifest.native, ...(legacyManifest?.legacy ?? [])]
        .map((run) => [run.artifact_pointer, run.artifact_digest] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    external_authorities: {
      accepted_intent_v1: intentSourcePin,
      runtime_evidence_v1: runtimeSourcePin,
    },
    generated_registers: {
      accepted_intent_v2: sha256(acceptedBytes),
      capability_runtime_evidence_v2: sha256(evidenceBytes),
    },
    generator: {
      fixture_digest: manifest.native[0]?.fixture_digest ?? null,
      legacy_runner_digest: legacyRunnerDigest,
      runner_digest: runnerDigest,
      source_revision_ref: await git(repositoryRoot, [
        "log",
        "-1",
        "--format=%H",
        "--",
        "packages/parity-inventory/src/claim-evidence.ts",
        "packages/parity-inventory/src/journey-evidence.ts",
        "packages/parity-inventory/src/legacy-journey-evidence.ts",
      ]),
    },
    legacy_gate: manifest.legacy_gate,
    legacy_run_manifest:
      options.legacyManifest === null ? null : (legacyManifest?.schema_version ?? null),
    receipt_ref_ids: receipts.map((receipt) => receipt.receipt_ref_id).sort(),
    schema_version: "claim-specific-evidence-generation-receipt/v1",
  };
  await writeFile(
    resolve(options.evidenceRoot, "claim-evidence-generation-receipt.json"),
    canonicalJson(generationReceipt),
    "utf8",
  );
  process.stdout.write(
    `${canonicalJson({ receipts: receipts.length, registers: generationReceipt.generated_registers })}\n`,
  );
};

await main();
