import { ReceiptOutboxRequestSchema } from "@vektorprogrammet/domain/receipt";
import { expect, layer } from "@effect/vitest";
import {
  digest,
  readSnapshotFile,
  decodeSnapshot,
  prepareReceiptSnapshot,
  rowDigest,
} from "./import-snapshot.js";
import { makeReceiptFileStore, ReceiptFileStoreError } from "./filesystem.js";
import { TestPlatform } from "../test/platform.js";
import { Schema, Predicate, Effect, FileSystem, Path } from "effect";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-source-test-" });
  const bytes = Buffer.from("%PDF-1.4\nsynthetic\n");
  yield* fs.writeFile(path.join(root, "receipt.pdf"), bytes);

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
});

layer(TestPlatform, { excludeTestServices: true })("receipt snapshot import", (it) => {
  it.effect(
    "rejects traversal, missing bytes, and an outside-root symlink before importing private files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* fixture;
        const outside = yield* fixture;
        yield* fs.symlink(path.join(outside.root, "receipt.pdf"), path.join(f.root, "outside.pdf"));

        const reasons = yield* Effect.forEach(
          ["../receipt.pdf", "missing.pdf", "outside.pdf"],
          (at) =>
            Effect.flip(readSnapshotFile(f.root, { ...f.file, path: at })).pipe(
              Effect.map(({ reason }) => reason),
            ),
        );

        expect(reasons).toEqual(["UnsafeFilePath", "UnreadableFile", "UnsafeFilePath"]);
      }),
  );

  it.effect("checks source size and content digest rather than trusting declared metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture;

      const wrongDigest = yield* Effect.flip(
        readSnapshotFile(f.root, { ...f.file, sha256: "0".repeat(64) }),
      );

      yield* fs.truncate(path.join(f.root, "receipt.pdf"), 11 * 1024 * 1024);

      const oversized = yield* Effect.flip(
        readSnapshotFile(f.root, { ...f.file, byteLength: 11 * 1024 * 1024 }),
      );

      expect([wrongDigest.reason, oversized.reason]).toEqual([
        "FileDigestMismatch",
        "FileDigestMismatch",
      ]);
    }),
  );

  it.effect("downloads only matching committed bytes, rejecting tampering", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture;

      const store = yield* makeReceiptFileStore({
        stagingRoot: path.join(f.root, "staging"),
        committedRoot: path.join(f.root, "committed"),
      });

      const staged = yield* store.stageBytes(
        new File([f.bytes], "receipt.pdf"),
        "test-owner",
        "application/pdf",
        1024,
      );

      yield* store.service.apply(
        ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
          commandId: "test-owner",
          effectId: "test-promote",
          receiptId: "test-receipt",
          file: staged.file,
        }),
      );
      expect(digest(yield* store.readCommitted(staged.file, 1024))).toBe(f.file.sha256);
      yield* fs.writeFileString(path.join(f.root, "committed", staged.file.objectKey), "corrupted");

      expect(yield* Effect.flip(store.readCommitted(staged.file, 1024))).toBeInstanceOf(
        ReceiptFileStoreError,
      );
    }),
  );

  it.effect("restores missing committed bytes when the same promotion is replayed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture;

      const store = yield* makeReceiptFileStore({
        stagingRoot: path.join(f.root, "staging"),
        committedRoot: path.join(f.root, "committed"),
      });

      const stage = store.stageBytes(
        new File([f.bytes], "receipt.pdf"),
        "restore-owner",
        "application/pdf",
        1024,
      );

      const original = yield* stage;

      const request = ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
        commandId: "restore-owner",
        effectId: "restore-promotion",
        receiptId: "restore-receipt",
        file: original.file,
      });

      yield* store.service.apply(request);
      yield* fs.remove(path.join(f.root, "committed", original.file.objectKey));
      yield* stage;
      yield* store.service.apply(request);
      expect(Buffer.from(yield* store.readCommitted(original.file, 1024))).toEqual(f.bytes);
    }),
  );

  it.effect("accounts for malformed occurrences and rejects a collision with a decoded row", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const f = yield* fixture;

      const store = yield* makeReceiptFileStore({
        stagingRoot: path.join(f.root, "stage"),
        committedRoot: path.join(f.root, "objects"),
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

      const result = yield* prepareReceiptSnapshot(snapshot, f.root, store);
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
    }),
  );
});
