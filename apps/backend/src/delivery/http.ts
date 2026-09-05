import { Duration, Effect } from "effect";

export interface HttpDeliveryConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly deliveryTimeoutMilliseconds: number;
}
export type DeliveryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
/** Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance. */
export const deliverJson = (
  body: unknown,
  config: HttpDeliveryConfig,
  fetchEffect: DeliveryFetch,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchEffect(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Delivery rejected");
      await response.body?.cancel();
    },
    catch: () => new Error("Delivery unavailable"),
  }).pipe(Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)));
