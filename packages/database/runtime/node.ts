import { Effect, Layer, ManagedRuntime } from "effect";

const runtime = ManagedRuntime.make(Layer.empty);

export const runDatabaseEffect = <A, E>(program: Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(program);

export const runDatabaseMain = <A, E>(program: Effect.Effect<A, E>): void => {
  void runtime.runPromise(program).catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  });
};
