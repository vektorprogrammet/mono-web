import { Config, Console, Effect, Option, Redacted, Schema } from "effect";
import { Pool } from "pg";
import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
} from "@vektorprogrammet/database/cohort-cli";
import {
  CurrentAssignmentFailure,
  decodeCurrentAssignmentSnapshot,
  importCurrentAssignmentCohort,
} from "@vektorprogrammet/database/placements";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { databaseHealth } from "@vektorprogrammet/database";

const invalidSnapshot = () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" });

export const currentAssignmentForbiddenAmbientConfigurationKeys = [
  "DATABASE_URL",
  "BACKEND_PG_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "NATIVE_IDENTITY_TRUSTED_ORIGINS",
  "OAUTH_CANONICAL_ORIGIN",
  "OAUTH_DASHBOARD_ORIGIN",
  "OAUTH_NATIVE_API_RESOURCE",
  "OAUTH_INTERNAL_SOURCE_NETWORKS",
  "PUBLIC_APPLICATION_EFFECT_MODE",
  "PASSWORD_RESET_DELIVERY_MODE",
  "RECEIPT_DELIVERY_MODE",
  "MAIL_DELIVERY_URL",
  "MAIL_DELIVERY_TOKEN",
  "PUBLIC_APPLICATION_EFFECT_ENDPOINT",
  "PUBLIC_APPLICATION_EFFECT_TOKEN",
  "CONTACT_DELIVERY_URL",
  "CONTACT_DELIVERY_TOKEN",
  "ONBOARDING_DELIVERY_URL",
  "ONBOARDING_DELIVERY_TOKEN",
  "RECEIPT_DELIVERY_URL",
  "RECEIPT_DELIVERY_TOKEN",
  "PASSWORD_RESET_DELIVERY_URL",
  "PASSWORD_RESET_DELIVERY_TOKEN",
  "SLACK_ENDPOINT",
  "GATEWAY_API_TOKEN",
] as const;

export const disposableCurrentAssignmentDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/current_assignment_rehearsal$/, invalidSnapshot);

// A variable that the environment may set; an unreadable source counts as an invalid snapshot.
const optionalVariable = (key: string) =>
  Config.option(Config.String(key)).pipe(Effect.mapError(invalidSnapshot));

/** A failure of the CLI that carries no current assignment failure code. */
export class CurrentAssignmentImportFailed extends Schema.TaggedError<CurrentAssignmentImportFailed>()(
  "CurrentAssignmentImportFailed",
  { cause: Schema.Defect() },
) {}

// A synchronous step of the boundary keeps its coded failure; anything else is an import failure.
const boundaryStep = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof CurrentAssignmentFailure
        ? cause
        : CurrentAssignmentImportFailed.make({ cause }),
  });

/**
 * The guarded synthetic import: it takes the process arguments, reads its configuration from the
 * environment, and writes the persisted report to standard output.
 */
export const runCurrentAssignmentCohortCli = Effect.fn("runCurrentAssignmentCohortCli")(function* (
  argv: ReadonlyArray<string>,
) {
  const mode = yield* optionalVariable("CURRENT_ASSIGNMENT_MODE");
  const deployment = yield* optionalVariable("NATIVE_IDENTITY_DEPLOYMENT");

  if (
    argv.length !== 2 ||
    !Option.contains(mode, "synthetic") ||
    !Option.contains(deployment, "local")
  )
    return yield* invalidSnapshot();

  const ambient = yield* Effect.forEach(
    currentAssignmentForbiddenAmbientConfigurationKeys,
    optionalVariable,
  );

  if (ambient.some(Option.isSome)) return yield* invalidSnapshot();

  const inputPath = yield* optionalVariable("CURRENT_ASSIGNMENT_INPUT");

  const json = yield* readPrivateCohortJson(Option.getOrUndefined(inputPath), invalidSnapshot);
  const input = yield* boundaryStep(() => decodeCurrentAssignmentSnapshot(json));

  const databaseUrl = yield* optionalVariable("CURRENT_ASSIGNMENT_PG_URL");

  const url = yield* boundaryStep(() =>
    disposableCurrentAssignmentDatabaseUrl(Option.getOrUndefined(databaseUrl)),
  );

  yield* databaseHealth.pipe(
    Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
  );

  const report = yield* Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: url, max: 2 })),
    (pool) => importCurrentAssignmentCohort(pool, input),
    (pool) => Effect.promise(() => pool.end()),
  );

  const reportText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report).pipe(
    Effect.orDie,
  );

  yield* Console.log(reportText);
});
