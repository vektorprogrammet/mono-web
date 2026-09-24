import { flow, Predicate, Result, Schema } from "effect";
import Ajv2020 from "ajv/dist/2020.js";
import runtimeEvidenceSchema from "../schemas/runtime-evidence.json";
import { canonicalJson, compareByteOrder, sha256, stableId, sortUnique } from "./canonical.js";
import { hasDuplicateJsonMembers } from "./json-safety.js";
import { unsafeScalarReason } from "./source-manifest.js";
import type {
  RuntimeEvidenceReceipt,
  RuntimeEvidenceRegister,
  RuntimeObservation,
} from "./types.js";

export const RUNTIME_EVIDENCE_SCHEMA = runtimeEvidenceSchema;

const ajv = new Ajv2020({ allErrors: true, strict: false });

const runtimeEvidenceValidator = ajv.compile<RuntimeEvidenceRegister>(RUNTIME_EVIDENCE_SCHEMA);

const RECEIPT_REF = /^receipt-[a-f0-9]{64}$/;

const JOURNEY_REF = /^intent:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const STEP_REF = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;

const REVISION_REF = /^rev-[A-Za-z0-9:_-]{1,160}$/;

const CONTENT_ADDRESSED_REVISION_REF =
  /^rev-(?:legacy|mono)-(?:[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$/;

const SOURCE_REF = /^src-[a-f0-9]{64}$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const safeIdentifier = (
  value: unknown,
  pattern: RegExp,
  field: string,
  contentAddressed = false,
): value is string =>
  Predicate.isString(value) &&
  pattern.test(value) &&
  (contentAddressed || unsafeScalarReason(value, field) === null);

export interface RuntimeEvidenceDecodeResult {
  readonly register: RuntimeEvidenceRegister | null;
  readonly reason: string | null;
}

export interface RuntimeEvidenceReceiptInput {
  readonly journey_ref_id: string;
  readonly step_ids: readonly string[];
  readonly legacy_revision_ref_id: string;
  readonly mono_revision_ref_id: string;
  readonly runner_source_ref_ids: readonly string[];
  readonly runner_digest: string;
  readonly fixture_digest: string;
  readonly environment_kind: RuntimeEvidenceReceipt["environment_kind"];
  readonly exit_code: number;
  readonly result: RuntimeEvidenceReceipt["result"];
  readonly artifact_digest: string;
}

const receiptPayload = (
  receipt: Omit<RuntimeEvidenceReceipt, "receipt_ref_id">,
): Omit<RuntimeEvidenceReceipt, "receipt_ref_id"> => ({
  journey_ref_id: receipt.journey_ref_id,
  step_ids: sortUnique(receipt.step_ids),
  legacy_revision_ref_id: receipt.legacy_revision_ref_id,
  mono_revision_ref_id: receipt.mono_revision_ref_id,
  runner_source_ref_ids: sortUnique(receipt.runner_source_ref_ids),
  runner_digest: receipt.runner_digest,
  fixture_digest: receipt.fixture_digest,
  environment_kind: receipt.environment_kind,
  exit_code: receipt.exit_code,
  result: receipt.result,
  artifact_digest: receipt.artifact_digest,
});

export const runtimeEvidenceReceiptRefId = (
  receipt: Omit<RuntimeEvidenceReceipt, "receipt_ref_id">,
): string => stableId("receipt", receiptPayload(receipt));

export const buildRuntimeEvidenceReceipt = (
  input: RuntimeEvidenceReceiptInput,
): RuntimeEvidenceReceipt => {
  const payload = receiptPayload(input);

  return { receipt_ref_id: runtimeEvidenceReceiptRefId(payload), ...payload };
};

export const buildRuntimeEvidenceRegister = (
  receipts: readonly RuntimeEvidenceReceipt[],
): RuntimeEvidenceRegister => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-runtime-evidence/v1",
  receipts: [...receipts].sort((left, right) =>
    compareByteOrder(left.receipt_ref_id, right.receipt_ref_id),
  ),
});

