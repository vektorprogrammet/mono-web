import { runHistoricalServiceCohortCli } from "../src/historical-service-cohort-cli.js";
import { HistoricalServiceFailure } from "../src/historical-service-cohort.js";

try {
  await runHistoricalServiceCohortCli();
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error:
        cause instanceof HistoricalServiceFailure ? cause.code : "HistoricalServiceImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
