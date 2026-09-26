import { Effect } from "effect";
import { TestPlatform } from "../src/test-support/platform.js";
import { runHistoricalServiceCohortCli } from "../src/historical-service-cohort-cli.js";
import { HistoricalServiceFailure } from "../src/historical-service-cohort.js";

try {
  await Effect.runPromise(runHistoricalServiceCohortCli.pipe(Effect.provide(TestPlatform)));
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error:
        cause instanceof HistoricalServiceFailure ? cause.code : "HistoricalServiceImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
