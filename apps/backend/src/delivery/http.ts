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
 * @remarks
 * Sends one POST of `body` to `config.endpoint` through the `HttpClient` of the composition, with
 * `authorization: Bearer <config.token>`, `content-type: application/json`, and then `headers`,
 * which override both. The request carries no trace headers, and a redirect fails it instead of
 * being followed, so the provider sees what a bare `fetch` sends. A 2xx status acknowledges the
 * delivery, and the response body is released unread. Any other status fails with
 * `HttpDeliveryFailure` of reason `Rejected` and that status, and a transport failure with reason
 * `Unavailable`. `config.deliveryTimeoutMilliseconds` bounds the whole exchange; exceeding it fails
 * with `TimeoutError`.
 *
 * @sideEffects One HTTP POST to `config.endpoint`; the timeout waits on the Effect clock.
 *
 * @example
 * ```ts
 * deliverJson(request, config, { "idempotency-key": request.effectId }).pipe(
 *   Effect.provideService(HttpClient.HttpClient, client),
 * );
 * ```
 *
 * @avoid A provider call through `fetch` or `HttpClient` by hand, or `deliverJson` inside
 * `Effect.retry`: a POST that timed out may already be accepted, so a second one can deliver
 * twice. Deliver through `deliverJson` with the effect's id as `idempotency-key`, and let the
 * outbox claim decide whether a failed attempt runs again.
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
