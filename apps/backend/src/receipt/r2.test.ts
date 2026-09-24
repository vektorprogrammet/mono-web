import { Predicate, Effect } from "effect";
import { describe, expect, it } from "vitest";
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
      arrayBuffer: async () => entry.bytes.slice().buffer,
    };
  };

  return {
    get: async (key) => objectFor(key),
    put: async (key, value, options) => {
      const ifNoneMatch =
        options?.onlyIf instanceof Headers
          ? options.onlyIf.get("if-none-match")
          : options?.onlyIf?.etagDoesNotMatch;

      if (ifNoneMatch === "*" && entries.has(key)) return null;

      const bytes = Predicate.isString(value)
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value.slice()
          : new Uint8Array(value.slice(0));

      entries.set(key, { bytes, contentType: options?.httpMetadata?.contentType });

      return objectFor(key);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    keys: () => [...entries.keys()].sort(),
  };
};

const apply = (store: ReturnType<typeof makeR2ReceiptFileStore>, request: ReceiptFileRequest) =>
  Effect.runPromise(store.service.apply(request));

describe("makeR2ReceiptFileStore", () => {
  it("stages privately, promotes once, survives restart, and rejects a conflicting replay", async () => {
    const bucket = memoryBucket();
    const initial = makeR2ReceiptFileStore({ bucket });

    const staged = await initial.stageBytes(
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

    const promotion: ReceiptFileRequest = ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
      effectId: "effect-1",
      receiptId: "receipt-1",
      commandId: "command-1",
      file: staged.file,
    });

    await apply(initial, promotion);
    expect(bucket.keys()).toContain(staged.file.objectKey);
    expect(bucket.keys().some((key) => key.startsWith("effects/"))).toBe(true);
    await expect(initial.readCommitted(staged.file, 64)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );

    const restarted = makeR2ReceiptFileStore({ bucket });
    await expect(apply(restarted, promotion)).resolves.toBeUndefined();
    {
      const observed = apply(restarted, { ...promotion, commandId: "conflicting-command" });
      await expect(observed).rejects.toHaveProperty("_tag", "ReceiptFileEffectConflict");
      await expect(observed).rejects.toMatchObject({ effectId: "effect-1" });
    }

    await expect(restarted.readCommitted(staged.file, 64)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("allows only one payload to claim a concurrent effect id", async () => {
    const bucket = memoryBucket();
    const store = makeR2ReceiptFileStore({ bucket });

    const staged = await store.stageBytes(
      new File([new Uint8Array([5, 6, 7])], "receipt.pdf", { type: "application/pdf" }),
      "winning-command",
      "application/pdf",
      64,
    );

    const promotion: ReceiptFileRequest = ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
      effectId: "contended-effect",
      receiptId: "receipt-2",
      commandId: "winning-command",
      file: staged.file,
    });

    const results = await Promise.allSettled([
      apply(store, promotion),
      apply(store, { ...promotion, commandId: "conflicting-command" }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: new ReceiptFileEffectConflict({ effectId: "contended-effect" }),
    });
    await expect(store.readCommitted(staged.file, 64)).resolves.toEqual(new Uint8Array([5, 6, 7]));
  });
});
