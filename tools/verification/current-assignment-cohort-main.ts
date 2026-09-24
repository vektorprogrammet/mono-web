import { runCurrentAssignmentCohortCli } from "./current-assignment-cohort-cli.js";
import { CurrentAssignmentFailure } from "@vektorprogrammet/placements/server";

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
