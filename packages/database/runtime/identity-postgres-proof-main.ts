import { Effect } from "effect";
import { program } from "../src/identity-postgres-proof-main.js";

void Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
