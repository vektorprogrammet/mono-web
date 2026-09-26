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
 * Runs `tick` at once, then again after each success. The delay uses the Clock
 * service, so `TestClock` controls it. The first tick failure stops the loop with
 * that failure. Interruption stops the current tick or delay.
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
