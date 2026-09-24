import { IdempotencyKey, StrongETag, ReceiptId } from "@vektorprogrammet/http-api";

import { Effect } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createEffectClient, type EffectSdk, type FetchCapability } from "../effect-client.js";
import type { PromiseSdk } from "../promise.js";

describe("generated NativeApi client", () => {
  it("accepts a fetch capability without runtime-specific static methods", () => {
    expectTypeOf<
      (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>
    >().toExtend<FetchCapability>();
  });
  it("accepts the complete command union through one Promise endpoint", () => {
    expectTypeOf<PromiseSdk["placements"]["commandBoard"]>().toEqualTypeOf<
      (
        ...args: Parameters<EffectSdk["placements"]["commandBoard"]>
      ) => Promise<Effect.Success<ReturnType<EffectSdk["placements"]["commandBoard"]>>>
    >();

    type Request = Parameters<PromiseSdk["placements"]["commandBoard"]>[0];

    expectTypeOf<{
      query: Request["query"];
      headers: Request["headers"];
      payload: Request["payload"];
    }>().toExtend<Request>();
  });
  it("encodes reflected Idempotency-Key and If-Match headers on an action path", async () => {
    let requestUrl: string | undefined;
    let requestHeaders: Headers | undefined;

    const fetch: FetchCapability = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);

      return new Response("", { status: 500 });
    };

    const client = createEffectClient("https://api.example.test", { fetch });

    await Effect.runPromiseExit(
      client.receipts.approveReceipt({
        params: { receiptId: ReceiptId.make("receipt-1") },
        headers: {
          "idempotency-key": IdempotencyKey.make("AAAAAAAAAAAAAAAAAAAAAA"),
          "if-match": StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
        },
        payload: {},
      }),
    );

    expect(requestUrl).toBe("https://api.example.test/api/receipts/receipt-1:approve");
    expect(requestHeaders?.get("Idempotency-Key")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(requestHeaders?.get("If-Match")).toBe(
      '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    );
  });
  it("decodes Fetch-normalized response headers for a private session read", async () => {
    const fetch: FetchCapability = async () =>
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
