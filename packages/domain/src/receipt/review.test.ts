import { Predicate, Schema } from "effect";
import { expect, it } from "@effect/vitest";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { importLegacyReceipt, ReceiptQuarantineReason } from "./import.js";
import {
  decodeReviewedReceiptSnapshot,
  receiptSourceRevision,
  receiptSourceRowDigest,
  ReceiptReviewEntry,
  type ReceiptSourceRow,
  type ReviewedReceiptSnapshot,
} from "./review.js";

const row: ReceiptSourceRow = {
  sourcePrimaryKey: "12",
  sourceUserId: "legacy-user:7",
  visualId: "VISUAL-12",
  amountDecimal: "123.45",
  description: "Travel",
  receiptDate: "2026-08-20 00:00:00",
  submittedAt: "2026-08-20 13:00:00",
  status: "pending",
  refundDate: "2026-08-25 14:00:00",
  picturePath: "claims/12.pdf",
  accountCommitment: "key-v1:abcdef",
};

const entry = ReceiptReviewEntry.members[1].make({
  sourcePrimaryKey: row.sourcePrimaryKey,
  sourceRowDigest: receiptSourceRowDigest(row),
  evidenceRef: "review:12",
  person: { occurrenceId: "person:7", sourceUserId: "legacy-user:7", personId: PersonId.make("person-7") },
  department: { sourceDepartmentId: "legacy-department:1", departmentId: DepartmentId.make("department-1") },
  receiptDate: "2026-08-20",
  submittedAt: "2026-08-20T13:00:00+02:00",
  approvedAt: null,
  file: { path: "claims/12.pdf", sha256: "a".repeat(64), byteLength: 100, contentType: "application/pdf" },
  payment: { commitment: row.accountCommitment, evidenceRef: "account-owner:7" },
});

const snapshot: ReviewedReceiptSnapshot = {
  review: {
    sourceRepository: "vektorprogrammet/vektorprogrammet",
    sourceRevision: "source-revision",
    receiptSourceRevision: receiptSourceRevision([row]),
    snapshotId: "receipt-review-1",
    sourceWatermark: "2026-09-24T10:00:00Z",
    transformationRevision: "transformation-1",
    personSnapshotKey: "b".repeat(64),
    referenceSnapshotId: "references-1",
    referenceDigest: "c".repeat(64),
    attestedBy: "operator",
    evidenceRef: "review:cohort",
    entries: [entry],
  },
  rows: [row],
};

it("requires exactly one review decision per source occurrence, including excluded rows", () => {
  const excluded = ReceiptReviewEntry.members[0].make({
    sourcePrimaryKey: row.sourcePrimaryKey,
    sourceRowDigest: receiptSourceRowDigest(row), reason: "Outside cohort", evidenceRef: "exclude:12",
  });

  const input = { ...snapshot, review: { ...snapshot.review, entries: [excluded] } };
  expect(decodeReviewedReceiptSnapshot(input).review.entries).toEqual([excluded]);

  for (const entries of [[], [excluded, excluded], [{ ...excluded, sourcePrimaryKey: "unknown" }]]) {
    expect(() => decodeReviewedReceiptSnapshot({ ...input, review: { ...input.review, entries } })).toThrow();
  }

  expect(() => decodeReviewedReceiptSnapshot({ ...input, rows: [row, row] })).toThrow();
});

it("binds raw stale refund dates and account commitments without interpreting either as payment", () => {
  const decoded = decodeReviewedReceiptSnapshot(snapshot);
  expect(decoded.rows[0]?.refundDate).toBe(row.refundDate);
  expect(decoded.review.entries[0]).toMatchObject({ approvedAt: null });

  for (const changed of [{ ...row, refundDate: null }, { ...row, accountCommitment: "other-key:commitment" }]) {
    expect(() => decodeReviewedReceiptSnapshot({ ...snapshot, rows: [changed] })).toThrow();
  }

  expect(() => decodeReviewedReceiptSnapshot({
    ...snapshot, review: { ...snapshot.review, entries: [{ ...entry, payment: { ...entry.payment, commitment: "changed" } }] },
  })).toThrow();
});

it("allows an explicitly unresolved owner, never an invented source ownership mapping", () => {
  const ownerless = { ...row, sourceUserId: null, accountCommitment: null };
  const decision = { ...entry, person: null, sourceRowDigest: receiptSourceRowDigest(ownerless), payment: { ...entry.payment, commitment: null } };

  const input = {
    rows: [ownerless],
    review: { ...snapshot.review, receiptSourceRevision: receiptSourceRevision([ownerless]), entries: [decision] },
  };

  expect(decodeReviewedReceiptSnapshot(input).review.entries[0]).toMatchObject({ person: null });
  expect(() => decodeReviewedReceiptSnapshot({
    ...input, review: { ...input.review, entries: [{ ...decision, person: entry.person }] },
  })).toThrow();
  expect(() => decodeReviewedReceiptSnapshot({
    ...snapshot, review: { ...snapshot.review, entries: [{ ...entry, person: { ...entry.person!, sourceUserId: "legacy-user:8" } }] },
  })).toThrow();
});

