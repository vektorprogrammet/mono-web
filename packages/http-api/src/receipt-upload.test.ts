import { describe, expect, it } from "vitest";
import { readBoundedReceiptForm } from "./receipt-upload.js";

describe("receipt transfer bounds", () => {
  it.each([undefined, "1"])("cancels an oversized stream despite declared length %s", async (length) => {
    let pulls = 0;
    const cancelled = Promise.withResolvers<void>();
    const bytes = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pulls++ === 0
          ? bytes.encode('--receipt\r\nContent-Disposition: form-data; name="description"\r\n\r\n')
          : new Uint8Array(4096).fill(120));
      },
      cancel() { cancelled.resolve(); },
    });
    const headers = new Headers({ "content-type": "multipart/form-data; boundary=receipt" });
    if (length !== undefined) headers.set("content-length", length);
    const request = new Request("http://receipt.test", { method: "POST", headers, body, duplex: "half" } as RequestInit);
    await expect(readBoundedReceiptForm(request, 1)).rejects.toThrow();
    await cancelled.promise;
    expect(pulls).toBeLessThanOrEqual(36);
  });

  it("retains exact private file bytes through a valid bounded multipart transfer", async () => {
    const form = new FormData();
    const bytes = new Uint8Array([0, 255, 17, 42]);
    form.set("file", new File([bytes], "receipt.png", { type: "image/png" }));
    const parsed = await readBoundedReceiptForm(new Request("http://receipt.test", { method: "POST", body: form }), bytes.length);
    expect(new Uint8Array(await (parsed.get("file") as File).arrayBuffer())).toEqual(bytes);
  });
});
