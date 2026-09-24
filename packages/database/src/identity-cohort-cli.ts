import { createHash } from "node:crypto";
import { Pool } from "pg";
import { flow, Effect, Redacted } from "effect";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { parseDisposableCohortDatabaseUrl, readPrivateCohortJson } from "./cohort-cli.js";
import { databaseHealth } from "./service.js";
import { DatabaseLive } from "./layers.js";
import {
  decodeIdentityCohort,
  IdentityCohortFailure,
  importIdentityCohort,
  type CohortReport,
} from "./identity-cohort.js";

const invalidSnapshot = () => new IdentityCohortFailure("InvalidSnapshot");

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

export const runIdentityCohortCli = async () => {
  if (
    process.env.IDENTITY_COHORT_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw invalidSnapshot();
  const url = disposableCohortDatabaseUrl(process.env.IDENTITY_COHORT_PG_URL);

  const input = decodeSyntheticIdentityCohort(
    await readPrivateCohortJson(process.env.IDENTITY_COHORT_INPUT, invalidSnapshot),
  );

  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
    ),
  );
  const pool = new Pool({ connectionString: url, max: 2 });

  try {
    process.stdout.write(
      JSON.stringify(summarizeIdentityCohort(await importIdentityCohort(pool, input))) + "\n",
    );
  } finally {
    await pool.end();
  }
};
