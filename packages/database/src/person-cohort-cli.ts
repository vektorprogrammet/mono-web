import { Config, Effect, Redacted } from "effect";
import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
  writeCohortReport,
} from "./cohort-cli.js";
import { DatabaseLive } from "./layers.js";
import { NativeDatabaseStartupOptions } from "./search-path.js";
import { decodePersonCohort, PersonCohortFailure, importPersonCohort } from "./person-cohort.js";
import { Database } from "./service.js";

const invalidSnapshot = () => new PersonCohortFailure({ code: "InvalidSnapshot" });

export const disposablePersonCohortDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/person_cohort_[a-z0-9_]+$/, invalidSnapshot);

// An unset variable reads as empty, which no check below accepts.
const environment = Config.all({
  mode: Config.String("PERSON_COHORT_MODE").pipe(Config.withDefault("")),
  deployment: Config.String("NATIVE_IDENTITY_DEPLOYMENT").pipe(Config.withDefault("")),
  url: Config.String("PERSON_COHORT_PG_URL").pipe(Config.withDefault("")),
  input: Config.String("PERSON_COHORT_INPUT").pipe(Config.withDefault("")),
});

export const runPersonCohortCli = Effect.gen(function* () {
  const env = yield* environment;

  if (process.argv.length !== 2 || env.mode !== "synthetic" || env.deployment !== "local")
    return yield* invalidSnapshot();

  const url = yield* Effect.try({
    try: () => disposablePersonCohortDatabaseUrl(env.url),
    catch: invalidSnapshot,
  });

  const json = yield* readPrivateCohortJson(env.input, invalidSnapshot);
  const input = yield* Effect.try({ try: () => decodePersonCohort(json), catch: invalidSnapshot });

  if (input.sourceKind !== "Synthetic") return yield* invalidSnapshot();
  yield* Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql.health;
    yield* writeCohortReport(yield* importPersonCohort(sql, input));
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
