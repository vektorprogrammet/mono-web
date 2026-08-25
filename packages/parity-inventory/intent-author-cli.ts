import process from "node:process";
import { Effect } from "effect";
import { NodeRuntimeLayer } from "./node-runtime.js";
import { canonicalJson } from "./src/canonical.js";
import { authorAcceptedIntentRegister, parseIntentAuthorArgs } from "./src/intent-author.js";
import { ParityExecutionEnvironment, ParityTerminal } from "./src/services.js";

const program = Effect.gen(function* () {
  const environment = yield* ParityExecutionEnvironment;
  const terminal = yield* ParityTerminal;
  return yield* authorAcceptedIntentRegister(
    parseIntentAuthorArgs(environment.arguments.slice(2)),
  ).pipe(
    Effect.map((receipt) => {
      terminal.writeStandardOutput(canonicalJson(receipt));
      return 0;
    }),
    Effect.catchIf(
      (_error): _error is Error => true,
      (cause) =>
        Effect.sync(() => {
          terminal.writeStandardError(
            `${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          return 1;
        }),
    ),
  );
});

const exitCode = await Effect.runPromise(program.pipe(Effect.provide(NodeRuntimeLayer)));
process.exitCode = exitCode;
