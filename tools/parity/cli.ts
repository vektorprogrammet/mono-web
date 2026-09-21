import process from "node:process";
import { Effect } from "effect";
import { NodeRuntimeLayer } from "./node-runtime.js";
import { main } from "./src/main.js";
import { generateFromRootsEffect, type RunOptions } from "./src/runner.js";
import { ParityExecutionEnvironment, ParityTerminal } from "./src/services.js";
import type { ApiRuntimeFixtureInput } from "./src/types.js";

interface FreshReplayInput {
  readonly options: RunOptions;
  readonly fixtureRuntimeInput: {
    readonly path: string;
    readonly bytes: readonly number[];
  } | null;
  readonly fixtureIntentBytes: readonly number[] | null;
}

const INTERNAL_FRESH_REPLAY = "--internal-fresh-replay";

const program = Effect.gen(function* () {
  const environment = yield* ParityExecutionEnvironment;
  const args = environment.arguments.slice(2);
  if (args[0] !== INTERNAL_FRESH_REPLAY) return yield* main(args);
  const serialized = args[1];
  if (serialized === undefined) throw new Error(`${INTERNAL_FRESH_REPLAY} requires an input`);
  const input = JSON.parse(serialized) as FreshReplayInput;
  const fixtureRuntimeInput: ApiRuntimeFixtureInput | undefined =
    input.fixtureRuntimeInput === null
      ? undefined
      : {
          path: input.fixtureRuntimeInput.path,
          bytes: Uint8Array.from(input.fixtureRuntimeInput.bytes),
        };
  const fixtureIntentBytes =
    input.fixtureIntentBytes === null ? undefined : Uint8Array.from(input.fixtureIntentBytes);
  const generated = yield* generateFromRootsEffect(
    input.options,
    fixtureRuntimeInput,
    fixtureIntentBytes,
  );
  const terminal = yield* ParityTerminal;
  const orderedBytes = Object.fromEntries(
    Object.entries(generated.bytes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  yield* Effect.sync(() => terminal.writeStandardOutput(JSON.stringify(orderedBytes)));
  return 0;
});

const exitCode = await Effect.runPromise(program.pipe(Effect.provide(NodeRuntimeLayer)));
process.exitCode = exitCode;
