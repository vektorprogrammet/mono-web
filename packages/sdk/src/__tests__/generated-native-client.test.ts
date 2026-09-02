import { IdempotencyKey, StrongETag } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectClient, type EffectSdk } from "../effect-client.js";

describe("generated NativeApi client", () => {
  it("encodes reflected Idempotency-Key and If-Match headers on an action path", async () => {
    let requestUrl: string | undefined;
    let requestHeaders: Headers | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response("", { status: 500 });
    };
    const client = createEffectClient("https://api.example.test", { fetch });
    type RefundRequest = Parameters<EffectSdk["receipts"]["refundReceipt"]>[0];

    await Effect.runPromiseExit(
      client.receipts.refundReceipt({
        params: { receiptId: "receipt-1" } as RefundRequest["params"],
        headers: {
          "idempotency-key": IdempotencyKey.make("AAAAAAAAAAAAAAAAAAAAAA"),
          "if-match": StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
        },
        payload: {},
      }),
    );

    expect(requestUrl).toBe("https://api.example.test/api/receipts/receipt-1:refund");
    expect(requestHeaders?.get("Idempotency-Key")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(requestHeaders?.get("If-Match")).toBe(
      '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    );
  });
  it("decodes Fetch-normalized response headers for a private session read", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          sessionId: "session-1",
          personId: "person-1",
          createdAt: "2026-09-02T08:00:00.000Z",
          updatedAt: "2026-09-02T08:00:00.000Z",
          expiresAt: "2026-09-09T08:00:00.000Z",
          ipAddress: null,
          userAgent: null,
          current: true,
        }),
        {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "application/json",
            Vary: "Origin",
          },
        },
      );
    const client = createEffectClient("https://api.example.test", { fetch });

    const result = await Effect.runPromise(client.system.readSession());

    expect(result.headers).toEqual({
      "cache-control": "private, no-store",
      vary: "Origin",
    });
  });
});
