import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  assertSafeRuntimeEvidenceBytes,
  canonicalRuntimeEvidenceBytes,
  decodeRuntimeEvidenceRegister,
  makeRuntimeEvidenceReceipt,
  makeRuntimeEvidenceRegister,
  runtimeEvidenceReceiptRefId,
  tryDecodeRuntimeEvidenceRegister,
} from "../src/runtime-evidence.js"
import { tryDecodeAcceptedIntentRegister } from "../src/coverage.js"
import { canonicalJson, sha256 } from "../src/canonical.js"

const sourceRef = `src-${"a".repeat(64)}`
const digest = (hex: string): string => `sha256:${hex.repeat(64).slice(0, 64)}`

const receiptInput = {
  journey_ref_id: "intent://journey:recruitment:applicant-assignment:v1",
  step_ids: ["load-applicant-list", "assign-interview"],
  legacy_revision_ref_id: "rev-legacy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  mono_revision_ref_id: "rev-mono-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  runner_source_ref_ids: [sourceRef],
  runner_digest: digest("1"),
  fixture_digest: digest("2"),
  environment_kind: "local_disposable" as const,
  exit_code: 0,
  result: "passed" as const,
  artifact_digest: digest("3"),
}

describe("runtime evidence register", () => {
  test("emits stable canonical bytes and content-derived receipt reference", () => {
    const first = makeRuntimeEvidenceReceipt(receiptInput)
    const second = makeRuntimeEvidenceReceipt({ ...receiptInput, step_ids: [...receiptInput.step_ids] })
    expect(first).toEqual(second)
    expect(first.receipt_ref_id).toBe(runtimeEvidenceReceiptRefId(receiptInput))
    const register = makeRuntimeEvidenceRegister([first])
    const bytes = canonicalRuntimeEvidenceBytes(register)
    expect(bytes).toBe(canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([second])))
    expect(bytes).not.toContain("timestamp")
    expect(bytes).not.toContain("/tmp/")
    expect(decodeRuntimeEvidenceRegister(JSON.parse(bytes))).toEqual(register)
  })
  test("accepts exact content-addressed revision identifiers", () => {
    const numeric = makeRuntimeEvidenceReceipt({
      ...receiptInput,
      legacy_revision_ref_id: `rev-legacy-${"0123456789abcdef".repeat(3).slice(0, 40)}`,
      mono_revision_ref_id: `rev-mono-${"0123456789abcdef".repeat(4)}`,
      runner_source_ref_ids: [`src-${"0123456789abcdef".repeat(4)}`],
    })
    expect(decodeRuntimeEvidenceRegister(JSON.parse(canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([numeric])))).receipts[0]).toEqual(numeric)
  })
  test("accepts opaque content-addressed receipt references", () => {
    const selectedRevisionRefIds = [
      receiptInput.legacy_revision_ref_id,
      receiptInput.mono_revision_ref_id,
    ].sort()
    const receiptRefId = "receipt-aa77c79d09b1738b3dac10076832e6062244f89af838cc1a875a2c803d18511d"
    const journeyRefId = "intent://journey:test:opaque-receipt:v1"
    const intentPayload = {
      intent_ref_id: journeyRefId,
      intent_revision: "opaque-receipt-v1",
      selected_revision_ref_ids: selectedRevisionRefIds,
      source_ref_ids: [],
      purpose: "coverage",
      disposition: null,
      row_ids: [],
      canonical_signatures: [],
      inventory_kinds: [],
      journey_ref_ids: [journeyRefId],
    }
    const journeyPayload = {
      journey_ref_id: journeyRefId,
      journey_key: "opaque-receipt",
      intent_ref_id: journeyRefId,
      journey_revision: "opaque-receipt-v1",
      selected_revision_ref_ids: selectedRevisionRefIds,
      source_ref_ids: [],
      steps: [{
        step_id: "observed-step",
        surface: "api_operation",
        row_ids: [`row-${"1".repeat(64)}`],
        canonical_signatures: [],
        expected_contract_ref: null,
        runtime_evidence_ref_ids: [receiptRefId],
      }],
      coverage_scope: "user_visible",
    }
    const decoded = tryDecodeAcceptedIntentRegister({
      schema_version: "functional-parity-accepted-intent/v1",
      intents: [{ ...intentPayload, intent_digest: sha256(canonicalJson(intentPayload)) }],
      journeys: [{ ...journeyPayload, journey_digest: sha256(canonicalJson(journeyPayload)) }],
    }, selectedRevisionRefIds)
    expect(decoded.issues).toEqual([])
    expect(decoded.register?.journeys[0]?.steps[0]?.runtime_evidence_ref_ids).toEqual([receiptRefId])
  })


  test.each([
    ["unknown object key", "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"schema_version\":\"functional-parity-runtime-evidence/v1\",\"receipts\":[],\"unsafe\":true}"],
    ["failed result with zero exit", JSON.stringify({ ...makeRuntimeEvidenceRegister([makeRuntimeEvidenceReceipt({ ...receiptInput, result: "failed", exit_code: 0 })]), receipts: [makeRuntimeEvidenceReceipt({ ...receiptInput, result: "failed", exit_code: 0 })] })],
  ])("rejects %s", (_name, text) => {
    expect(() => assertSafeRuntimeEvidenceBytes(new TextEncoder().encode(text))).toThrow()
  })

  test("rejects unsafe, duplicate, and noncanonical bytes before decode", () => {
    const valid = canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([makeRuntimeEvidenceReceipt(receiptInput)]))
    expect(() => assertSafeRuntimeEvidenceBytes(new TextEncoder().encode(`${valid}\n`))).toThrow("EVIDENCE_NOT_CANONICAL")
    const duplicate = valid.replace('"schema_version":"functional-parity-runtime-evidence/v1"', '"schema_version":"functional-parity-runtime-evidence/v1","schema_version":"functional-parity-runtime-evidence/v1"')
    expect(() => assertSafeRuntimeEvidenceBytes(new TextEncoder().encode(duplicate))).toThrow("EVIDENCE_DUPLICATE_KEY")
    const unsafe = valid.replace('"mono_revision_ref_id":"rev-mono-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"', '"mono_revision_ref_id":"rev-mono-ghp_0123456789abcdef"')
    expect(tryDecodeRuntimeEvidenceRegister(JSON.parse(unsafe))).toEqual({ register: null, reason: "EVIDENCE_RECEIPT_INVALID" })
  })
  test("decodes the canonical bytes emitted by the browser receipt helper", async () => {
    const outputDirectory = mkdtempSync("/tmp/runtime-evidence-emitted-")
    const outputPath = join(outputDirectory, "runtime-evidence.json")
    const sourceA = `src-${"0123456789abcdef".repeat(4)}`
    const sourceB = `src-${"fedcba9876543210".repeat(4)}`
    const names = [
      "RUNTIME_EVIDENCE_RECEIPT_PATH",
      "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
    ] as const
    const previous = new Map(names.map((name) => [name, process.env[name]]))
    try {
      process.env.RUNTIME_EVIDENCE_RECEIPT_PATH = outputPath
      process.env.RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID = `rev-legacy-sha256-${"a".repeat(64)}`
      process.env.RUNTIME_EVIDENCE_MONO_REVISION_REF_ID = `rev-mono-sha256-${"b".repeat(64)}`
      process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS = `${sourceA},${sourceB}`
      const helper = await import("../../../apps/dashboard/e2e/runtime-evidence-receipt.mjs")
      const artifactBytes = helper.sanitizePlaywrightArtifact(new TextEncoder().encode(JSON.stringify({
        suites: [{ specs: [{ title: "accepted", ok: true, tests: [{ results: [{ status: "passed" }] }] }] }],
      })))
      const receiptRef = await helper.emitRuntimeEvidenceReceipt({
        journeyRefId: "intent://journey:test:emitted-receipt:v1",
        stepIds: ["emitted-step"],
        fixtureId: "emitted-receipt-fixture",
        runnerSourceInputBytes: [
          { sourceRefId: sourceA, bytes: new TextEncoder().encode("runner") },
          { sourceRefId: sourceB, bytes: new TextEncoder().encode("spec") },
        ],
        fixtureInputBytes: new TextEncoder().encode("fixture"),
        artifactBytes,
      })
      const register = assertSafeRuntimeEvidenceBytes(new Uint8Array(readFileSync(outputPath)))
      expect(register.receipts[0]?.receipt_ref_id).toBe(receiptRef)
      expect(register.receipts[0]?.environment_kind).toBe("local_disposable")
      expect(register.receipts[0]?.result).toBe("passed")
    } finally {
      for (const name of names) {
        const value = previous.get(name)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })
})
