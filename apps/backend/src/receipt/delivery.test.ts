import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { receiptDeliveryConfig } from "./delivery.js";
import { deliverJson } from "../delivery/http.js";

const env = {
  RECEIPT_DELIVERY_URL: "http://127.0.0.1:9911/accept",
  RECEIPT_DELIVERY_TOKEN: "synthetic-token",
  RECEIPT_DELIVERY_TIMEOUT_MS: "50",
  RECEIPT_DELIVERY_SENDER: "economy@example.invalid",
  RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({ trondheim: "finance@example.invalid" }),
};

describe("receipt acknowledged transport boundary", () => {
  it("distinguishes disabled from invalid partial configuration without leaking secrets", () => {
    expect(receiptDeliveryConfig({})).toBeUndefined();
    expect(() => receiptDeliveryConfig({ RECEIPT_DELIVERY_TOKEN: "private-value" })).toThrow(
      "Invalid receipt delivery configuration",
    );

    for (const endpoint of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/?token=x",
      "file:///tmp/mail",
      "https://example.com/#x",
    ]) {
      expect(() => receiptDeliveryConfig({ ...env, RECEIPT_DELIVERY_URL: endpoint })).toThrow();
    }

    for (const timeout of ["0", "30001", "NaN"])
      expect(() =>
        receiptDeliveryConfig({ ...env, RECEIPT_DELIVERY_TIMEOUT_MS: timeout }),
      ).toThrow();
    expect(() =>
      receiptDeliveryConfig({ ...env, RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: "{}" }),
    ).toThrow();
  });
  it("sends stable identity only to configured transport with redirects disabled", async () => {
    const config = receiptDeliveryConfig(env)!;
    await Effect.runPromise(
      deliverJson(
        { deliveryId: "stable" },
        config.transport,
        async (url, init) => {
          expect(String(url)).toBe(env.RECEIPT_DELIVERY_URL);
          expect(init?.redirect).toBe("error");
          expect(init?.headers).toMatchObject({
            authorization: "Bearer synthetic-token",
            "idempotency-key": "stable",
          });

          return new Response(null, { status: 202 });
        },
        { "idempotency-key": "stable" },
      ),
    );
  });
  it("does not acknowledge rejection or a timeout", async () => {
    const config = receiptDeliveryConfig(env)!;
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          deliverJson({}, config.transport, async () => new Response(null, { status: 503 })),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          deliverJson(
            {},
            config.transport,
            async (_url, init) =>
              new Promise((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
              ),
          ),
        ),
      ),
    ).toBe(true);
  });
});
