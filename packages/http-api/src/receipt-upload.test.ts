import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { MultipartError } from "effect/unstable/http/Multipart";
import { ReceiptFileTooLarge, readBoundedReceiptForm } from "./receipt-upload.js";

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

  it.each([";", " ;"])("preserves opaque binary bytes with separator %s", async (separator) => {
    const form = new FormData();
    const bytes = new Uint8Array([0, 255, 17, 42]);
    form.set("file", new File([bytes], "receipt.png", { type: "image/png" }));

    const request = new Request("http://receipt.test", { method: "POST", body: form });
    request.headers.set(
      "content-type",
      request.headers.get("content-type")!.replace(";", separator),
    );
    const parsed = await readBoundedReceiptForm(request, bytes.length);

    const file = parsed.get("file");
    assert.ok(file instanceof File);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
  // One transport chunk carries the whole body; 200_000 bytes also exceed the transfer bound.
  it.each([5, 200_000])(
    "reports a %s-byte file beyond its limit with the fields sent before it",
    async (fileBytes) => {
      const form = new FormData();
      form.set("commandId", "receipt-command");
      form.set("file", new File([new Uint8Array(fileBytes)], "receipt.png", { type: "image/png" }));
      const encoded = new Request("http://receipt.test", { method: "POST", body: form });
      const bytes = await encoded.arrayBuffer();
      const headers = new Headers(encoded.headers);
      headers.set("content-length", String(bytes.byteLength));

      const request = new Request(encoded.url, { method: encoded.method, headers, body: bytes });

      const failure = await readBoundedReceiptForm(request, 4).catch((error: Error) => error);
      assert.ok(failure instanceof ReceiptFileTooLarge);
      expect([...failure.fields.entries()]).toEqual([["commandId", "receipt-command"]]);
    },
  );
  it("cancels an incomplete multipart source when the request is aborted", async () => {
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '--receipt\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n',
          ),
        );
      },
      pull() {
        started.resolve();
      },
      cancel() {
        cancelled.resolve();
      },
    });

    const options: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=receipt" },
      body,
      signal: abort.signal,
      duplex: "half",
    };

    const pending = readBoundedReceiptForm(new Request("http://receipt.test", options), 1024);
    await started.promise;
    abort.abort();
    await expect(pending).rejects.toThrow();
    await cancelled.promise;
  });
});
