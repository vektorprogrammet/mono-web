import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { parseDisposableCohortDatabaseUrl, readPrivateCohortJson } from "./cohort-cli.js";
import { DatabaseLive } from "./layers.js";
import { decodePersonCohort, PersonCohortFailure, importPersonCohort } from "./person-cohort.js";
import { databaseHealth } from "./service.js";

const invalidSnapshot = () => new PersonCohortFailure("InvalidSnapshot");

export const disposablePersonCohortDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/person_cohort_[a-z0-9_]+$/, invalidSnapshot);

export const runPersonCohortCli = async (): Promise<void> => {
  if (
    process.env.PERSON_COHORT_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw invalidSnapshot();
  const url = disposablePersonCohortDatabaseUrl(process.env.PERSON_COHORT_PG_URL);

  const input = decodePersonCohort(
    await readPrivateCohortJson(process.env.PERSON_COHORT_INPUT, invalidSnapshot),
  );

  if (input.sourceKind !== "Synthetic") throw invalidSnapshot();
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
    ),
  );
  const pool = new Pool({ connectionString: url, max: 2 });

  try {
    process.stdout.write(JSON.stringify(await importPersonCohort(pool, input)) + "\n");
  } finally {
    await pool.end();
  }
};
