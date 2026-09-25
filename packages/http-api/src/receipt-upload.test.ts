import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { MultipartError } from "effect/unstable/http/Multipart";
import { readBoundedReceiptForm } from "./receipt-upload.js";

describe("receipt transfer bounds", () => {
  it.each([undefined, "1"])(
    "cancels an oversized stream despite declared length %s",
    async (length) => {
      let pulls = 0;
      const cancelled = Promise.withResolvers<void>();
      const bytes = new TextEncoder();

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls === 64) {
            controller.close();

            return;
          }

          controller.enqueue(
            pulls++ === 0
              ? bytes.encode(
                  '--receipt\r\nContent-Disposition: form-data; name="description"\r\n\r\n',
                )
              : new Uint8Array(4096).fill(120),
          );
        },
        cancel() {
          cancelled.resolve();
        },
      });

      const headers = new Headers({ "content-type": "multipart/form-data; boundary=receipt" });

      if (length !== undefined) headers.set("content-length", length);

      const options: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers,
        body,
        duplex: "half",
      };

      const request = new Request("http://receipt.test", options);

      const failure = await readBoundedReceiptForm(request, 1).catch((error: Error) => error);
      assert.ok(failure instanceof MultipartError);
      expect(failure.reason._tag).toBe("FieldTooLarge");
      await cancelled.promise;
      expect(pulls).toBeLessThanOrEqual(36);
    },
  );

  it("retains exact private file bytes through a valid bounded multipart transfer", async () => {
    const form = new FormData();
    const bytes = new Uint8Array([0, 255, 17, 42]);
    form.set("file", new File([bytes], "receipt.png", { type: "image/png" }));

    const parsed = await readBoundedReceiptForm(
      new Request("http://receipt.test", { method: "POST", body: form }),
      bytes.length,
    );

    const file = parsed.get("file");
    assert.ok(file instanceof File);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
  it("rejects file bytes beyond the configured limit even below the transfer limit", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([0, 255, 17, 42, 1])], "receipt.png", { type: "image/png" }),
    );
    await expect(
      readBoundedReceiptForm(new Request("http://receipt.test", { method: "POST", body: form }), 4),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
