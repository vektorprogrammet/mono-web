import process from "node:process";
import { Effect } from "effect";
import { NodeRuntimeLayer } from "./node-runtime.js";
import { canonicalJson } from "./src/canonical.js";
import {
  AcceptedIntentAuthorError,
  authorAcceptedIntentRegister,
  parseIntentAuthorArgs,
} from "./src/intent-author.js";
import { ParityExecutionEnvironment, ParityTerminal } from "./src/services.js";

const program = Effect.gen(function* () {
  const environment = yield* ParityExecutionEnvironment;
  const terminal = yield* ParityTerminal;

  const authoring = Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseIntentAuthorArgs(environment.arguments.slice(2)),
      catch: (cause) =>
        cause instanceof AcceptedIntentAuthorError
          ? cause
          : new AcceptedIntentAuthorError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

    const receipt = yield* authorAcceptedIntentRegister(options);
    yield* Effect.sync(() => terminal.writeStandardOutput(canonicalJson(receipt)));

    return 0;
  });

  return yield* authoring.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        terminal.writeStandardError(`${error.message}\n`);

        return 1;
      }),
    ),
  );
});

const exitCode = await Effect.runPromise(program.pipe(Effect.provide(NodeRuntimeLayer)));

process.exitCode = exitCode;
