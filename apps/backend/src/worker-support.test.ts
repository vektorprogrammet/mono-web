import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { pollForever } from "./worker-support.js";

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

describe("pollForever", () => {
  it("ticks at once, waits the interval after idle ticks, and stops when interrupted", async () => {
    const observed = await runWithTestClock(
      Effect.gen(function* () {
        let ticks = 0;
        const tick = Effect.sync(() => ++ticks);

        // The first three ticks made progress and must not wait.
        const fiber = yield* Effect.forkChild(
          pollForever(tick, { interval: "10 seconds", skipDelay: (count) => count < 3 }),
        );

        yield* TestClock.adjust(0);
        const afterStart = ticks;
        yield* TestClock.adjust("9999 millis");
        const beforeInterval = ticks;
        yield* TestClock.adjust("1 milli");
        const afterInterval = ticks;

        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        yield* TestClock.adjust("1 minute");

        return { afterStart, beforeInterval, afterInterval, afterInterrupt: ticks, exit };
      }),
    );

    expect(observed).toMatchObject({
      afterStart: 3,
      beforeInterval: 3,
      afterInterval: 4,
      afterInterrupt: 4,
    });
    expect(Exit.isFailure(observed.exit) && Cause.hasInterruptsOnly(observed.exit.cause)).toBe(
      true,
    );
  });

  it("stops at the first tick failure with that failure", async () => {
    const observed = await runWithTestClock(
      Effect.gen(function* () {
        let ticks = 0;

        const tick = Effect.suspend(() =>
          ++ticks === 2 ? Effect.fail("delivery store unavailable" as const) : Effect.void,
        );

        const fiber = yield* Effect.forkChild(pollForever(tick, { interval: "1 second" }));
        yield* TestClock.adjust("1 minute");

        return { ticks, exit: yield* Fiber.await(fiber) };
      }),
    );

    expect(observed.ticks).toBe(2);
    expect(observed.exit).toEqual(Exit.fail("delivery store unavailable"));
  });
});
