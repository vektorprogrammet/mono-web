import { expect, it } from "@effect/vitest";
import { canonicalJson } from "../tutor/evidence.js";
import {
  importLegacyReceipt,
  importLegacyReceipts,
  type ReceiptImportProvenance,
  type ReceiptQuarantineReason,
} from "./import.js";
import type { LegacyReceiptRow } from "./schema.js";

const validRow: LegacyReceiptRow = {
  sourcePrimaryKey: "legacy-1",
  ownerPersonId: "owner-1",
  departmentId: "department-1",
  visualId: "LEGACY-1",
  amountDecimal: "123.45",
  description: "Travel",
  receiptDate: "2026-08-20",
  submittedAt: "2026-08-20T12:00:00.000Z",
  status: "pending",
  refundDate: null,
  paymentAccountCiphertext: "ciphertext:v1:account",
  file: {
    fileRef: "legacy/staged-1",
    objectKey: "receipts/legacy-1",
    contentType: "application/pdf",
    byteLength: 128,
    sha256: "a".repeat(64),
  },
};

const provenance: ReceiptImportProvenance = {
  sourceRepository: "legacy",
  sourceRevision: "d05c261",
  snapshotId: "snapshot-1",
  sourceWatermark: "binlog:1",
  transformationRevision: "receipt-import-v1",
  sourceDigest: "b".repeat(64),
  destinationIdentity: "receipt-1",
};

const cases: ReadonlyArray<{
  readonly reason: ReceiptQuarantineReason;
  readonly row: LegacyReceiptRow;
}> = [
  { reason: "UnresolvedOwner", row: { ...validRow, ownerPersonId: null } },
  { reason: "UnresolvedDepartment", row: { ...validRow, departmentId: null } },
  { reason: "MissingVisualId", row: { ...validRow, visualId: null } },
  { reason: "InvalidAmount", row: { ...validRow, amountDecimal: "123.456" } },
  {
    reason: "UnsupportedFile",
    row: { ...validRow, file: { ...validRow.file!, contentType: "image/gif" } },
  },
  {
    reason: "InvalidFileIdentity",
    row: {
      ...validRow,
      file: {
        ...validRow.file!,
        objectKey: validRow.file!.fileRef,
      },
    },
  },
  {
    reason: "UnreadableFile",
    row: { ...validRow, file: { ...validRow.file!, sha256: "invalid" } },
  },
  {
    reason: "UnreadableFile",
    row: {
      ...validRow,
      file: { ...validRow.file!, byteLength: Number.MAX_SAFE_INTEGER + 1 },
    },
  },
  { reason: "InvalidDescription", row: { ...validRow, description: "" } },
  { reason: "InvalidReceiptDate", row: { ...validRow, receiptDate: "2026-02-31" } },
  {
    reason: "InvalidSubmittedAt",
    row: { ...validRow, submittedAt: "2026-08-20T12:00:00" },
  },
  { reason: "UnknownStatus", row: { ...validRow, status: "unknown" } },
  {
    reason: "RefundDateContradiction",
    row: { ...validRow, status: "refunded", refundDate: null },
  },
  {
    reason: "MissingPaymentAccount",
    row: { ...validRow, paymentAccountCiphertext: null },
  },
  { reason: "MissingFile", row: { ...validRow, file: null } },
];

it("covers every row-local Receipt quarantine reason", () => {
  for (const fixture of cases) {
    const result = importLegacyReceipt(fixture.row, "receipt-1", provenance);
    expect(result._tag).toBe("QuarantinedReceiptImport");
    if (result._tag === "QuarantinedReceiptImport") {
      expect(result.reasons).toContain(fixture.reason);
    }
  }
});

it("quarantines every member of duplicate source and visual identity sets", () => {
  const duplicate = {
    row: validRow,
    receiptId: "receipt-1",
    provenance,
  };
  const results = importLegacyReceipts([
    duplicate,
    {
      row: { ...validRow },
      receiptId: "receipt-2",
      provenance: { ...provenance, destinationIdentity: "receipt-2" },
    },
  ]);
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result).toMatchObject({
      _tag: "QuarantinedReceiptImport",
      reasons: expect.arrayContaining(["SourceIdentityCollision", "DuplicateVisualId"]),
    });
  }
});

it("emits byte-identical reconciliation decisions across repeated runs", () => {
  const inputs = cases.map(({ row }, index) => ({
    row: { ...row, sourcePrimaryKey: `legacy-${index}` },
    receiptId: `receipt-${index}`,
    provenance: { ...provenance, destinationIdentity: `receipt-${index}` },
  }));
  expect(canonicalJson(importLegacyReceipts(inputs))).toBe(
    canonicalJson(importLegacyReceipts(inputs)),
  );
});
