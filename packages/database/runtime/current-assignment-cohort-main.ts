import { runCurrentAssignmentCohortCli } from "../src/current-assignment-cohort-cli.js";
import { CurrentAssignmentFailure } from "../src/current-assignment-cohort.js";

try {
  await runCurrentAssignmentCohortCli();
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error:
        cause instanceof CurrentAssignmentFailure ? cause.code : "CurrentAssignmentImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
