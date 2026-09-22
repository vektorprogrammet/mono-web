import { Pool } from "pg";
import { Effect, Redacted } from "effect";
import { parseDisposableCohortDatabaseUrl, readPrivateCohortJson } from "./cohort-cli.js";
import { databaseHealth } from "./service.js";
import { DatabaseLive } from "./layers.js";
import { IdentityCohortFailure, importIdentityCohort } from "./identity-cohort.js";

const invalidSnapshot = () => new IdentityCohortFailure("InvalidSnapshot");

export const disposableCohortDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/identity_cohort_[a-z0-9_]+$/, invalidSnapshot);
export const runIdentityCohortCli = async () => {
  if (
    process.env.IDENTITY_COHORT_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw invalidSnapshot();
  const url = disposableCohortDatabaseUrl(process.env.IDENTITY_COHORT_PG_URL);
  const input = await readPrivateCohortJson(process.env.IDENTITY_COHORT_INPUT, invalidSnapshot);
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
    ),
  );
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    process.stdout.write(JSON.stringify(await importIdentityCohort(pool, input)) + "\n");
  } finally {
    await pool.end();
  }
};
