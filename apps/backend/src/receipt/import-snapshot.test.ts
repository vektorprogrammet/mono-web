import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest, readSnapshotFile } from "./import-snapshot.js";
import { makeReceiptFileStore } from "./filesystem.js";
import { Effect } from "effect";
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
    store.service.apply({
      _tag: "PromoteReceiptFile",
      commandId: "test-owner",
      effectId: "test-promote",
      receiptId: "test-receipt",
      file: staged.file,
    }),
  );
  expect(digest(await store.readCommitted(staged.file, 1024))).toBe(f.file.sha256);
  await writeFile(join(f.root, "committed", staged.file.objectKey), "corrupted");
  await expect(store.readCommitted(staged.file, 1024)).rejects.toThrow();
});
