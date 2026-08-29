import { Effect } from "effect";
import { program } from "../src/authorization-rules-postgres-proof-main.js";

void Effect.runPromise(Effect.scoped(program).pipe(Effect.timeout("90 seconds"))).catch(
  (cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  },
);
