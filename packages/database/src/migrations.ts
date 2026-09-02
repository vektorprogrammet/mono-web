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
const contentPublicationMigrationUrl = new URL(
  "../../domain/src/content/migrations/0001-content-publication.sql",
  import.meta.url,
);
const schoolsMigrationUrl = new URL(
  "../../domain/src/schools/migrations/0001-schools-directory.sql",
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
const profileSelfEditMigrationUrl = new URL(
  "../migrations/0014-native-profile-self-edit.sql",
  import.meta.url,
);
const nativeIdentityMigrationUrl = new URL(
  "../migrations/0015-native-identity-better-auth.sql",
  import.meta.url,
);
const personKeyedOrganizationAuthorityMigrationUrl = new URL(
  "../migrations/0016-person-keyed-organization-authority.sql",
  import.meta.url,
);
const organizationTeamInterestMigrationUrl = new URL(
  "../migrations/0018-organization-team-interest.sql",
  import.meta.url,
);
const personKeyedReceiptAuthorityMigrationUrl = new URL(
  "../migrations/0017-person-keyed-receipt-authority.sql",
  import.meta.url,
);
const nativeRecruitmentInterviewConductMigrationUrl = new URL(
  "../migrations/0021-native-recruitment-interview-conduct.sql",
  import.meta.url,
);
const nativeDomainSchemaBoundaryMigrationUrl = new URL(
  "../migrations/0022-native-domain-schema-boundary.sql",
  import.meta.url,
);
const declarativeAuthorizationRulesMigrationUrl = new URL(
  "../migrations/0023-declarative-authorization-rules.sql",
  import.meta.url,
);
const identitySecurityAuditMigrationUrl = new URL(
  "../migrations/0024-identity-security-audit.sql",
  import.meta.url,
);
const principalCredentialAccessAlgebraMigrationUrl = new URL(
  "../migrations/0025-principal-credential-access-algebra.sql",
  import.meta.url,
);
const declarativeRuleReconciliationMigrationUrl = new URL(
  "../migrations/0026-declarative-rule-reconciliation.sql",
  import.meta.url,
);
const nativeOAuthProviderMigrationUrl = new URL(
  "../migrations/0027-native-oauth-provider.sql",
  import.meta.url,
);
const servicePrincipalGrantsMigrationUrl = new URL(
  "../migrations/0028-service-principal-grants.sql",
  import.meta.url,
);
const nativeHttpSemanticsMigrationUrl = new URL(
  "../migrations/0029-native-http-semantics.sql",
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

export const databaseMigrationDefinitions = [
  { id: "1_receipt-authority", name: "receipt-authority", url: receiptMigrationUrl },
  {
    id: "2_admission-period-authority",
    name: "admission-period-authority",
    url: admissionPeriodMigrationUrl,
  },
  {
    id: "3_public-applicant-admission",
    name: "public-applicant-admission",
    url: publicApplicantMigrationUrl,
  },
  {
    id: "4_receipt-authority-upgrade-replay",
    name: "receipt-authority-upgrade-replay",
    url: receiptMigrationUrl,
  },
  {
    id: "5_public-applicant-effect-lifecycle",
    name: "public-applicant-effect-lifecycle",
    url: publicApplicantEffectLifecycleMigrationUrl,
  },
  {
    id: "6_public-applicant-delivered-payload-cleanup",
    name: "public-applicant-delivered-payload-cleanup",
    url: publicApplicantDeliveredPayloadCleanupMigrationUrl,
  },
  {
    id: "7_public-applicant-activation-snapshot",
    name: "public-applicant-activation-snapshot",
    url: publicApplicantActivationSnapshotMigrationUrl,
  },
  { id: "8_organization-authority", name: "organization-authority", url: organizationMigrationUrl },
  {
    id: "9_import-occurrence-authority",
    name: "import-occurrence-authority",
    url: importOccurrenceAuthorityMigrationUrl,
  },
  {
    id: "10_native-recruitment-applicant-assignment",
    name: "native-recruitment-applicant-assignment",
    url: recruitmentMigrationUrl,
  },
  {
    id: "11_native-recruitment-interview-scheduling",
    name: "native-recruitment-interview-scheduling",
    url: recruitmentSchedulingMigrationUrl,
  },
  {
    id: "12_native-recruitment-invitation-response",
    name: "native-recruitment-invitation-response",
    url: recruitmentInvitationResponseMigrationUrl,
  },
  {
    id: "13_native-organization-administration",
    name: "native-organization-administration",
    url: organizationAdministrationMigrationUrl,
  },
  {
    id: "14_native-profile-self-edit",
    name: "native-profile-self-edit",
    url: profileSelfEditMigrationUrl,
  },
  {
    id: "15_native-identity-better-auth",
    name: "native-identity-better-auth",
    url: nativeIdentityMigrationUrl,
  },
  {
    id: "16_person-keyed-organization-authority",
    name: "person-keyed-organization-authority",
    url: personKeyedOrganizationAuthorityMigrationUrl,
  },
  {
    id: "17_person-keyed-receipt-authority",
    name: "person-keyed-receipt-authority",
    url: personKeyedReceiptAuthorityMigrationUrl,
  },
  {
    id: "18_organization-team-interest",
    name: "organization-team-interest",
    url: organizationTeamInterestMigrationUrl,
  },
  { id: "19_schools-directory", name: "schools-directory", url: schoolsMigrationUrl },
  {
    id: "20_content-publication",
    name: "content-publication",
    url: contentPublicationMigrationUrl,
  },
  {
    id: "21_native-recruitment-interview-conduct",
    name: "native-recruitment-interview-conduct",
    url: nativeRecruitmentInterviewConductMigrationUrl,
  },
  {
    id: "22_native-domain-schema-boundary",
    name: "native-domain-schema-boundary",
    url: nativeDomainSchemaBoundaryMigrationUrl,
  },
  {
    id: "23_declarative-authorization-rules",
    name: "declarative-authorization-rules",
    url: declarativeAuthorizationRulesMigrationUrl,
  },
  {
    id: "24_identity-security-audit",
    name: "identity-security-audit",
    url: identitySecurityAuditMigrationUrl,
  },
  {
    id: "25_principal-credential-access-algebra",
    name: "principal-credential-access-algebra",
    url: principalCredentialAccessAlgebraMigrationUrl,
  },
  {
    id: "26_declarative-rule-reconciliation",
    name: "declarative-rule-reconciliation",
    url: declarativeRuleReconciliationMigrationUrl,
  },
  {
    id: "27_native-oauth-provider",
    name: "native-oauth-provider",
    url: nativeOAuthProviderMigrationUrl,
  },
  {
    id: "28_service-principal-grants",
    name: "service-principal-grants",
    url: servicePrincipalGrantsMigrationUrl,
  },
  {
    id: "29_native-http-semantics",
    name: "native-http-semantics",
    url: nativeHttpSemanticsMigrationUrl,
  },
] as const;

export const databaseMigrationLoader = (execute: ExecuteMigration) =>
  Migrator.fromRecord(
    Object.fromEntries(
      databaseMigrationDefinitions.map(({ id, name, url }) => [id, migration(name, url, execute)]),
    ),
  );
export const databaseSchemaRevision = "29_native_http_semantics";
export const runDatabaseMigrations = (execute: ExecuteMigration) =>
  Migrator.make({})({
    loader: databaseMigrationLoader(execute),
    table: "vektorprogrammet_schema_migrations",
  });
