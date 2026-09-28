import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Config, Console, Effect } from "effect";
import { exitWithReturnedCode } from "./exit-code.js";

// Legacy data rehearsals start MariaDB or the PHP CLI, which only the devenv `legacy-data`
// profile provides; it sets VEKTOR_LEGACY_DATA. The default shell has neither.
const program = Effect.gen(function* () {
  const legacyData = yield* Config.String("VEKTOR_LEGACY_DATA").pipe(Config.withDefault(""));

  if (legacyData === "1") return 0;

  yield* Console.error(
    "This command needs the legacy data tools (MariaDB, PHP CLI). " +
      "Run it inside `devenv --profile legacy-data shell`.",
  );

  return 1;
});

BunRuntime.runMain(program, exitWithReturnedCode);
