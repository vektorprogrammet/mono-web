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
const publicApplicantDeliveredPayloadCleanupMigrationUrl = new URL(
  "../../domain/src/application/migrations/0004-public-applicant-delivered-payload-cleanup.sql",
  import.meta.url,
);
const publicApplicantActivationSnapshotMigrationUrl = new URL(
  "../../domain/src/application/migrations/0005-public-applicant-activation-snapshot.sql",
  import.meta.url,
);
const organizationMigrationUrl = new URL(
  "../../domain/src/organization/migrations/0001-organization-authority.sql",
  import.meta.url,
);
const importOccurrenceAuthorityMigrationUrl = new URL(
  "../migrations/0009-import-occurrence-authority.sql",
  import.meta.url,
);
const recruitmentMigrationUrl = new URL(
  "../migrations/0010-native-recruitment-applicant-assignment.sql",
  import.meta.url,
);
const recruitmentSchedulingMigrationUrl = new URL(
  "../migrations/0011-native-recruitment-interview-scheduling.sql",
  import.meta.url,
);
const recruitmentInvitationResponseMigrationUrl = new URL(
  "../migrations/0012-native-recruitment-invitation-response.sql",
  import.meta.url,
);
const organizationAdministrationMigrationUrl = new URL(
  "../migrations/0013-native-organization-administration.sql",
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
    "6_public-applicant-delivered-payload-cleanup": migration(
      "public-applicant-delivered-payload-cleanup",
      publicApplicantDeliveredPayloadCleanupMigrationUrl,
      execute,
    ),
    "7_public-applicant-activation-snapshot": migration(
      "public-applicant-activation-snapshot",
      publicApplicantActivationSnapshotMigrationUrl,
      execute,
    ),
    "8_organization-authority": migration(
      "organization-authority",
      organizationMigrationUrl,
      execute,
    ),
    "9_import-occurrence-authority": migration(
      "import-occurrence-authority",
      importOccurrenceAuthorityMigrationUrl,
      execute,
    ),
    "10_native-recruitment-applicant-assignment": migration(
      "native-recruitment-applicant-assignment",
      recruitmentMigrationUrl,
      execute,
    ),
    "11_native-recruitment-interview-scheduling": migration(
      "native-recruitment-interview-scheduling",
      recruitmentSchedulingMigrationUrl,
      execute,
    ),
    "12_native-recruitment-invitation-response": migration(
      "native-recruitment-invitation-response",
      recruitmentInvitationResponseMigrationUrl,
      execute,
    ),
    "13_native-organization-administration": migration(
      "native-organization-administration",
      organizationAdministrationMigrationUrl,
      execute,
    ),
  });

export const databaseSchemaRevision = "13_native-organization-administration";
export const runDatabaseMigrations = (execute: ExecuteMigration) =>
  Migrator.make({})({
    loader: databaseMigrationLoader(execute),
    table: "vektorprogrammet_schema_migrations",
  });
