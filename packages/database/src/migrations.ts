import { readFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

export class DatabaseMigrationReadError extends Data.TaggedError("DatabaseMigrationReadError")<{
  readonly migration: string;
  readonly cause: unknown;
}> {}

export class DatabaseMigrationExecutionError extends Data.TaggedError(
  "DatabaseMigrationExecutionError",
)<{
  readonly cause: unknown;
}> {}

const receiptMigrationUrl = new URL(
  "../../domain/src/receipt/migrations/0001-receipt-authority.sql",
  import.meta.url,
);
const admissionPeriodMigrationUrl = new URL(
  "../../domain/src/admission-period/migrations/0001-admission-period-authority.sql",
  import.meta.url,
);
const publicApplicantMigrationUrl = new URL(
  "../../domain/src/application/migrations/0002-public-applicant-admission.sql",
  import.meta.url,
);
const publicApplicantEffectLifecycleMigrationUrl = new URL(
  "../../domain/src/application/migrations/0003-public-applicant-effect-lifecycle.sql",
  import.meta.url,
);

export type ExecuteMigration = (
  source: string,
) => Effect.Effect<void, unknown, SqlClient.SqlClient>;

const migration = (name: string, url: URL, execute: ExecuteMigration) =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => readFile(url, "utf8"),
      catch: (cause) => new DatabaseMigrationReadError({ migration: name, cause }),
    });
    yield* execute(source);
  });

export const databaseMigrationLoader = (execute: ExecuteMigration) =>
  Migrator.fromRecord({
    "1_receipt-authority": migration("receipt-authority", receiptMigrationUrl, execute),
    "2_admission-period-authority": migration(
      "admission-period-authority",
      admissionPeriodMigrationUrl,
      execute,
    ),
    "3_public-applicant-admission": migration(
      "public-applicant-admission",
      publicApplicantMigrationUrl,
      execute,
    ),
    "4_receipt-authority-upgrade-replay": migration(
      "receipt-authority-upgrade-replay",
      receiptMigrationUrl,
      execute,
    ),
    "5_public-applicant-effect-lifecycle": migration(
      "public-applicant-effect-lifecycle",
      publicApplicantEffectLifecycleMigrationUrl,
      execute,
    ),
  });

export const databaseSchemaRevision = "5_public-applicant-effect-lifecycle";

export const runDatabaseMigrations = (execute: ExecuteMigration) =>
  Migrator.make({})({
    loader: databaseMigrationLoader(execute),
    table: "vektorprogrammet_schema_migrations",
  });
