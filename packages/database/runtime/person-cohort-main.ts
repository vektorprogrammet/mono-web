import { runPersonCohortCli } from "../src/person-cohort-cli.js";
import { PersonCohortFailure } from "../src/person-cohort.js";

try {
  await runPersonCohortCli();
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error: cause instanceof PersonCohortFailure ? cause.code : "PersonCohortImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
