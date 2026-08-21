import Ajv2020 from "ajv/dist/2020.js"
import runtimeEvidenceSchema from "../schemas/runtime-evidence.json"
import { canonicalJson, compareByteOrder, sha256, stableId, sortUnique } from "./canonical.js"
import { hasDuplicateJsonMembers } from "./json-safety.js"
import { unsafeScalarReason } from "./source-manifest.js"
import type { RuntimeEvidenceReceipt, RuntimeEvidenceRegister, RuntimeObservation } from "./types.js"

export const RUNTIME_EVIDENCE_SCHEMA = runtimeEvidenceSchema as Record<string, unknown>

const ajv = new Ajv2020({ allErrors: true, strict: false })
const runtimeEvidenceValidator = ajv.compile<RuntimeEvidenceRegister>(RUNTIME_EVIDENCE_SCHEMA)

const RECEIPT_REF = /^receipt-[a-f0-9]{64}$/
const JOURNEY_REF = /^intent:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STEP_REF = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/
const REVISION_REF = /^rev-[A-Za-z0-9:_-]{1,160}$/
const SOURCE_REF = /^src-[a-f0-9]{64}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

export interface RuntimeEvidenceDecodeResult {
  readonly register: RuntimeEvidenceRegister | null
  readonly reason: string | null
}

export interface RuntimeEvidenceReceiptInput {
  readonly journey_ref_id: string
  readonly step_ids: readonly string[]
  readonly legacy_revision_ref_id: string
  readonly mono_revision_ref_id: string
  readonly runner_source_ref_ids: readonly string[]
  readonly runner_digest: string
  readonly fixture_digest: string
  readonly environment_kind: RuntimeEvidenceReceipt["environment_kind"]
  readonly exit_code: number
  readonly result: RuntimeEvidenceReceipt["result"]
  readonly artifact_digest: string
}

const receiptPayload = (receipt: Omit<RuntimeEvidenceReceipt, "receipt_ref_id">): Omit<RuntimeEvidenceReceipt, "receipt_ref_id"> => ({
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
})

export const runtimeEvidenceReceiptRefId = (receipt: Omit<RuntimeEvidenceReceipt, "receipt_ref_id">): string =>
  stableId("receipt", receiptPayload(receipt))

export const makeRuntimeEvidenceReceipt = (input: RuntimeEvidenceReceiptInput): RuntimeEvidenceReceipt => {
  const payload = receiptPayload(input)
  return { receipt_ref_id: runtimeEvidenceReceiptRefId(payload), ...payload }
}

export const makeRuntimeEvidenceRegister = (receipts: readonly RuntimeEvidenceReceipt[]): RuntimeEvidenceRegister => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-runtime-evidence/v1",
  receipts: [...receipts].sort((left, right) => compareByteOrder(left.receipt_ref_id, right.receipt_ref_id)),
})

export const canonicalRuntimeEvidenceBytes = (register: RuntimeEvidenceRegister): string => canonicalJson(register)

const safeScalar = (value: unknown, pattern: RegExp, field: string): value is string =>
  typeof value === "string" && pattern.test(value) && unsafeScalarReason(value, field) === null
const safeIdentifier = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value)