export const canonicalRuntimeEvidenceBytes = (register: RuntimeEvidenceRegister): string =>
  canonicalJson(register);

const safeScalar = (value: unknown, pattern: RegExp, field: string): value is string =>
  Predicate.isString(value) && pattern.test(value) && unsafeScalarReason(value, field) === null;

const decodeReceipt = (receipt: RuntimeEvidenceReceipt): RuntimeEvidenceReceipt | null => {
  const keys = [
    "receipt_ref_id",
    "journey_ref_id",
    "step_ids",
    "legacy_revision_ref_id",
    "mono_revision_ref_id",
    "runner_source_ref_ids",
    "runner_digest",
    "fixture_digest",
    "environment_kind",
    "exit_code",
    "result",
    "artifact_digest",
  ];

  if (
    Object.keys(receipt).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(receipt, key))
  )
    return null;
  const stepIds = receipt.step_ids;
  const sourceRefs = receipt.runner_source_ref_ids;

  if (
    !safeIdentifier(receipt.receipt_ref_id, RECEIPT_REF, "receipt_ref_id", true) ||
    !safeIdentifier(receipt.journey_ref_id, JOURNEY_REF, "journey_ref_id") ||
    !Array.isArray(stepIds) ||
    !stepIds.every((step) => safeScalar(step, STEP_REF, "journey_step")) ||
    new Set(stepIds).size !== stepIds.length ||
    stepIds.length === 0 ||
    !safeIdentifier(
      receipt.legacy_revision_ref_id,
      REVISION_REF,
      "legacy_revision_ref_id",
      Predicate.isString(receipt.legacy_revision_ref_id) &&
        CONTENT_ADDRESSED_REVISION_REF.test(receipt.legacy_revision_ref_id),
    ) ||
    !safeIdentifier(
      receipt.mono_revision_ref_id,
      REVISION_REF,
      "mono_revision_ref_id",
      Predicate.isString(receipt.mono_revision_ref_id) &&
        CONTENT_ADDRESSED_REVISION_REF.test(receipt.mono_revision_ref_id),
    ) ||
    !Array.isArray(sourceRefs) ||
    !sourceRefs.every((source) =>
      safeIdentifier(source, SOURCE_REF, "runner_source_ref_id", true),
    ) ||
    new Set(sourceRefs).size !== sourceRefs.length ||
    sourceRefs.length === 0 ||
    !Predicate.isString(receipt.runner_digest) ||
    !DIGEST.test(receipt.runner_digest) ||
    !Predicate.isString(receipt.fixture_digest) ||
    !DIGEST.test(receipt.fixture_digest) ||
    (receipt.environment_kind !== "local_disposable" &&
      receipt.environment_kind !== "e2e" &&
      receipt.environment_kind !== "ci_non_production") ||
    !Predicate.isNumber(receipt.exit_code) ||
    !Number.isSafeInteger(receipt.exit_code) ||
    receipt.exit_code < 0 ||
    (receipt.result !== "passed" && receipt.result !== "failed") ||
    !Predicate.isString(receipt.artifact_digest) ||
    !DIGEST.test(receipt.artifact_digest)
  )
    return null;

  const payload = receiptPayload({
    journey_ref_id: receipt.journey_ref_id,
    step_ids: stepIds,
    legacy_revision_ref_id: receipt.legacy_revision_ref_id,
    mono_revision_ref_id: receipt.mono_revision_ref_id,
    runner_source_ref_ids: sourceRefs,
    runner_digest: receipt.runner_digest,
    fixture_digest: receipt.fixture_digest,
    environment_kind: receipt.environment_kind,
    exit_code: receipt.exit_code,
    result: receipt.result,
    artifact_digest: receipt.artifact_digest,
  });

  if (
    canonicalJson(stepIds) !== canonicalJson(payload.step_ids) ||
    canonicalJson(sourceRefs) !== canonicalJson(payload.runner_source_ref_ids)
  )
    return null;

  if (receipt.result === "passed" ? receipt.exit_code !== 0 : receipt.exit_code === 0) return null;

  if (runtimeEvidenceReceiptRefId(payload) !== receipt.receipt_ref_id) return null;

  return { receipt_ref_id: receipt.receipt_ref_id, ...payload };
};

