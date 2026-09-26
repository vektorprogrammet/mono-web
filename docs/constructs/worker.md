# worker

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Runs background workers on the Effect clock. The [index](../constructs.md) lists every category.

## `pollForever`

Runs `tick` at once, then again after each success.

```ts
pollForever<A, E, R>(
  tick: Effect.Effect<A, E, R>,
  options: PollOptions<A>
): Effect.Effect<never, E, R>
```

- Inputs:
  - `tick: Effect.Effect<A, E, R>`
  - `options: PollOptions<A>`
- Output: `Effect.Effect<never, E, R>`
- Errors: `E`
- Requirements: `R`
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/worker-support.ts:24](../../apps/backend/src/worker-support.ts#L24)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
