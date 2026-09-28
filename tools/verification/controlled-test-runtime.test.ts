import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { makeControlledTestRuntime } from "./controlled-test-runtime.js";

class RuntimeProbe extends Context.Service<RuntimeProbe, { readonly value: string }>()(
  "@monoweb/verification/controlled-test-runtime.test/RuntimeProbe",
) {}

describe("controlled test runtime lifecycle", () => {
  it.live("releases its layer once and rejects execution after disposal", () =>
    Effect.gen(function* () {
      let releases = 0;

      const layer = Layer.effect(
        RuntimeProbe,
        Effect.acquireRelease(Effect.succeed({ value: "ready" }), () =>
          Effect.sync(() => void (releases += 1)),
        ),
      );

      const runtime = makeControlledTestRuntime(layer);
      const probe = RuntimeProbe.use(({ value }) => Effect.succeed(value));

      expect(yield* Effect.promise(() => runtime.runPromise(probe))).toBe("ready");

      yield* Effect.promise(() => runtime.dispose());
      yield* Effect.promise(() => runtime.dispose());

      expect(releases).toBe(1);

      const afterDisposal = yield* Effect.flip(
        Effect.tryPromise({
          try: () => runtime.runPromise(probe),
          catch: (error) =>
            error instanceof Error ? error.message : "a rejection without an Error",
        }),
      );

      expect(afterDisposal).toBe("controlled test runtime is already disposed");
    }),
  );
});
