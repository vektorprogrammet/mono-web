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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/delivery/http.ts:32](../../apps/backend/src/delivery/http.ts#L32)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
