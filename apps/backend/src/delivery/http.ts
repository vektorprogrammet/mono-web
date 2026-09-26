/**
 * Acknowledged JSON delivery to a provider endpoint.
 *
 * Use `deliverJson` when a worker delivers a committed effect over HTTP. It sends one POST with
 * the bearer token and the caller's headers through the composition's `HttpClient`, refuses
 * redirects, adds no trace headers, and discards the response body unread.
 *
 * A status outside 2xx fails with `Rejected`, a transport failure with `Unavailable`, and the
 * delivery timeout with a timeout failure. It never retries: the caller's outbox claim decides
 * whether an ambiguous attempt runs again.
 */
import { Data, Duration, Effect, Stream, type Cause, type Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export interface HttpDeliveryConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly deliveryTimeoutMilliseconds: number;
}

export class HttpDeliveryFailure extends Data.TaggedError("HttpDeliveryFailure")<{
  readonly reason: "Rejected" | "Unavailable";
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/**
 * Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.
 *
 * @construct delivery
 */
export const deliverJson = (
  body: Schema.Json,
  config: HttpDeliveryConfig,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<void, HttpDeliveryFailure | Cause.TimeoutError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(config.endpoint).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...headers,
      }),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(HttpClient.execute),
      // The provider sees the request of the bare fetch: no trace headers, and no redirect.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.mapError((cause) => new HttpDeliveryFailure({ reason: "Unavailable", cause })),
    );

    if (response.status < 200 || response.status > 299)
      return yield* new HttpDeliveryFailure({ reason: "Rejected", status: response.status });

    // Closing the scope of the unread pull cancels the body reader.
    yield* Stream.toPull(response.stream).pipe(Effect.asVoid, Effect.scoped);
  }).pipe(Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)));
