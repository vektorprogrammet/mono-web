import { Effect } from "effect";
import { TestPlatform } from "../src/test-support/platform.js";
import { runPersonCohortCli } from "../src/person-cohort-cli.js";
import { PersonCohortFailure } from "../src/person-cohort.js";

try {
  await Effect.runPromise(runPersonCohortCli.pipe(Effect.provide(TestPlatform)));
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error: cause instanceof PersonCohortFailure ? cause.code : "PersonCohortImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
