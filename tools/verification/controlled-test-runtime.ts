import { Effect, Layer, ManagedRuntime } from "effect";

export interface ControlledTestRuntime<R> {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export const makeControlledTestRuntime = <R, ER>(
  layer: Layer.Layer<R, ER>,
): ControlledTestRuntime<R> => {
  const runtime = ManagedRuntime.make(layer);
  let disposed = false;

  return {
    runPromise: (effect, options) => {
      if (disposed) {
        return Promise.reject(new Error("controlled test runtime is already disposed"));
      }

      return runtime.runPromise(effect, options);
    },
    dispose: () => {
      if (disposed) return Promise.resolve();
      disposed = true;

      return runtime.dispose();
    },
  };
};
