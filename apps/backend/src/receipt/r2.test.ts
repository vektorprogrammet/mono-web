import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ReceiptFileRequest } from "@vektorprogrammet/domain/receipt";
import { makeR2ReceiptFileStore, type R2Bucket, type R2Object } from "./r2.js";

const memoryBucket = (): R2Bucket & { readonly keys: () => ReadonlyArray<string> } => {
  const entries = new Map<string, { readonly bytes: Uint8Array; readonly contentType?: string }>();
  return {
    get: async (key): Promise<R2Object | null> => {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      return {
        size: entry.bytes.byteLength,
        ...(entry.contentType === undefined
          ? {}
          : { httpMetadata: { contentType: entry.contentType } }),
        arrayBuffer: async () => entry.bytes.slice().buffer,
      };
    },
    put: async (key, value, options) => {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value.slice()
            : new Uint8Array(value.slice(0));
      entries.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
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

    const promotion: ReceiptFileRequest = {
      _tag: "PromoteReceiptFile",
      effectId: "effect-1",
      receiptId: "receipt-1",
      commandId: "command-1",
      file: staged.file,
    };
    await apply(initial, promotion);
    expect(bucket.keys()).toContain(staged.file.objectKey);
    expect(bucket.keys().some((key) => key.startsWith("effects/"))).toBe(true);
    await expect(initial.readCommitted(staged.file, 64)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );

    const restarted = makeR2ReceiptFileStore({ bucket });
    await expect(apply(restarted, promotion)).resolves.toBeUndefined();
    await expect(
      apply(restarted, { ...promotion, commandId: "conflicting-command" }),
    ).rejects.toMatchObject({ _tag: "ReceiptFileEffectConflict", effectId: "effect-1" });
    await expect(restarted.readCommitted(staged.file, 64)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });
});
