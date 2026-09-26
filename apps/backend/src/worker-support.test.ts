import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { pollForever } from "./worker-support.js";

describe("pollForever", () => {
  it.effect("ticks at once, waits the interval after idle ticks, and stops when interrupted", () =>
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

      expect({ afterStart, beforeInterval, afterInterval, afterInterrupt: ticks }).toEqual({
        afterStart: 3,
        beforeInterval: 3,
        afterInterval: 4,
        afterInterrupt: 4,
      });
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  it.effect("stops at the first tick failure with that failure", () =>
    Effect.gen(function* () {
      let ticks = 0;

      const tick = Effect.suspend(() =>
        ++ticks === 2 ? Effect.fail("delivery store unavailable" as const) : Effect.void,
      );

      const fiber = yield* Effect.forkChild(pollForever(tick, { interval: "1 second" }));
      yield* TestClock.adjust("1 minute");

      expect(ticks).toBe(2);
      expect(yield* Fiber.await(fiber)).toEqual(Exit.fail("delivery store unavailable"));
    }),
  );
});
