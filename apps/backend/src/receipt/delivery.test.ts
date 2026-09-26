import { describe, expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
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
  it.effect("sends stable identity only to configured transport with redirects disabled", () =>
    Effect.gen(function* () {
      const config = receiptDeliveryConfig(env)!;

      const requests: Array<{ readonly url: string; readonly redirect: RequestInit["redirect"] }> =
        [];

      yield* deliverJson({ deliveryId: "stable" }, config.transport, {
        "idempotency-key": "stable",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request, url, _signal, fiber) =>
            Effect.sync(() => {
              requests.push({
                url: url.href,
                redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)
                  ?.redirect,
              });
              expect(request.headers).toMatchObject({
                authorization: "Bearer synthetic-token",
                "idempotency-key": "stable",
              });

              return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
            }),
          ),
        ),
      );

      expect(requests).toEqual([{ url: env.RECEIPT_DELIVERY_URL, redirect: "error" }]);
    }),
  );
  it.live("does not acknowledge rejection or a timeout", () =>
    Effect.gen(function* () {
      const config = receiptDeliveryConfig(env)!;

      const rejected = yield* Effect.flip(
        deliverJson({}, config.transport).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
              ),
            ),
          ),
        ),
      );

      expect(rejected).toHaveProperty("_tag", "HttpDeliveryFailure");
      expect(rejected).toMatchObject({ reason: "Rejected", status: 503 });

      const unanswered = yield* Effect.flip(
        deliverJson({}, config.transport).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.never),
          ),
        ),
      );

      expect(unanswered).toHaveProperty("_tag", "TimeoutError");
    }),
  );
});
