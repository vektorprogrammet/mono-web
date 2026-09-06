import { runIdentityCohortCli } from "../src/identity-cohort-cli.js";
import { IdentityCohortFailure } from "../src/identity-cohort.js";
try {
  await runIdentityCohortCli();
} catch (cause) {
  process.stderr.write(
    JSON.stringify({
      error: cause instanceof IdentityCohortFailure ? cause.code : "CohortImportFailed",
    }) + "\n",
  );
  process.exitCode = 1;
}
