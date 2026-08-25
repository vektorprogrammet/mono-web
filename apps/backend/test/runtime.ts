import { Effect } from "effect";

/** Executes fully provided Effects at the backend test boundary. */
export const runTestPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** Starts a fully provided Effect whose lifecycle is owned by its test. */
export const forkTestEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect);
