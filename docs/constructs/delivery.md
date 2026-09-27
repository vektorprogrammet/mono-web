# delivery

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Delivers committed effects to providers after the transaction. The [index](../constructs.md) lists every category.

## `deliverJson`

Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.

```ts
deliverJson(
  body: Schema.Json,
  config: HttpDeliveryConfig,
  headers: Readonly<Record<string, string>> = {}
): Effect.Effect<void, HttpDeliveryFailure | Cause.TimeoutError, HttpClient.HttpClient>
```

- Inputs:
  - `body: Schema.Json`
  - `config: HttpDeliveryConfig`
  - `headers: Readonly<Record<string, string>> = {}`
- Output: `Effect.Effect<void, HttpDeliveryFailure | Cause.TimeoutError, HttpClient.HttpClient>`
- Errors: `HttpDeliveryFailure | Cause.TimeoutError`
- Requirements: `HttpClient.HttpClient`
- Side effects: One HTTP POST to `config.endpoint`; the timeout waits on the Effect clock.
- Source: [apps/backend/src/delivery/http.ts:56](../../apps/backend/src/delivery/http.ts#L56)

**How it works**

Sends one POST of `body` to `config.endpoint` through the `HttpClient` of the composition, with
`authorization: Bearer <config.token>`, `content-type: application/json`, and then `headers`,
which override both. The request carries no trace headers, and a redirect fails it instead of
being followed, so the provider sees what a bare `fetch` sends. A 2xx status acknowledges the
delivery, and the response body is released unread. Any other status fails with
`HttpDeliveryFailure` of reason `Rejected` and that status, and a transport failure with reason
`Unavailable`. `config.deliveryTimeoutMilliseconds` bounds the whole exchange; exceeding it fails
with `TimeoutError`.

**Use**

```ts
deliverJson(request, config, { "idempotency-key": request.effectId }).pipe(
  Effect.provideService(HttpClient.HttpClient, client),
);
```

**Avoid**

A provider call through `fetch` or `HttpClient` by hand, or `deliverJson` inside
`Effect.retry`: a POST that timed out may already be accepted, so a second one can deliver
twice. Deliver through `deliverJson` with the effect's id as `idempotency-key`, and let the
outbox claim decide whether a failed attempt runs again.