it("requires explicit timezone shape but leaves impossible calendars to native quarantine", () => {
  expect(() => decodeReviewedReceiptSnapshot({
    ...snapshot, review: { ...snapshot.review, entries: [{ ...entry, submittedAt: "2026-08-20T13:00:00" }] },
  })).toThrow();
  const invalidCalendar = { ...entry, receiptDate: "2026-02-31" };

  const decoded = decodeReviewedReceiptSnapshot({
    ...snapshot, review: { ...snapshot.review, entries: [invalidCalendar] },
  });

  const decision = decoded.review.entries[0];

  if (!Predicate.isTagged(decision, "Import")) throw new Error("Import decision required");

  const result = importLegacyReceipt({
    ...row,
    ownerPersonId: entry.person!.personId,
    departmentId: entry.department.departmentId,
    receiptDate: decision.receiptDate,
    submittedAt: decision.submittedAt,
    refundDate: decision.approvedAt,
    paymentAccountCiphertext: "encrypted-account",
    file: { ...decision.file, fileRef: "staged-12", objectKey: "private-12" },
  }, "receipt-12", {
    sourceRepository: snapshot.review.sourceRepository, sourceRevision: snapshot.review.sourceRevision,
    snapshotId: snapshot.review.snapshotId, sourceWatermark: snapshot.review.sourceWatermark,
    transformationRevision: snapshot.review.transformationRevision,
    sourceDigest: entry.sourceRowDigest, destinationIdentity: "receipt-12",
  });

  if (!Predicate.isTagged(result, "QuarantinedReceiptImport")) throw new Error("Quarantine required");
  expect(result.reasons).toEqual(["InvalidReceiptDate"]);
});

it("does not infer approval from a legacy refund date", () => {
  const refunded = { ...row, status: "refunded" };
  const reviewed = { ...entry, sourceRowDigest: receiptSourceRowDigest(refunded) };
  const input = { rows: [refunded], review: { ...snapshot.review, receiptSourceRevision: receiptSourceRevision([refunded]), entries: [reviewed] } };
  expect(() => decodeReviewedReceiptSnapshot(input)).toThrow();
  expect(decodeReviewedReceiptSnapshot({
    ...input, review: { ...input.review, entries: [{ ...reviewed, approvedAt: "2026-08-25T12:00:00Z" }] },
  }).review.entries[0]).toMatchObject({ approvedAt: "2026-08-25T12:00:00Z" });
});

it("rejects undeclared private values instead of silently including them in evidence", () => {
  expect(() => decodeReviewedReceiptSnapshot({
    ...snapshot, rows: [{ ...row, accountNumber: "12345678901" }],
  })).toThrow();
  expect(() => decodeReviewedReceiptSnapshot({
    ...snapshot, review: { ...snapshot.review, entries: [{ ...entry, payment: { ...entry.payment, plaintext: "12345678901" } }] },
  })).toThrow();
});

it("normalizes equivalent reviewed timestamps for native persistence and reconciliation", () => {
  const provenance = {
    sourceRepository: snapshot.review.sourceRepository, sourceRevision: snapshot.review.sourceRevision,
    snapshotId: snapshot.review.snapshotId, sourceWatermark: snapshot.review.sourceWatermark,
    transformationRevision: snapshot.review.transformationRevision,
    sourceDigest: entry.sourceRowDigest, destinationIdentity: "receipt-12",
  };

  const source = {
    ...row, ownerPersonId: entry.person!.personId, departmentId: entry.department.departmentId,
    receiptDate: entry.receiptDate, status: "refunded",
    paymentAccountCiphertext: "encrypted-account",
    file: { ...entry.file, fileRef: "staged-12", objectKey: "private-12" },
  };

  const utc = importLegacyReceipt({
    ...source, submittedAt: "2026-08-20T11:00:00Z", refundDate: "2026-08-25T12:00:00Z",
  }, "receipt-12", provenance);

  const offset = importLegacyReceipt({
    ...source, submittedAt: "2026-08-20T13:00:00+02:00", refundDate: "2026-08-25T14:00:00+02:00",
  }, "receipt-12", provenance);

  if (!Predicate.isTagged(utc, "AcceptedReceiptImport") || !Predicate.isTagged(offset, "AcceptedReceiptImport"))
    throw new Error("Accepted receipt required");
  expect(offset.receipt).toEqual(utc.receipt);
  expect(utc.receipt.submittedAt).toBe("2026-08-20T11:00:00.000Z");
  expect(utc.receipt.approvedAt).toBe("2026-08-25T12:00:00.000Z");
  expect(utc.provenance.sourceDigest).toBe(entry.sourceRowDigest);
});

it("rejects arbitrary private strings as quarantine reason evidence", () => {
  const decodeReasons = Schema.decodeUnknownSync(Schema.Array(ReceiptQuarantineReason));

  expect(decodeReasons(["UnresolvedOwner", "UnreadableFile"])).toEqual(["UnresolvedOwner", "UnreadableFile"]);
  expect(() => decodeReasons(["UnresolvedOwner", "private/account/12345678901"])).toThrow();
});
