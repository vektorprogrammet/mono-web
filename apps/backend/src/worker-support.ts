/**
 * The polling loop of background workers.
 *
 * Use `pollForever` for a worker that drains a queue or an outbox: it runs one tick, waits for
 * the interval, and runs the next. The wait uses the Clock service, so tests drive it with
 * `TestClock` instead of real time.
 */
import { Duration, Effect, Schedule } from "effect";

export interface PollOptions<A> {
  /** Delay between the end of one tick and the start of the next. */
  readonly interval: Duration.Input;
  /** Starts the next tick without delay, for example after a tick that made progress. */
  readonly skipDelay?: (result: A) => boolean;
}

/**
 * Runs `tick` at once, then again after each success.
 *
 * @remarks
 * The delay between the end of one tick and the start of the next is `options.interval`, on
 * `Schedule.spaced`. When `options.skipDelay` answers true for the result of a tick, the next tick
 * starts at once, so a worker that made progress drains its queue without waiting. The delay uses
 * the Clock service, so `TestClock` controls it. The first tick failure stops the loop with that
 * failure, and interruption stops the current tick or delay; the loop never succeeds.
 *
 * @sideEffects Waits on the Effect clock between ticks; every write is the tick's own.
 *
 * @example
 * ```ts
 * pollForever(tick, {
 *   interval: Duration.millis(options.pollIntervalMilliseconds),
 *   skipDelay: Predicate.isTagged("Delivered"),
 * });
 * ```
 *
 * @avoid A worker loop of `setTimeout` or `setInterval`, or a hand-written repeat of the tick and
 * `Effect.sleep`: timers run on real time, which `TestClock` cannot drive, and a hand-written loop
 * tends to swallow a failed tick. Pass the tick to `pollForever`, and let a failure that the tick
 * does not handle end the worker.
 *
 * @construct worker
 */
export const pollForever = <A, E, R>(
  tick: Effect.Effect<A, E, R>,
  options: PollOptions<A>,
): Effect.Effect<never, E, R> => {
  const { skipDelay } = options;
  const spaced: Schedule.Schedule<number, A> = Schedule.spaced(options.interval);

  const schedule =
    skipDelay === undefined
      ? spaced
      : spaced.pipe(
          Schedule.modifyDelay(({ input, duration }) =>
            Effect.succeed(skipDelay(input) ? Duration.zero : duration),
          ),
        );

  // `Schedule.spaced` never completes, so only failure or interruption ends the repeat.
  return Effect.repeat(tick, schedule).pipe(Effect.andThen(Effect.never));
};
