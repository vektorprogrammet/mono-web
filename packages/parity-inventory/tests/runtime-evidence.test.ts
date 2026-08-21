import {
  assertSafeRuntimeEvidenceBytes,
  canonicalRuntimeEvidenceBytes,
  decodeRuntimeEvidenceRegister,
  makeRuntimeEvidenceReceipt,
  makeRuntimeEvidenceRegister,
  runtimeEvidenceReceiptRefId,
  tryDecodeRuntimeEvidenceRegister,
} from "../src/runtime-evidence.js"

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
  test("accepts content-addressed identifiers with decimal segments", () => {
    const numeric = makeRuntimeEvidenceReceipt({
      ...receiptInput,
      legacy_revision_ref_id: "rev-legacy-1234567890",
      mono_revision_ref_id: "rev-mono-9876543210",
      runner_source_ref_ids: [`src-${"0123456789abcdef".repeat(4)}`],
    })
    expect(decodeRuntimeEvidenceRegister(JSON.parse(canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([numeric])))).receipts[0]).toEqual(numeric)
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
    const unsafe = valid.replace('"step_ids":["assign-interview","load-applicant-list"]', '"step_ids":["step-123456789","load-applicant-list"]')
    expect(tryDecodeRuntimeEvidenceRegister(JSON.parse(unsafe))).toEqual({ register: null, reason: "EVIDENCE_RECEIPT_INVALID" })
  })
})
