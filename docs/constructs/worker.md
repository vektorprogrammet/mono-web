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
- Side effects: Waits on the Effect clock between ticks; every write is the tick's own.
- Source: [apps/backend/src/worker-support.ts:44](../../apps/backend/src/worker-support.ts#L44)

**How it works**

The delay between the end of one tick and the start of the next is `options.interval`, on
`Schedule.spaced`. When `options.skipDelay` answers true for the result of a tick, the next tick
starts at once, so a worker that made progress drains its queue without waiting. The delay uses
the Clock service, so `TestClock` controls it. The first tick failure stops the loop with that
failure, and interruption stops the current tick or delay; the loop never succeeds.

**Use**

```ts
pollForever(tick, {
  interval: Duration.millis(options.pollIntervalMilliseconds),
  skipDelay: Predicate.isTagged("Delivered"),
});
```

**Avoid**

A worker loop of `setTimeout` or `setInterval`, or a hand-written repeat of the tick and
`Effect.sleep`: timers run on real time, which `TestClock` cannot drive, and a hand-written loop
tends to swallow a failed tick. Pass the tick to `pollForever`, and let a failure that the tick
does not handle end the worker.
