import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Config, flow, Effect, Redacted } from "effect";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
  writeCohortReport,
} from "./cohort-cli.js";
import { databaseHealth } from "./service.js";
import { DatabaseLive } from "./layers.js";
import {
  decodeIdentityCohort,
  IdentityCohortFailure,
  importIdentityCohort,
  type CohortReport,
} from "./identity-cohort.js";

const invalidSnapshot = () => new IdentityCohortFailure({ code: "InvalidSnapshot" });

export const decodeSyntheticIdentityCohort = flow(decodeIdentityCohort, (snapshot) => {
  if (snapshot.sourceKind !== "Synthetic" || snapshot.passwordlessPolicy !== "Quarantine")
    throw invalidSnapshot();

  return snapshot;
});

export const summarizeIdentityCohort = (report: CohortReport) => {
  const reasons: Record<string, number> = {};

  for (const occurrence of report.occurrences)
    reasons[occurrence.reason] = (reasons[occurrence.reason] ?? 0) + 1;

  return {
    input: report.input,
    accepted: report.accepted,
    quarantined: report.quarantined,
    reasons,
    dispositionFingerprint: createHash("sha256")
      .update(canonicalJson(report.occurrences))
      .digest("hex"),
  };
};

export const disposableCohortDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/identity_cohort_[a-z0-9_]+$/, invalidSnapshot);

// An unset variable reads as empty, which no check below accepts.
const environment = Config.all({
  mode: Config.String("IDENTITY_COHORT_MODE").pipe(Config.withDefault("")),
  deployment: Config.String("NATIVE_IDENTITY_DEPLOYMENT").pipe(Config.withDefault("")),
  url: Config.String("IDENTITY_COHORT_PG_URL").pipe(Config.withDefault("")),
  input: Config.String("IDENTITY_COHORT_INPUT").pipe(Config.withDefault("")),
});

export const runIdentityCohortCli = Effect.gen(function* () {
  const env = yield* environment;

  if (process.argv.length !== 2 || env.mode !== "synthetic" || env.deployment !== "local")
    return yield* invalidSnapshot();

  const url = yield* Effect.try({
    try: () => disposableCohortDatabaseUrl(env.url),
    catch: invalidSnapshot,
  });

  const json = yield* readPrivateCohortJson(env.input, invalidSnapshot);

  const input = yield* Effect.try({
    try: () => decodeSyntheticIdentityCohort(json),
    catch: invalidSnapshot,
  });

  yield* databaseHealth.pipe(
    Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
  );

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url, max: 2 })),
    (pool) => Effect.promise(() => pool.end()),
  );

  yield* writeCohortReport(summarizeIdentityCohort(yield* importIdentityCohort(pool, input)));
}).pipe(Effect.scoped);
