import { Data, Schema, Duration, Effect } from "effect";

export interface HttpDeliveryConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly deliveryTimeoutMilliseconds: number;
}

export type DeliveryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpDeliveryFailure extends Data.TaggedError("HttpDeliveryFailure")<{
  readonly reason: "Rejected" | "Unavailable";
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/** Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance. */
export const deliverJson = (
  body: Schema.Json,
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

      if (!response.ok)
        throw new HttpDeliveryFailure({ reason: "Rejected", status: response.status });
      await response.body?.cancel();
    },
    catch: (cause) =>
      cause instanceof HttpDeliveryFailure
        ? cause
        : new HttpDeliveryFailure({ reason: "Unavailable", cause }),
  }).pipe(Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)));
