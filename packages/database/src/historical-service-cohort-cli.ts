import { Config, Effect, Redacted } from "effect";

import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
  writeCohortReport,
} from "./cohort-cli.js";
import {
  decodeHistoricalServiceSnapshot,
  HistoricalServiceFailure,
  importHistoricalServiceCohort,
} from "./historical-service-cohort.js";
import { DatabaseLive } from "./layers.js";
import { NativeDatabaseStartupOptions } from "./search-path.js";
import { Database } from "./service.js";

const invalidSnapshot = () => new HistoricalServiceFailure({ code: "InvalidSnapshot" });

export const disposableHistoricalServiceDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/historical_service_[a-z0-9_]+$/, invalidSnapshot);

// An unset variable reads as empty, which no check below accepts.

const environment = Config.all({
  mode: Config.String("HISTORICAL_SERVICE_MODE").pipe(Config.withDefault("")),
  deployment: Config.String("NATIVE_IDENTITY_DEPLOYMENT").pipe(Config.withDefault("")),
  url: Config.String("HISTORICAL_SERVICE_PG_URL").pipe(Config.withDefault("")),
  input: Config.String("HISTORICAL_SERVICE_INPUT").pipe(Config.withDefault("")),
});

export const runHistoricalServiceCohortCli = Effect.gen(function* () {
  const env = yield* environment;

  if (
    process.argv.length !== 2 ||
    (env.mode !== "synthetic" && env.mode !== "legacy-backup") ||
    env.deployment !== "local"
  )
    return yield* invalidSnapshot();

  const url = yield* Effect.try({
    try: () => disposableHistoricalServiceDatabaseUrl(env.url),
    catch: invalidSnapshot,
  });

  const json = yield* readPrivateCohortJson(env.input, invalidSnapshot, 16_777_216);

  const input = yield* Effect.try({
    try: () => decodeHistoricalServiceSnapshot(json),
    catch: invalidSnapshot,
  });

  if ((env.mode === "synthetic") !== (input.sourceKind === "Synthetic"))
    return yield* invalidSnapshot();

  yield* Effect.gen(function* () {
    const sql = yield* Database;

    yield* sql.health;

    yield* writeCohortReport(yield* importHistoricalServiceCohort(sql, input));
  }).pipe(
    Effect.provide(
      DatabaseLive({
        url: Redacted.make(url),
        maxConnections: 2,
        startupOptions: NativeDatabaseStartupOptions,
      }),
    ),
  );
}).pipe(Effect.scoped);
