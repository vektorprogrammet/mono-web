import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Pool } from "pg";
import { Effect, Redacted } from "effect";
import { databaseHealth } from "./service.js";
import { DatabaseLive } from "./layers.js";
import { IdentityCohortFailure, importIdentityCohort } from "./identity-cohort.js";

export const disposableCohortDatabaseUrl = (value: string | undefined): string => {
  try {
    const url = new URL(value!);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      !/^\/identity_cohort_[a-z0-9_]+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new IdentityCohortFailure("InvalidSnapshot");
  }
};
export const runIdentityCohortCli = async () => {
  if (
    process.env.IDENTITY_COHORT_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw new IdentityCohortFailure("InvalidSnapshot");
  const url = disposableCohortDatabaseUrl(process.env.IDENTITY_COHORT_PG_URL);
  const path = process.env.IDENTITY_COHORT_INPUT;
  if (!path || process.argv.length !== 2) throw new IdentityCohortFailure("InvalidSnapshot");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 1_048_576 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new IdentityCohortFailure("InvalidSnapshot");
    input = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
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
