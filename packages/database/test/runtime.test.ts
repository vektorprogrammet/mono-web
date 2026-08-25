import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlledTestRuntime } from "./runtime.js";

class RuntimeProbe extends Context.Service<RuntimeProbe, { readonly value: string }>()(
  "@vektorprogrammet/database/test/RuntimeProbe",
) {}

describe("controlled test runtime lifecycle", () => {
  it("releases its layer once and rejects execution after disposal", async () => {
    let releases = 0;
    const layer = Layer.effect(
      RuntimeProbe,
      Effect.acquireRelease(
        Effect.succeed({ value: "ready" }),
        () => Effect.sync(() => void (releases += 1)),
      ),
    );
    const runtime = makeControlledTestRuntime(layer);

    await expect(
      runtime.runPromise(RuntimeProbe.use(({ value }) => Effect.succeed(value))),
    ).resolves.toBe("ready");

    await runtime.dispose();
    await runtime.dispose();

    expect(releases).toBe(1);
    await expect(
      runtime.runPromise(RuntimeProbe.use(({ value }) => Effect.succeed(value))),
    ).rejects.toThrow("controlled test runtime is already disposed");
  });
});
