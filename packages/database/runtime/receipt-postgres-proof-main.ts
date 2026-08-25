import { Effect } from "effect";
import { program } from "../src/receipt-postgres-proof-main.js";

void Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
