import process from "node:process";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, ConfigProvider, Console, Effect, Layer } from "effect";
import { CurrentAssignmentFailure } from "@vektorprogrammet/database/placements";
import { runCurrentAssignmentCohortCli } from "./current-assignment-cohort-cli.js";

const failureCode = (failure: ReturnType<typeof Cause.squash>) =>
  failure instanceof CurrentAssignmentFailure ? failure.code : "CurrentAssignmentImportFailed";

// An empty variable counts as set, so an empty provider variable is still refused.
const environment = ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));

// A failure writes one JSON line with its code to standard error, and the runtime exits 1.
BunRuntime.runMain(
  runCurrentAssignmentCohortCli(process.argv).pipe(
    Effect.tapCause((cause) =>
      Console.error(JSON.stringify({ error: failureCode(Cause.squash(cause)) })),
    ),
    Effect.provide(Layer.merge(BunServices.layer, environment)),
  ),
  { disableErrorReporting: true },
);