const decodeReceipt = (value: unknown): RuntimeEvidenceReceipt | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const receipt = value as Record<string, unknown>
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
  ]
  if (Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(receipt, key))) return null
  const stepIds = receipt.step_ids
  const sourceRefs = receipt.runner_source_ref_ids
  if (
    !safeIdentifier(receipt.receipt_ref_id, RECEIPT_REF) ||
    !safeIdentifier(receipt.journey_ref_id, JOURNEY_REF) ||
    !Array.isArray(stepIds) ||
    !stepIds.every((step) => safeScalar(step, STEP_REF, "journey_step")) ||
    new Set(stepIds).size !== stepIds.length ||
    stepIds.length === 0 ||
    !safeIdentifier(receipt.legacy_revision_ref_id, REVISION_REF) ||
    !safeIdentifier(receipt.mono_revision_ref_id, REVISION_REF) ||
    !Array.isArray(sourceRefs) ||
    !sourceRefs.every((source) => safeIdentifier(source, SOURCE_REF)) ||
    new Set(sourceRefs).size !== sourceRefs.length ||
    sourceRefs.length === 0 ||
    typeof receipt.runner_digest !== "string" ||
    !DIGEST.test(receipt.runner_digest) ||
    typeof receipt.fixture_digest !== "string" ||
    !DIGEST.test(receipt.fixture_digest) ||
    (receipt.environment_kind !== "local_disposable" && receipt.environment_kind !== "e2e" && receipt.environment_kind !== "ci_non_production") ||
    typeof receipt.exit_code !== "number" ||
    !Number.isSafeInteger(receipt.exit_code) ||
    receipt.exit_code < 0 ||
    (receipt.result !== "passed" && receipt.result !== "failed") ||
    typeof receipt.artifact_digest !== "string" ||
    !DIGEST.test(receipt.artifact_digest)
  ) return null
  const payload = receiptPayload({
    journey_ref_id: receipt.journey_ref_id,
    step_ids: stepIds as string[],
    legacy_revision_ref_id: receipt.legacy_revision_ref_id,
    mono_revision_ref_id: receipt.mono_revision_ref_id,
    runner_source_ref_ids: sourceRefs as string[],
    runner_digest: receipt.runner_digest,
    fixture_digest: receipt.fixture_digest,
    environment_kind: receipt.environment_kind as RuntimeEvidenceReceipt["environment_kind"],
    exit_code: receipt.exit_code,
    result: receipt.result as RuntimeEvidenceReceipt["result"],
    artifact_digest: receipt.artifact_digest,
  })
  if (canonicalJson(stepIds) !== canonicalJson(payload.step_ids) || canonicalJson(sourceRefs) !== canonicalJson(payload.runner_source_ref_ids)) return null
  if (receipt.result === "passed" ? receipt.exit_code !== 0 : receipt.exit_code === 0) return null
  if (runtimeEvidenceReceiptRefId(payload) !== receipt.receipt_ref_id) return null
  return { receipt_ref_id: receipt.receipt_ref_id, ...payload }
}

export const validateRuntimeEvidenceShape = (value: unknown): value is RuntimeEvidenceRegister => runtimeEvidenceValidator(value) === true

export const tryDecodeRuntimeEvidenceRegister = (value: unknown): RuntimeEvidenceDecodeResult => {
  if (!validateRuntimeEvidenceShape(value)) return { register: null, reason: "EVIDENCE_SCHEMA_INVALID" }
  if (value.receipts.length === 0) return { register: null, reason: "EVIDENCE_RECEIPT_EMPTY" }
  const receipts: RuntimeEvidenceReceipt[] = []
  const refs = new Set<string>()
  for (const rawReceipt of value.receipts) {
    const receipt = decodeReceipt(rawReceipt)
    if (receipt === null) return { register: null, reason: "EVIDENCE_RECEIPT_INVALID" }
    if (refs.has(receipt.receipt_ref_id)) return { register: null, reason: "EVIDENCE_RECEIPT_DUPLICATE" }
    refs.add(receipt.receipt_ref_id)
    receipts.push(receipt)
  }
  const register = makeRuntimeEvidenceRegister(receipts)
  if (canonicalJson(value) !== canonicalJson(register)) return { register: null, reason: "EVIDENCE_NOT_CANONICAL" }
  return { register, reason: null }
}

export const decodeRuntimeEvidenceRegister = (value: unknown): RuntimeEvidenceRegister => {
  const result = tryDecodeRuntimeEvidenceRegister(value)
  if (result.register === null) throw new Error(result.reason ?? "EVIDENCE_SCHEMA_INVALID")
  return result.register
}

export const assertSafeRuntimeEvidenceBytes = (bytes: Uint8Array, requireCanonical = true): RuntimeEvidenceRegister => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("EVIDENCE_UTF8_INVALID")
  }
  if (text.length > 256 * 1024) throw new Error("EVIDENCE_TOO_LARGE")
  if (hasDuplicateJsonMembers(text)) throw new Error("EVIDENCE_DUPLICATE_KEY")
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error("EVIDENCE_SCHEMA_INVALID")
  }
  const result = tryDecodeRuntimeEvidenceRegister(value)
  if (result.register === null) throw new Error(result.reason ?? "EVIDENCE_SCHEMA_INVALID")
  if (requireCanonical && canonicalJson(value) !== text) throw new Error("EVIDENCE_NOT_CANONICAL")
  return result.register
}

export const runtimeEvidenceObservation = (receipt: RuntimeEvidenceReceipt): RuntimeObservation => ({
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
})

export const runtimeEvidenceDigest = (value: unknown): string => sha256(canonicalJson(value))