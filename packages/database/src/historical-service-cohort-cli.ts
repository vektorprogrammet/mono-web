import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { parseDisposableCohortDatabaseUrl, readPrivateCohortJson } from "./cohort-cli.js";
import {
  HistoricalServiceFailure,
  importHistoricalServiceCohort,
} from "./historical-service-cohort.js";
import { DatabaseLive } from "./layers.js";
import { databaseHealth } from "./service.js";

const invalidSnapshot = () => new HistoricalServiceFailure("InvalidSnapshot");

export const disposableHistoricalServiceDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/historical_service_[a-z0-9_]+$/, invalidSnapshot);

export const runHistoricalServiceCohortCli = async (): Promise<void> => {
  if (
    process.env.HISTORICAL_SERVICE_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw invalidSnapshot();
  const url = disposableHistoricalServiceDatabaseUrl(process.env.HISTORICAL_SERVICE_PG_URL);
  const input = await readPrivateCohortJson(process.env.HISTORICAL_SERVICE_INPUT, invalidSnapshot);
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
    ),
  );
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    process.stdout.write(JSON.stringify(await importHistoricalServiceCohort(pool, input)) + "\n");
  } finally {
    await pool.end();
  }
};
