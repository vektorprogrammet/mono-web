import { Effect } from "effect";
import { ruleReconciliationTracerProgram } from "../src/rule-reconciliation-postgres-tracer-main.js";
import { TestPlatform } from "../src/test-support/platform.js";
import { withDisposablePostgres } from "@monoweb/postgres";

void withDisposablePostgres("rule_reconciliation_proof", (databaseUrl) =>
  Effect.runPromise(
    Effect.scoped(ruleReconciliationTracerProgram(databaseUrl)).pipe(
      Effect.timeout("90 seconds"),
      Effect.provide(TestPlatform),
    ),
  ),
)
  .then(() => process.stderr.write("Disposable PostgreSQL topology cleaned.\n"))
  .catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  });
