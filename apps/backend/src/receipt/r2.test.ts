import { Predicate, Effect, Result } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  ReceiptFileEffectConflict,
  type ReceiptFileRequest,
  ReceiptOutboxRequestSchema,
} from "@vektorprogrammet/domain/receipt";
import { makeR2ReceiptFileStore, type R2Bucket, type R2Object } from "./r2.js";

const memoryBucket = (): R2Bucket & { readonly keys: () => ReadonlyArray<string> } => {
  const entries = new Map<string, { readonly bytes: Uint8Array; readonly contentType?: string }>();

  const objectFor = (key: string): R2Object | null => {
    const entry = entries.get(key);

    if (entry === undefined) return null;

    return {
      size: entry.bytes.byteLength,
      httpMetadata:
        entry.contentType === undefined ? undefined : { contentType: entry.contentType },
      arrayBuffer: () => Promise.resolve(entry.bytes.slice().buffer),
    };
  };

  return {
    get: (key) => Promise.resolve(objectFor(key)),
    put: (key, value, options) => {
      const ifNoneMatch =
        options?.onlyIf instanceof Headers
          ? options.onlyIf.get("if-none-match")
          : options?.onlyIf?.etagDoesNotMatch;

      if (ifNoneMatch === "*" && entries.has(key)) return Promise.resolve(null);

      const bytes = Predicate.isString(value)
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value.slice()
          : new Uint8Array(value.slice(0));

      entries.set(key, { bytes, contentType: options?.httpMetadata?.contentType });

      return Promise.resolve(objectFor(key));
    },
    delete: (key) => {
      entries.delete(key);

      return Promise.resolve();
    },
    keys: () => [...entries.keys()].sort(),
  };
};

describe("makeR2ReceiptFileStore", () => {
  it.effect(
    "stages privately, promotes once, survives restart, and rejects a conflicting replay",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket();
        const initial = makeR2ReceiptFileStore({ bucket });

        const staged = yield* initial.stageBytes(
          new File([new Uint8Array([1, 2, 3, 4])], "user-controlled-name.pdf", {
            type: "application/pdf",
          }),
          "command-1",
          "application/pdf",
          64,
        );

        expect(staged.created).toBe(true);
        expect(staged.file.fileRef).not.toContain("user-controlled-name.pdf");
        expect(bucket.keys()).toEqual([staged.file.fileRef]);

        const promotion: ReceiptFileRequest =
          ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
            effectId: "effect-1",
            receiptId: "receipt-1",
            commandId: "command-1",
            file: staged.file,
          });

        yield* initial.service.apply(promotion);
        expect(bucket.keys()).toContain(staged.file.objectKey);
        expect(bucket.keys().some((key) => key.startsWith("effects/"))).toBe(true);
        expect(yield* initial.readCommitted(staged.file, 64)).toEqual(new Uint8Array([1, 2, 3, 4]));

        const restarted = makeR2ReceiptFileStore({ bucket });
        expect(yield* restarted.service.apply(promotion)).toBeUndefined();

        const observed = yield* Effect.flip(
          restarted.service.apply({ ...promotion, commandId: "conflicting-command" }),
        );

        expect(observed).toHaveProperty("_tag", "ReceiptFileEffectConflict");
        expect(observed).toMatchObject({ effectId: "effect-1" });

        expect(yield* restarted.readCommitted(staged.file, 64)).toEqual(
          new Uint8Array([1, 2, 3, 4]),
        );
      }),
  );

  it.effect("allows only one payload to claim a concurrent effect id", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket();
      const store = makeR2ReceiptFileStore({ bucket });

      const staged = yield* store.stageBytes(
        new File([new Uint8Array([5, 6, 7])], "receipt.pdf", { type: "application/pdf" }),
        "winning-command",
        "application/pdf",
        64,
      );

      const promotion: ReceiptFileRequest =
        ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
          effectId: "contended-effect",
          receiptId: "receipt-2",
          commandId: "winning-command",
          file: staged.file,
        });

      const results = yield* Effect.all(
        [
          Effect.result(store.service.apply(promotion)),
          Effect.result(store.service.apply({ ...promotion, commandId: "conflicting-command" })),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter(Result.isSuccess)).toHaveLength(1);

      expect(results.find(Result.isFailure)).toMatchObject({
        failure: new ReceiptFileEffectConflict({ effectId: "contended-effect" }),
      });

      expect(yield* store.readCommitted(staged.file, 64)).toEqual(new Uint8Array([5, 6, 7]));
    }),
  );
});
