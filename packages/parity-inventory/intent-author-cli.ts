import { Effect } from "effect";
import { canonicalJson } from "./src/canonical.js";
import { authorAcceptedIntentRegister, parseIntentAuthorArgs } from "./src/intent-author.js";
import { nodeRuntime } from "./node-runtime.js";

Effect.runPromise(
  authorAcceptedIntentRegister(parseIntentAuthorArgs(nodeRuntime.process.argv.slice(2))),
)
  .then((receipt) => nodeRuntime.process.stdout.write(canonicalJson(receipt)))
  .catch((cause: unknown) => {
    nodeRuntime.process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    nodeRuntime.process.setExitCode(1);
  });
