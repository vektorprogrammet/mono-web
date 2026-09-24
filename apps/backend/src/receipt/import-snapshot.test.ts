import { ReceiptOutboxRequestSchema } from "@vektorprogrammet/domain/receipt";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  digest,
  readSnapshotFile,
  decodeSnapshot,
  prepareReceiptSnapshot,
  rowDigest,
} from "./import-snapshot.js";
import { makeReceiptFileStore } from "./filesystem.js";
import { Schema, Predicate, Effect } from "effect";

const directories: string[] = [];

afterEach(async () => {
  for (const p of directories.splice(0)) await rm(p, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-source-test-"));
  directories.push(root);
  const bytes = Buffer.from("%PDF-1.4\nsynthetic\n");
  await writeFile(join(root, "receipt.pdf"), bytes);

  return {
    root,
    bytes,
    file: {
      path: "receipt.pdf",
      sha256: digest(bytes),
      byteLength: bytes.length,
      contentType: "application/pdf",
    },
  };
};

it("rejects traversal, missing bytes, and an outside-root symlink before importing private files", async () => {
  const f = await fixture(),
    outside = await fixture();

  await symlink(join(outside.root, "receipt.pdf"), join(f.root, "outside.pdf"));

  for (const path of ["../receipt.pdf", "missing.pdf", "outside.pdf"])
    await expect(readSnapshotFile(f.root, { ...f.file, path })).rejects.toThrow();
});

it("checks source size and content digest rather than trusting declared metadata", async () => {
  const f = await fixture();
  await expect(readSnapshotFile(f.root, { ...f.file, sha256: "0".repeat(64) })).rejects.toThrow(
    "FileDigestMismatch",
  );
  await truncate(join(f.root, "receipt.pdf"), 11 * 1024 * 1024);
  await expect(
    readSnapshotFile(f.root, { ...f.file, byteLength: 11 * 1024 * 1024 }),
  ).rejects.toThrow("FileDigestMismatch");
});

it("downloads only matching committed bytes, rejecting tampering", async () => {
  const f = await fixture();

  const store = makeReceiptFileStore({
    stagingRoot: join(f.root, "staging"),
    committedRoot: join(f.root, "committed"),
  });

  const staged = await store.stageBytes(
    new File([f.bytes], "receipt.pdf"),
    "test-owner",
    "application/pdf",
    1024,
  );

  await Effect.runPromise(
    store.service.apply(
      ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
        commandId: "test-owner",
        effectId: "test-promote",
        receiptId: "test-receipt",
        file: staged.file,
      }),
    ),
  );
  expect(digest(await store.readCommitted(staged.file, 1024))).toBe(f.file.sha256);
  await writeFile(join(f.root, "committed", staged.file.objectKey), "corrupted");
  await expect(store.readCommitted(staged.file, 1024)).rejects.toThrow();
});

it("accounts for malformed occurrences and rejects a collision with a decoded row", async () => {
  const f = await fixture();

  const store = makeReceiptFileStore({
    stagingRoot: join(f.root, "stage"),
    committedRoot: join(f.root, "objects"),
  });

  const source = {
    sourcePrimaryKey: "same-source",
    destinationIdentity: "first",
    sourceUser: "legacy-owner",
    sourceDepartment: "legacy-dept",
    visualId: "SYN-1",
    amountDecimal: "1.25",
    description: "Synthetic",
    receiptDate: "2026-08-20",
    submittedAt: "2026-08-20T12:00:00.000Z",
    status: "pending",
    refundDate: null,
    file: f.file,
  };

  const envelope = (input: Schema.JsonObject) => {
    const { sourcePrimaryKey, destinationIdentity, ...data } = input;

    return { sourcePrimaryKey, destinationIdentity, data, rowDigest: rowDigest(input) };
  };

  const snapshot = decodeSnapshot({
    kind: "synthetic-receipt-import-0095",
    sourceRepository: "synthetic",
    sourceRevision: "1",
    snapshotId: "1",
    sourceWatermark: "0",
    transformationRevision: "1",
    persons: [
      {
        sourceUser: "legacy-owner",
        personId: "owner",
        syntheticPaymentAccount: "synthetic:0095:not-a-payment-account",
      },
    ],
    departments: [{ sourceDepartment: "legacy-dept", departmentId: "dept" }],
    rows: [
      envelope(source),
      envelope({ ...source, destinationIdentity: "second", description: 42 }),
    ],
  });

  const result = await prepareReceiptSnapshot(snapshot, f.root, store);
  expect(result.results).toHaveLength(2);
  expect(result.results.map((r) => r.sourceOccurrence)).toEqual([0, 1]);

  for (const r of result.results) {
    expect(r._tag).toBe("QuarantinedReceiptImport");

    if (Predicate.isTagged(r, "QuarantinedReceiptImport"))
      expect(r.reasons).toContain("SourceIdentityCollision");
  }

  const malformed = result.results[1]!;

  if (Predicate.isTagged(malformed, "QuarantinedReceiptImport"))
    expect(malformed.reasons).toContain("InvalidSourceRow");
});