export const isRuntimeEvidenceRegister = (value: unknown): value is RuntimeEvidenceRegister =>
  runtimeEvidenceValidator(value) === true;

const validateRuntimeEvidence = (value: RuntimeEvidenceRegister): RuntimeEvidenceDecodeResult => {
  if (value.receipts.length === 0) return { register: null, reason: "EVIDENCE_RECEIPT_EMPTY" };
  const receipts: RuntimeEvidenceReceipt[] = [];
  const refs = new Set<string>();

  for (const rawReceipt of value.receipts) {
    const receipt = decodeReceipt(rawReceipt);

    if (receipt === null) return { register: null, reason: "EVIDENCE_RECEIPT_INVALID" };

    if (refs.has(receipt.receipt_ref_id))
      return { register: null, reason: "EVIDENCE_RECEIPT_DUPLICATE" };
    refs.add(receipt.receipt_ref_id);
    receipts.push(receipt);
  }

  const register = buildRuntimeEvidenceRegister(receipts);

  if (canonicalJson(value) !== canonicalJson(register))
    return { register: null, reason: "EVIDENCE_NOT_CANONICAL" };

  return { register, reason: null };
};

export const tryDecodeRuntimeEvidenceRegister = flow(
  Schema.decodeUnknownResult(Schema.declare(isRuntimeEvidenceRegister)),
  Result.match({
    onFailure: (): RuntimeEvidenceDecodeResult => ({
      register: null,
      reason: "EVIDENCE_SCHEMA_INVALID",
    }),
    onSuccess: validateRuntimeEvidence,
  }),
);

export const decodeRuntimeEvidenceRegister = flow(
  tryDecodeRuntimeEvidenceRegister,
  (result): RuntimeEvidenceRegister => {
    if (result.register === null) throw new Error(result.reason ?? "EVIDENCE_SCHEMA_INVALID");

    return result.register;
  },
);

export const assertSafeRuntimeEvidenceBytes = (
  bytes: Uint8Array,
  requireCanonical = true,
): RuntimeEvidenceRegister => {
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("EVIDENCE_UTF8_INVALID");
  }

  if (text.length > 256 * 1024) throw new Error("EVIDENCE_TOO_LARGE");

  if (hasDuplicateJsonMembers(text)) throw new Error("EVIDENCE_DUPLICATE_KEY");
  let value: Schema.Json;

  try {
    value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text);
  } catch {
    throw new Error("EVIDENCE_SCHEMA_INVALID");
  }

  const result = tryDecodeRuntimeEvidenceRegister(value);

  if (result.register === null) throw new Error(result.reason ?? "EVIDENCE_SCHEMA_INVALID");

  if (requireCanonical && canonicalJson(value) !== text) throw new Error("EVIDENCE_NOT_CANONICAL");

  return result.register;
};

export const runtimeEvidenceObservation = (
  receipt: RuntimeEvidenceReceipt,
): RuntimeObservation => ({
  runtime_observation_ref_id: receipt.receipt_ref_id,
  revision_ref_id: receipt.mono_revision_ref_id,
  collector_kind: "browser_journey_receipt",
  logical_command_id: receipt.journey_ref_id,
  command: "browser journey receipt",
  argument_digest: receipt.runner_digest,
  executable_digests: { php: null, bwrap: null },
  executable_provenance: { php: null, bwrap: null },
  stdout_sha256: receipt.artifact_digest,
  stderr_sha256: receipt.artifact_digest,
  exit_code: receipt.exit_code,
  result_sha256: receipt.artifact_digest,
  availability: receipt.result === "passed" ? "available" : "unavailable",
});

export const runtimeEvidenceDigest = flow(canonicalJson, sha256);
