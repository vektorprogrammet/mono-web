import { Config, Effect, Redacted } from "effect";
import { Pool } from "pg";
import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
  writeCohortReport,
} from "./cohort-cli.js";
import { DatabaseLive } from "./layers.js";
import { decodePersonCohort, PersonCohortFailure, importPersonCohort } from "./person-cohort.js";
import { databaseHealth } from "./service.js";

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
  yield* databaseHealth.pipe(
    Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
  );

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url, max: 2 })),
    (pool) => Effect.promise(() => pool.end()),
  );

  yield* writeCohortReport(yield* importPersonCohort(pool, input));
}).pipe(Effect.scoped);
