import assert from "node:assert/strict";
import {
  AuthorityVersion,
  AUTHZ_LOCK_PROTOCOL,
  AuthzRuleId,
  AuthzTagAssignmentId,
  AuthzTagId,
  composeCapabilityEvidence,
  createAuthzRule,
  createAuthzTagAssignment,
  endAuthzRule,
  endAuthzTagAssignment,
  loadApplicableAuthorizationRules,
  persistDisposableAuthzBackfill,
  RECEIPT_DOMAIN_ID,
  RECEIPT_RESOURCE_KIND,
  ResourceId,
  removeAuthzRule,
  type DisposableAuthzBackfillPlan,
} from "@vektorprogrammet/domain/authz";
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodId,
  decideAdmissionPeriod,
} from "@vektorprogrammet/domain/admission-period";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  DepartmentId,
  OrganizationGlobalAdministratorGrantId,
  OrganizationLive,
  PersonId,
  SemesterId,
  authorizeOrganizationActor,
  createOrganizationGlobalAdministratorGrant,
  endOrganizationGlobalAdministratorGrant,
  mapOrganizationAuthorityToAdmissionPeriodActor,
  mapOrganizationAuthorityToOrganizationActor,
  mapOrganizationAuthorityToProfileRole,
  mapOrganizationAuthorityToRecruitmentActor,
  removeOrganizationGlobalAdministratorGrant,
} from "@vektorprogrammet/domain/organization";
import {
  ReceiptApprovalGrantId,
  ReceiptId,
  ReceiptPaymentAuthorityId,
  ReceiptVisualId,
  createReceiptApprovalGrant,
  createReceiptPaymentAuthority,
  mapReceiptApprovalActor,
  mapReceiptSubmissionPrincipal,
  projectReceiptAuthority,
  removeReceiptApprovalGrant,
  removeReceiptPaymentAuthority,
  resolveReceiptAuthorityForRead,
  type ReceiptFile,
} from "@vektorprogrammet/domain/receipt";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import { Recruitment, RecruitmentLive } from "@vektorprogrammet/domain/recruitment";
import { Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { makeSpec0055OrganizationAuthorityFixtures } from "../../domain/src/organization/authority-fixtures.test-support.js";
import { resolveOrganizationPersonAuthorityForRead } from "../../domain/src/organization/authority-postgres.js";
import { executeReceiptCommand } from "../../domain/src/receipt/postgres.js";
import { DatabaseLive } from "./layers.js";
import { databaseMigrationDefinitions, databaseSchemaRevision } from "./migrations.js";
import { proveRuleReconciliationMigration } from "./rule-reconciliation-migration-postgres-proof.js";
import {
  reversedDisposableAuthzBackfillInput,
  validDisposableAuthzBackfillInput,
} from "./test-support/disposable-authz-backfill-fixtures.js";

const implementationBaseRevision = "f83d18ae408ad2c1e954d344620802a7ad1bda42";
const proofApplicationPrefix = "authorization-rules-proof-0056";
const activeStart = "2037-01-01T00:00:00.000Z";
const inactiveEnd = "2037-06-01T00:00:00.000Z";
const exactEnd = "2037-06-15T12:00:00.000Z";
const justBeforeExactEnd = "2037-06-15T11:59:59.999Z";

const ids = {
  departments: {
    alpha: "authz-0056-proof-department-alpha",
    beta: "authz-0056-proof-department-beta",
  },
  teams: {
    alpha: "authz-0056-proof-team-alpha",
    beta: "authz-0056-proof-team-beta",
  },
  persons: {
    ruleSubmit: "authz-0056-proof-person-rule-submit",
    ruleApprove: "authz-0056-proof-person-rule-approve",
    tagApprove: "authz-0056-proof-person-tag-approve",
    direct: "authz-0056-proof-person-direct",
    crossDepartment: "authz-0056-proof-person-cross-department",
    endedRule: "authz-0056-proof-person-ended-rule",
    endedDirect: "authz-0056-proof-person-ended-direct",
    matrixAdministrator: "authz-0056-proof-person-matrix-administrator",
    matrixLeader: "authz-0056-proof-person-matrix-leader",
    matrixInactiveLeader: "authz-0056-proof-person-matrix-inactive-leader",
    matrixMember: "authz-0056-proof-person-matrix-member",
    matrixAbsent: "authz-0056-proof-person-matrix-absent",
    expiryCommandFirst: "authz-0056-proof-person-expiry-command-first",
    expiryWriterFirst: "authz-0056-proof-person-expiry-writer-first",
    phantomEconomy: "authz-0056-proof-person-phantom-economy",
    phantomOrganization: "authz-0056-proof-person-phantom-organization",
  },
  directAuthorities: {
    inactiveRuleSubmit: "authz-0056-proof-payment-inactive-rule-submit",
    inactiveRuleApprove: "authz-0056-proof-approval-inactive-rule-approve",
    directPayment: "authz-0056-proof-payment-direct",
    endedDirectPayment: "authz-0056-proof-payment-ended-direct",
    matrixAdministratorGrant: "authz-0056-proof-administrator-matrix",
    phantomEconomyPayment: "authz-0056-proof-payment-phantom-economy",
    phantomOrganizationAdministrator: "authz-0056-proof-admin-phantom-organization",
    phantomOrganizationApproval: "authz-0056-proof-approval-phantom-organization",
  },
  tag: "authz-0056-proof-tag-approvers",
  assignment: "authz-0056-proof-assignment-approver",
  domainBoundaries: {
    admissionDecisionPeriod: "authz-0056-proof-admission-decision-period",
    recruitmentSemester: "authz-0056-proof-recruitment-semester",
    recruitmentAdmissionPeriod: "authz-0056-proof-recruitment-period",
    recruitmentFieldOfStudy: "authz-0056-proof-recruitment-field",
    recruitmentApplicant: "authz-0056-proof-recruitment-applicant",
    recruitmentApplication: "authz-0056-proof-recruitment-application",
    recruitmentInterviewSchema: "authz-0056-proof-recruitment-schema",
  },
  retryAssignment: "authz-0056-proof-assignment-approver-retry",
  rules: {
    submit: "authz-0056-proof-rule-submit",
    approve: "authz-0056-proof-rule-approve",
    tagApprove: "authz-0056-proof-rule-tag-approve",
    endedApprove: "authz-0056-proof-rule-ended-approve",
    crossDepartment: "authz-0056-proof-rule-cross-department",
    expiryCommandFirst: "authz-0056-proof-rule-expiry-command-first",
    expiryWriterFirst: "authz-0056-proof-rule-expiry-writer-first",
  },
  receipts: {
    approveLock: "authz-0056-proof-receipt-approve-lock",
    tagAccepted: "authz-0056-proof-receipt-tag-accepted",
    tagWriterFirst: "authz-0056-proof-receipt-tag-writer-first",
    endedRule: "authz-0056-proof-receipt-ended-rule",
    phantomOrganizationInsert: "authz-0056-proof-receipt-phantom-organization-insert",
    phantomOrganizationRemove: "authz-0056-proof-receipt-phantom-organization-remove",
    phantomOrganizationFresh: "authz-0056-proof-receipt-phantom-organization-fresh",
  },
  commands: {
    directSubmit: "authz-0056-proof-command-direct-submit",
    admissionMatrixCreate: "authz-0056-proof-command-admission-matrix-create",
    recruitmentAdmissionPeriodSeed: "authz-0056-proof-command-recruitment-admission-period-seed",
    endedDirectSubmit: "authz-0056-proof-command-ended-direct-submit",
    matrixReceiptRejected: "authz-0056-proof-command-matrix-receipt-rejected",
    crossDepartmentSubmit: "authz-0056-proof-command-cross-department-submit",
    endedRuleApprove: "authz-0056-proof-command-ended-rule-approve",
    approveLock: "authz-0056-proof-command-approve-lock",
    ruleSubmit: "authz-0056-proof-command-rule-submit",
    ruleSubmitFresh: "authz-0056-proof-command-rule-submit-fresh",
    tagAccepted: "authz-0056-proof-command-tag-accepted",
    tagWriterFirst: "authz-0056-proof-command-tag-writer-first",
    expiryCommandFirst: "authz-0056-proof-command-expiry-command-first",
    expiryCommandFirstFresh: "authz-0056-proof-command-expiry-command-first-fresh",
    expiryWriterFirst: "authz-0056-proof-command-expiry-writer-first",
    phantomEconomyInsert: "authz-0056-proof-command-phantom-economy-insert",
    phantomEconomyEnd: "authz-0056-proof-command-phantom-economy-end",
    phantomEconomyExactEnd: "authz-0056-proof-command-phantom-economy-exact-end",
    phantomEconomyRemoved: "authz-0056-proof-command-phantom-economy-removed",
    phantomOrganizationInsert: "authz-0056-proof-command-phantom-organization-insert",
    phantomOrganizationRemove: "authz-0056-proof-command-phantom-organization-remove",
    phantomOrganizationFresh: "authz-0056-proof-command-phantom-organization-fresh",
  },
} as const;

const generatedReceiptIds = {
  direct: "authz-0056-proof-receipt-direct-submit",
  endedDirect: "authz-0056-proof-receipt-ended-direct-submit",
  crossDepartment: "authz-0056-proof-receipt-cross-department-submit",
  ruleSubmit: "authz-0056-proof-receipt-rule-submit",
  ruleSubmitFresh: "authz-0056-proof-receipt-rule-submit-fresh",
  matrixReceiptRejected: "authz-0056-proof-receipt-matrix-rejected",
  expiryCommandFirst: "authz-0056-proof-receipt-expiry-command-first",
  expiryCommandFirstFresh: "authz-0056-proof-receipt-expiry-command-first-fresh",
  expiryWriterFirst: "authz-0056-proof-receipt-expiry-writer-first",
  phantomEconomyInsert: "authz-0056-proof-receipt-phantom-economy-insert",
  phantomEconomyEnd: "authz-0056-proof-receipt-phantom-economy-end",
  phantomEconomyExactEnd: "authz-0056-proof-receipt-phantom-economy-exact-end",
  phantomEconomyRemoved: "authz-0056-proof-receipt-phantom-economy-removed",
} as const;

const generatedVisualIds = {
  direct: "AUTHZ-0056-DIRECT",
  endedDirect: "AUTHZ-0056-ENDED-DIRECT",
  crossDepartment: "AUTHZ-0056-CROSS",
  ruleSubmit: "AUTHZ-0056-RULE-SUBMIT",
  ruleSubmitFresh: "AUTHZ-0056-RULE-SUBMIT-FRESH",
  matrixReceiptRejected: "AUTHZ-0056-MATRIX-REJECTED",
  expiryCommandFirst: "AUTHZ-0056-EXPIRY-COMMAND-FIRST",
  expiryCommandFirstFresh: "AUTHZ-0056-EXPIRY-COMMAND-FIRST-FRESH",
  expiryWriterFirst: "AUTHZ-0056-EXPIRY-WRITER-FIRST",
  phantomEconomyInsert: "AUTHZ-0056-PHANTOM-ECONOMY-INSERT",
  phantomEconomyEnd: "AUTHZ-0056-PHANTOM-ECONOMY-END",
  phantomEconomyExactEnd: "AUTHZ-0056-PHANTOM-ECONOMY-EXACT-END",
  phantomEconomyRemoved: "AUTHZ-0056-PHANTOM-ECONOMY-REMOVED",
} as const;

const personId = (value: string) => PersonId.make(value);
const departmentId = (value: string) => DepartmentId.make(value);

const proofReceiptContext = (department: DepartmentId) => ({
  domainId: RECEIPT_DOMAIN_ID,
  departmentId: department,
  resource: {
    kind: RECEIPT_RESOURCE_KIND,
    id: ResourceId.make("authz-0056-proof-context-receipt"),
  },
  facts: {
    ownerPersonId: personId(ids.persons.direct),
    state: "Pending",
    approverPersonIds: [personId(ids.persons.ruleApprove)],
    internalEvidenceEnabled: false,
  },
  authorityVersion: AuthorityVersion.make("authz-0056-proof-context-v1"),
});

const file = (suffix: string): ReceiptFile => ({
  fileRef: `authz-0056-proof-file-${suffix}`,
  objectKey: `temporary/authz-0056-proof-file-${suffix}`,
  contentType: "application/pdf",
  byteLength: 256,
  sha256: "a".repeat(64),
});

const submitCommand = (commandId: string, department: string, fileSuffix: string) => ({
  _tag: "SubmitReceipt" as const,
  commandId,
  departmentId: departmentId(department),
  description: "Authorization rule PostgreSQL proof",
  amountOre: 12_345,
  receiptDate: "2037-06-15",
  file: file(fileSuffix),
});

const allocation = (receiptId: string, visualId: string) => ({
  receiptId: ReceiptId.make(receiptId),
  visualId: ReceiptVisualId.make(visualId),
});

const principal = (person: string, authorizationInstant: string) => ({
  personId: personId(person),
  authorizationInstant,
});

const makeProofLayer = (url: Redacted.Redacted<string>, applicationName: string) =>
  DatabaseLive({
    url: Redacted.make(Redacted.value(url)),
    applicationName,
    maxConnections: 1,
  });

const makeZeroRuleProofLayer = (url: Redacted.Redacted<string>, applicationName: string) => {
  const databaseLayer = makeProofLayer(url, applicationName);
  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );
  const supportLayer = Layer.mergeAll(
    databaseLayer,
    admissionsLayer,
    organizationLayer,
    profileLayer,
  );
  return Layer.merge(supportLayer, RecruitmentLive.pipe(Layer.provide(supportLayer)));
};

const assertDisposablePostgres = (url: Redacted.Redacted<string>): void => {
  const parsed = new URL(Redacted.value(url));
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname));
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /proof|test/u);
};

const resetDatabaseObjects = (sql: DatabaseShape) =>
  sql
    .unsafe(`
    DO $$
    DECLARE extension_name text;
    BEGIN
      FOR extension_name IN
        SELECT extname FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
      LOOP
        EXECUTE format('DROP EXTENSION IF EXISTS %I CASCADE', extension_name);
      END LOOP;
    END $$;
    DO $$
    DECLARE schema_name text;
    BEGIN
      FOR schema_name IN
        SELECT nspname
        FROM pg_catalog.pg_namespace
        WHERE nspname NOT LIKE 'pg_%'
          AND nspname <> 'information_schema'
          AND nspname <> 'public'
      LOOP
        EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
      END LOOP;
    END $$;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `)
    .pipe(Effect.asVoid);

const seedDatabase = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO public.person_profiles (person_id, first_name, last_name)
        VALUES
          (${ids.persons.ruleSubmit}, 'Rule', 'Submit'),
          (${ids.persons.ruleApprove}, 'Rule', 'Approve'),
          (${ids.persons.tagApprove}, 'Tag', 'Approve'),
          (${ids.persons.direct}, 'Direct', 'Authority'),
          (${ids.persons.crossDepartment}, 'Cross', 'Department'),
          (${ids.persons.endedRule}, 'Ended', 'Rule'),
          (${ids.persons.endedDirect}, 'Ended', 'Direct'),
          (${ids.persons.matrixAdministrator}, 'Matrix', 'Administrator'),
          (${ids.persons.matrixLeader}, 'Matrix', 'Leader'),
          (${ids.persons.matrixInactiveLeader}, 'Matrix', 'Inactive Leader'),
          (${ids.persons.matrixMember}, 'Matrix', 'Member'),
          (${ids.persons.matrixAbsent}, 'Matrix', 'Absent'),
          (${ids.persons.expiryCommandFirst}, 'Expiry', 'Command First'),
          (${ids.persons.expiryWriterFirst}, 'Expiry', 'Writer First'),
          (${ids.persons.phantomEconomy}, 'Phantom', 'Economy'),
          (${ids.persons.phantomOrganization}, 'Phantom', 'Organization'),
          ('authz-backfill-person-a', 'Backfill', 'Author A'),
          ('authz-backfill-person-b', 'Backfill', 'Author B')
      `;
      yield* sql`
        INSERT INTO public.organization_departments (
          department_id, name, short_name, email, city
        ) VALUES
          (
            ${ids.departments.alpha}, 'Authorization proof Alpha', 'A56A',
            'authz-0056-alpha@example.invalid', 'Bergen'
          ),
          (
            ${ids.departments.beta}, 'Authorization proof Beta', 'A56B',
            'authz-0056-beta@example.invalid', 'Trondheim'
          ),
          (
            'authz-backfill-department', 'Authorization backfill fixture', 'A56F',
            'authz-0056-backfill@example.invalid', 'Oslo'
          )
      `;
      yield* sql`
        INSERT INTO public.organization_teams (team_id, department_id, name)
        VALUES
          (${ids.teams.alpha}, ${ids.departments.alpha}, 'Authorization proof Alpha team'),
          (${ids.teams.beta}, ${ids.departments.beta}, 'Authorization proof Beta team')
      `;
      yield* sql`
        INSERT INTO public.organization_memberships (
          membership_id, person_id, team_id, start_at, end_at, position_id, is_team_leader
        ) VALUES
          ('authz-0056-proof-membership-rule-submit', ${ids.persons.ruleSubmit}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-rule-approve', ${ids.persons.ruleApprove}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-tag-approve', ${ids.persons.tagApprove}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-direct', ${ids.persons.direct}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-cross-alpha', ${ids.persons.crossDepartment}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-cross-beta', ${ids.persons.crossDepartment}, ${ids.teams.beta}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-ended-rule', ${ids.persons.endedRule}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-ended-direct', ${ids.persons.endedDirect}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-matrix-leader', ${ids.persons.matrixLeader}, ${ids.teams.alpha}, ${activeStart}, NULL, 'leader', TRUE),
          ('authz-0056-proof-membership-matrix-inactive-leader', ${ids.persons.matrixInactiveLeader}, ${ids.teams.alpha}, ${activeStart}, ${exactEnd}, 'leader', TRUE),
          ('authz-0056-proof-membership-matrix-member', ${ids.persons.matrixMember}, ${ids.teams.alpha}, ${activeStart}, NULL, 'member', FALSE),
          ('authz-0056-proof-membership-expiry-command-first', ${ids.persons.expiryCommandFirst}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-expiry-writer-first', ${ids.persons.expiryWriterFirst}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE),
          ('authz-0056-proof-membership-phantom-economy', ${ids.persons.phantomEconomy}, ${ids.teams.alpha}, ${activeStart}, NULL, NULL, FALSE)
      `;
      yield* sql`
        INSERT INTO public.admission_period_departments (department_id, name)
        VALUES (${ids.departments.alpha}, 'Authorization proof Alpha')
      `;
      yield* sql`
        INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
        VALUES (
          ${ids.domainBoundaries.recruitmentSemester},
          '2037-01-01T00:00:00.000Z',
          '2038-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO public.admission_periods (
          admission_period_id, department_id, semester_id,
          start_at, end_at, last_command_id
        ) VALUES (
          ${ids.domainBoundaries.recruitmentAdmissionPeriod},
          ${ids.departments.alpha},
          ${ids.domainBoundaries.recruitmentSemester},
          '2037-06-01T00:00:00.000Z',
          '2037-07-01T00:00:00.000Z',
          ${ids.commands.recruitmentAdmissionPeriodSeed}
        )
      `;
      yield* sql`
        INSERT INTO public.admission_period_fields_of_study (
          field_of_study_id, department_id, name
        ) VALUES (
          ${ids.domainBoundaries.recruitmentFieldOfStudy},
          ${ids.departments.alpha},
          'Authorization proof studies'
        )
      `;
      yield* sql`
        INSERT INTO public.admission_applicants (
          applicant_id, normalized_email, email, first_name, last_name,
          phone, gender, field_of_study_id, year_of_study
        ) VALUES (
          ${ids.domainBoundaries.recruitmentApplicant},
          'authz-0056-proof-recruitment-candidate@example.invalid',
          'authz-0056-proof-recruitment-candidate@example.invalid',
          'Rita',
          'Candidate',
          '90000056',
          0,
          ${ids.domainBoundaries.recruitmentFieldOfStudy},
          1
        )
      `;
      yield* sql`
        INSERT INTO public.admission_applications (
          application_id, applicant_id, admission_period_id,
          department_id, field_of_study_id, year_of_study, submitted_at
        ) VALUES (
          ${ids.domainBoundaries.recruitmentApplication},
          ${ids.domainBoundaries.recruitmentApplicant},
          ${ids.domainBoundaries.recruitmentAdmissionPeriod},
          ${ids.departments.alpha},
          ${ids.domainBoundaries.recruitmentFieldOfStudy},
          1,
          '2037-06-10T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO public.recruitment_interview_schemas (
          interview_schema_id, name, question_count
        ) VALUES (
          ${ids.domainBoundaries.recruitmentInterviewSchema},
          'Authorization proof interview',
          0
        )
      `;
      yield* sql`
        INSERT INTO public.organization_global_administrator_grants (
          grant_id, person_id, start_at, end_at, revision
        ) VALUES (
          ${ids.directAuthorities.matrixAdministratorGrant},
          ${ids.persons.matrixAdministrator},
          ${activeStart},
          NULL,
          0
        )
      `;
      yield* sql`
        INSERT INTO public.economy_payment_authorities (
          payment_authority_id, person_id, department_id,
          payment_account_ciphertext, start_at, end_at
        ) VALUES
          (
            ${ids.directAuthorities.inactiveRuleSubmit}, ${ids.persons.ruleSubmit},
            ${ids.departments.alpha}, 'ciphertext:proof:inactive-rule-submit',
            ${activeStart}, ${inactiveEnd}
          ),
          (
            ${ids.directAuthorities.directPayment}, ${ids.persons.direct},
            ${ids.departments.alpha}, 'ciphertext:proof:direct', ${activeStart}, NULL
          ),
          (
            ${ids.directAuthorities.endedDirectPayment}, ${ids.persons.endedDirect},
            ${ids.departments.alpha}, 'ciphertext:proof:ended-direct',
            ${activeStart}, ${exactEnd}
          )
      `;
      yield* sql`
        INSERT INTO public.economy_receipt_approval_grants (
          approval_grant_id, person_id, scope, department_id, start_at, end_at
        ) VALUES (
          ${ids.directAuthorities.inactiveRuleApprove}, ${ids.persons.ruleApprove},
          'Department', ${ids.departments.alpha}, ${activeStart}, ${inactiveEnd}
        )
      `;
      yield* sql`
        INSERT INTO public.authz_tags (tag_id, name, revision)
        VALUES (${ids.tag}, 'Authorization proof approvers', 0)
      `;
      yield* sql`
        INSERT INTO public.authz_tag_assignments (
          assignment_id, tag_id, person_id, start_at, end_at, revision
        ) VALUES (
          ${ids.assignment}, ${ids.tag}, ${ids.persons.tagApprove}, ${activeStart}, NULL, 0
        )
      `;
      yield* sql`
        INSERT INTO public.authz_rules (
          rule_id, capability_id, effect_kind, subject_kind,
          subject_person_id, subject_tag_id, scope, department_id,
          params, start_at, end_at, revision
        ) VALUES
          (
            ${ids.rules.submit}, 'submitReceipt', 'delegate', 'Person',
            ${ids.persons.ruleSubmit}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({
              slot: "EconomyPaymentAuthority",
              paymentAccountCiphertext: "ciphertext:proof:rule-submit",
            })},
            ${activeStart}, NULL, 0
          ),
          (
            ${ids.rules.approve}, 'approveReceipt', 'delegate', 'Person',
            ${ids.persons.ruleApprove}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({ slot: "EconomyDepartmentApprovalGrant" })},
            ${activeStart}, NULL, 0
          ),
          (
            ${ids.rules.tagApprove}, 'approveReceipt', 'delegate', 'Tag',
            NULL, ${ids.tag}, 'Department', ${ids.departments.alpha},
            ${sql.json({ slot: "EconomyDepartmentApprovalGrant" })},
            ${activeStart}, NULL, 0
          ),
          (
            ${ids.rules.endedApprove}, 'approveReceipt', 'delegate', 'Person',
            ${ids.persons.endedRule}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({ slot: "EconomyDepartmentApprovalGrant" })},
            ${activeStart}, ${exactEnd}, 0
          ),
          (
            ${ids.rules.crossDepartment}, 'submitReceipt', 'delegate', 'Person',
            ${ids.persons.crossDepartment}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({
              slot: "EconomyPaymentAuthority",
              paymentAccountCiphertext: "ciphertext:proof:cross-department",
            })},
            ${activeStart}, NULL, 0
          ),
          (
            ${ids.rules.expiryCommandFirst}, 'submitReceipt', 'delegate', 'Person',
            ${ids.persons.expiryCommandFirst}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({
              slot: "EconomyPaymentAuthority",
              paymentAccountCiphertext: "ciphertext:proof:expiry-command-first",
            })},
            ${activeStart}, NULL, 0
          ),
          (
            ${ids.rules.expiryWriterFirst}, 'submitReceipt', 'delegate', 'Person',
            ${ids.persons.expiryWriterFirst}, NULL, 'Department', ${ids.departments.alpha},
            ${sql.json({
              slot: "EconomyPaymentAuthority",
              paymentAccountCiphertext: "ciphertext:proof:expiry-writer-first",
            })},
            ${activeStart}, NULL, 0
          )
      `;
      yield* sql`
        INSERT INTO public.economy_receipts (
          receipt_id, visual_id, owner_person_id, department_id,
          amount_ore, currency, description, receipt_date, submitted_at,
          status, refund_date, payment_account_ciphertext,
          file_ref, file_object_key, file_content_type, file_byte_length,
          file_sha256, revision
        ) VALUES
          (
            ${ids.receipts.approveLock}, 'AUTHZ-0056-APPROVE-LOCK', ${ids.persons.direct},
            ${ids.departments.alpha}, 1000, 'NOK', 'Approval lock proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-approve-lock',
            'stored/authz-0056-proof-seed-file-approve-lock', 'application/pdf', 128,
            ${"b".repeat(64)}, 0
          ),
          (
            ${ids.receipts.tagAccepted}, 'AUTHZ-0056-TAG-ACCEPTED', ${ids.persons.direct},
            ${ids.departments.alpha}, 1100, 'NOK', 'Tag accepted proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-tag-accepted',
            'stored/authz-0056-proof-seed-file-tag-accepted', 'application/pdf', 128,
            ${"c".repeat(64)}, 0
          ),
          (
            ${ids.receipts.tagWriterFirst}, 'AUTHZ-0056-TAG-WRITER-FIRST', ${ids.persons.direct},
            ${ids.departments.alpha}, 1200, 'NOK', 'Tag writer first proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-tag-writer-first',
            'stored/authz-0056-proof-seed-file-tag-writer-first', 'application/pdf', 128,
            ${"d".repeat(64)}, 0
          ),
          (
            ${ids.receipts.endedRule}, 'AUTHZ-0056-ENDED-RULE', ${ids.persons.direct},
            ${ids.departments.alpha}, 1300, 'NOK', 'Ended rule proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-ended-rule',
            'stored/authz-0056-proof-seed-file-ended-rule', 'application/pdf', 128,
            ${"e".repeat(64)}, 0
          ),
          (
            ${ids.receipts.phantomOrganizationInsert}, 'AUTHZ-0056-PHANTOM-ORG-INSERT',
            ${ids.persons.phantomOrganization}, ${ids.departments.alpha},
            1400, 'NOK', 'Organization phantom insert proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-phantom-org-insert',
            'stored/authz-0056-proof-seed-file-phantom-org-insert', 'application/pdf', 128,
            ${"f".repeat(64)}, 0
          ),
          (
            ${ids.receipts.phantomOrganizationRemove}, 'AUTHZ-0056-PHANTOM-ORG-REMOVE',
            ${ids.persons.phantomOrganization}, ${ids.departments.alpha},
            1500, 'NOK', 'Organization phantom removal proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-phantom-org-remove',
            'stored/authz-0056-proof-seed-file-phantom-org-remove', 'application/pdf', 128,
            ${"1".repeat(64)}, 0
          ),
          (
            ${ids.receipts.phantomOrganizationFresh}, 'AUTHZ-0056-PHANTOM-ORG-FRESH',
            ${ids.persons.phantomOrganization}, ${ids.departments.alpha},
            1600, 'NOK', 'Organization phantom fresh denial proof', '2037-06-14',
            ${activeStart}, 'Pending', NULL, 'ciphertext:proof:seed',
            'authz-0056-proof-seed-file-phantom-org-fresh',
            'stored/authz-0056-proof-seed-file-phantom-org-fresh', 'application/pdf', 128,
            ${"2".repeat(64)}, 0
          )
      `;
    }),
  );

interface MigrationRow {
  readonly migration_id: number;
  readonly name: string;
}

interface SeedRecord {
  readonly kind: string;
  readonly id: string;
}

const readSeedRecords = (sql: DatabaseShape) =>
  sql<SeedRecord>`
    SELECT seed.kind, seed.id
    FROM (
      SELECT 'Person'::text AS kind, person_id AS id
      FROM public.person_profiles
      WHERE person_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'Department', department_id
      FROM public.organization_departments
      WHERE department_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'DirectOrganizationAuthority', grant_id
      FROM public.organization_global_administrator_grants
      WHERE grant_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'DirectPaymentAuthority', payment_authority_id
      FROM public.economy_payment_authorities
      WHERE payment_authority_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'DirectApprovalAuthority', approval_grant_id
      FROM public.economy_receipt_approval_grants
      WHERE approval_grant_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'Receipt', receipt_id
      FROM public.economy_receipts
      WHERE receipt_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'Tag', tag_id
      FROM public.authz_tags
      WHERE tag_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'TagAssignment', assignment_id
      FROM public.authz_tag_assignments
      WHERE assignment_id LIKE 'authz-0056-proof-%'
      UNION ALL
      SELECT 'Rule', rule_id
      FROM public.authz_rules
      WHERE rule_id LIKE 'authz-0056-proof-%'
    ) AS seed
    ORDER BY seed.kind ASC, seed.id ASC
  `;

const replayCanonicalMigrationsAndSeed = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* resetDatabaseObjects(sql);
    yield* sql.migrate;
    const firstReplay = yield* sql<MigrationRow>`
      SELECT migration_id, name
      FROM public.vektorprogrammet_schema_migrations
      ORDER BY migration_id ASC
    `;
    yield* sql.migrate;
    const idempotentReplay = yield* sql<MigrationRow>`
      SELECT migration_id, name
      FROM public.vektorprogrammet_schema_migrations
      ORDER BY migration_id ASC
    `;
    const [server] = yield* sql<{ readonly serverVersionNum: number }>`
      SELECT current_setting('server_version_num')::integer AS "serverVersionNum"
    `;
    assert.deepEqual(firstReplay, idempotentReplay);
    assert.equal(firstReplay.length, databaseMigrationDefinitions.length);
    assert.deepEqual(
      firstReplay.map((row) => `${row.migration_id}_${row.name}`),
      databaseMigrationDefinitions.map((migration) => migration.id),
    );
    assert.equal(sql.schemaRevision, databaseSchemaRevision);
    assert(server);
    yield* seedDatabase(sql);
    const seedRecords = yield* readSeedRecords(sql);
    return {
      serverVersionNum: server.serverVersionNum,
      migrationRows: firstReplay,
      idempotentReplayRows: idempotentReplay,
      seedRecords,
    };
  }).pipe(Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-migration`)));

interface DurableCommandFacts {
  readonly commandReceiptRows: number;
  readonly auditRows: number;
  readonly outboxRows: number;
  readonly outboxCommandRows: number;
}

const readDurableCommandFacts = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<DurableCommandFacts, unknown> =>
  Effect.gen(function* () {
    const [row] = yield* sql<DurableCommandFacts>`
      SELECT
        (
          SELECT count(*)::integer
          FROM public.economy_receipt_command_receipts
          WHERE command_id = ${commandId}
        ) AS "commandReceiptRows",
        (
          SELECT count(*)::integer
          FROM public.economy_receipt_audit
          WHERE command_id = ${commandId}
        ) AS "auditRows",
        (
          SELECT count(*)::integer
          FROM public.economy_receipt_outbox
          WHERE command_id = ${commandId}
        ) AS "outboxRows",
        (
          SELECT count(DISTINCT command_id)::integer
          FROM public.economy_receipt_outbox
          WHERE command_id = ${commandId}
        ) AS "outboxCommandRows"
    `;
    assert(row);
    return row;
  });

interface AuthzRowCounts {
  readonly tags: number;
  readonly assignments: number;
  readonly rules: number;
}

const readAuthzRowCounts = (sql: DatabaseShape): Effect.Effect<AuthzRowCounts, unknown> =>
  Effect.gen(function* () {
    const [counts] = yield* sql<AuthzRowCounts>`
      SELECT
        (SELECT count(*)::integer FROM public.authz_tags) AS tags,
        (SELECT count(*)::integer FROM public.authz_tag_assignments) AS assignments,
        (SELECT count(*)::integer FROM public.authz_rules) AS rules
    `;
    assert(counts);
    return counts;
  });

const backfillPlanEvidence = (plan: DisposableAuthzBackfillPlan) => {
  const bytes = canonicalJsonBytes(plan);
  return {
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    tagIds: plan.tags.map((tag) => tag.tagId),
    assignmentIds: plan.assignments.map((assignment) => assignment.assignmentId),
    ruleIds: plan.rulesBySubject.flatMap((group) => group.rules.map((rule) => rule.ruleId)),
  };
};

const failureTag = (failure: unknown): string =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  typeof failure._tag === "string"
    ? failure._tag
    : "UnknownFailure";

const resultFailureTag = (result: { readonly _tag: string; readonly failure?: unknown }): string =>
  result._tag === "Failure" ? failureTag(result.failure) : "Success";

type SqlPhase =
  | "command-receipt-lock"
  | "receipt-target-lock"
  | "person-authorization-lock"
  | "organization-authority-projection"
  | "direct-receipt-authority-projection"
  | "authz-shared-lock"
  | "authz-exclusive-lock"
  | "authz-tag-assignment-projection"
  | "authz-rule-projection"
  | "direct-authority-update"
  | "direct-payment-insert"
  | "direct-payment-end"
  | "direct-payment-remove"
  | "direct-approval-insert"
  | "direct-approval-remove"
  | "organization-administrator-insert"
  | "organization-administrator-end"
  | "organization-administrator-remove"
  | "end-rule"
  | "remove-rule"
  | "end-tag-assignment"
  | "durable-audit-insert";

interface SqlTrace {
  readonly attempted: Array<SqlPhase>;
  readonly completed: Array<SqlPhase>;
}

const makeSqlTrace = (): SqlTrace => ({ attempted: [], completed: [] });

const classifySql = (text: string, values: ReadonlyArray<unknown>): SqlPhase | undefined => {
  if (text.includes("pg_advisory_xact_lock_shared")) return "authz-shared-lock";
  if (
    text.includes("pg_advisory_xact_lock") &&
    values.some((value) => value === AUTHZ_LOCK_PROTOCOL.advisoryKey)
  ) {
    return "authz-exclusive-lock";
  }
  if (
    text.includes("pg_advisory_xact_lock") &&
    values.some((value) => typeof value === "string" && value.startsWith("receipt-command:"))
  ) {
    return "command-receipt-lock";
  }
  if (
    text.includes("pg_advisory_xact_lock") &&
    values.some(
      (value) =>
        typeof value === "string" && value.startsWith("vektorprogrammet:person-authorization:v1:"),
    )
  ) {
    return "person-authorization-lock";
  }
  if (text.includes("FROM economy_receipts") && text.includes("FOR UPDATE")) {
    return "receipt-target-lock";
  }
  if (text.includes("WITH locked_global_administrator_grants AS MATERIALIZED")) {
    return "organization-authority-projection";
  }
  if (text.includes("WITH locked_payment_authorities AS MATERIALIZED")) {
    return "direct-receipt-authority-projection";
  }
  if (
    text.includes("FROM public.authz_tag_assignments") &&
    text.includes("ORDER BY tag_id ASC, assignment_id ASC")
  ) {
    return "authz-tag-assignment-projection";
  }
  if (text.includes("FROM public.authz_rules AS rule")) return "authz-rule-projection";
  if (text.includes("INSERT INTO public.economy_payment_authorities")) {
    return "direct-payment-insert";
  }
  if (text.includes("UPDATE public.economy_payment_authorities")) return "direct-payment-end";
  if (text.includes("DELETE FROM public.economy_payment_authorities")) {
    return "direct-payment-remove";
  }
  if (text.includes("INSERT INTO public.economy_receipt_approval_grants")) {
    return "direct-approval-insert";
  }
  if (text.includes("DELETE FROM public.economy_receipt_approval_grants")) {
    return "direct-approval-remove";
  }
  if (text.includes("INSERT INTO public.organization_global_administrator_grants")) {
    return "organization-administrator-insert";
  }
  if (text.includes("UPDATE public.organization_global_administrator_grants")) {
    return "organization-administrator-end";
  }
  if (text.includes("DELETE FROM public.organization_global_administrator_grants")) {
    return "organization-administrator-remove";
  }
  if (text.includes("UPDATE public.economy_receipt_approval_grants")) {
    return "direct-authority-update";
  }
  if (text.includes("UPDATE public.authz_rules")) return "end-rule";
  if (text.includes("DELETE FROM public.authz_rules")) return "remove-rule";
  if (text.includes("UPDATE public.authz_tag_assignments")) return "end-tag-assignment";
  if (text.includes("INSERT INTO economy_receipt_audit")) return "durable-audit-insert";
  return undefined;
};

interface ObserveSqlOptions {
  readonly signalBefore?: {
    readonly phase: SqlPhase;
    readonly deferred: Deferred.Deferred<void>;
  };
  readonly pauseAfter?: {
    readonly phase: SqlPhase;
    readonly ready: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

const observeSql = (
  sql: DatabaseShape,
  trace: SqlTrace,
  options: ObserveSqlOptions = {},
): DatabaseShape =>
  new Proxy(sql, {
    apply(target, thisArgument, argumentsList) {
      const statement = Reflect.apply(target, thisArgument, argumentsList) as Effect.Effect<
        ReadonlyArray<unknown>,
        unknown
      >;
      const strings = argumentsList[0] as TemplateStringsArray;
      const values = argumentsList.slice(1) as ReadonlyArray<unknown>;
      const phase = classifySql(strings.join("?"), values);
      if (phase === undefined) return statement;
      let observed = Effect.sync(() => trace.attempted.push(phase)).pipe(
        Effect.andThen(
          options.signalBefore?.phase === phase
            ? Deferred.succeed(options.signalBefore.deferred, undefined)
            : Effect.void,
        ),
        Effect.andThen(statement),
        Effect.tap(() => Effect.sync(() => trace.completed.push(phase))),
      );
      if (options.pauseAfter?.phase === phase) {
        observed = observed.pipe(
          Effect.tap(() =>
            Deferred.succeed(options.pauseAfter!.ready, undefined).pipe(
              Effect.andThen(Deferred.await(options.pauseAfter!.resume)),
            ),
          ),
        );
      }
      return observed;
    },
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseShape;

const assertSubsequence = (
  actual: ReadonlyArray<SqlPhase>,
  expected: ReadonlyArray<SqlPhase>,
): void => {
  let expectedIndex = 0;
  for (const phase of actual) {
    if (phase === expected[expectedIndex]) expectedIndex += 1;
  }
  assert.equal(expectedIndex, expected.length);
};

interface ConnectionStamp {
  readonly pid: number;
  readonly observedAt: string;
}

const connectionStamp = (sql: DatabaseShape): Effect.Effect<ConnectionStamp, unknown> =>
  Effect.gen(function* () {
    const [stamp] = yield* sql<ConnectionStamp>`
      SELECT
        pg_backend_pid() AS pid,
        to_char(
          clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "observedAt"
    `;
    assert(stamp);
    return stamp;
  });

interface BlockingRow {
  readonly pid: number;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly blockingPidsText: string | null;
  readonly observedAt: string;
}

const parseBlockingPids = (value: string | null): ReadonlyArray<number> =>
  value === null || value === "" ? [] : value.split(",").map((entry) => Number.parseInt(entry, 10));

const awaitBlockedBy = (
  sql: DatabaseShape,
  blockedPid: number,
  blockerPid: number,
  remainingQueries = 256,
): Effect.Effect<BlockingRow, unknown> =>
  Effect.gen(function* () {
    const [row] = yield* sql<BlockingRow>`
      SELECT
        activity.pid,
        activity.wait_event_type AS "waitEventType",
        activity.wait_event AS "waitEvent",
        array_to_string(pg_catalog.pg_blocking_pids(activity.pid), ',') AS "blockingPidsText",
        to_char(
          clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "observedAt"
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.pid = ${blockedPid}
    `;
    if (row !== undefined && parseBlockingPids(row.blockingPidsText).includes(blockerPid)) {
      return row;
    }
    if (remainingQueries <= 0) {
      return yield* Effect.fail(
        new Error(`PostgreSQL did not report backend ${blockedPid} blocked by ${blockerPid}`),
      );
    }
    return yield* awaitBlockedBy(sql, blockedPid, blockerPid, remainingQueries - 1);
  });

interface RelationLockRow {
  readonly pid: number;
  readonly relation: string | null;
  readonly mode: string;
  readonly granted: boolean;
}

interface SemanticAdvisoryLockRow {
  readonly pid: number;
  readonly keyName: string;
  readonly mode: string;
  readonly granted: boolean;
}

const observeBlockingAndLocks = (input: {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly blockedPid: number;
  readonly blockerPid: number;
  readonly personId: string;
  readonly commandId: string;
  readonly applicationName: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const blocked = yield* awaitBlockedBy(sql, input.blockedPid, input.blockerPid);
    const relationLocks = yield* sql<RelationLockRow>`
      SELECT
        lock.pid,
        CASE
          WHEN relation.oid IS NULL THEN NULL
          ELSE namespace.nspname || '.' || relation.relname
        END AS relation,
        lock.mode,
        lock.granted
      FROM pg_catalog.pg_locks AS lock
      LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = lock.relation
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE lock.pid IN (${input.blockedPid}, ${input.blockerPid})
        AND relation.relname IN (
          'organization_memberships',
          'organization_teams',
          'organization_departments',
          'organization_global_administrator_grants',
          'economy_payment_authorities',
          'economy_receipt_approval_grants',
          'authz_tag_assignments',
          'authz_rules'
        )
      ORDER BY lock.pid ASC, relation ASC, lock.mode ASC, lock.granted DESC
    `;
    const advisoryLocks = yield* sql<SemanticAdvisoryLockRow>`
      WITH semantic_key (key_name, key_value) AS (
        VALUES
          (
            'command-receipt'::text,
            pg_catalog.hashtextextended(${`receipt-command:${input.commandId}`}, 0)
          ),
          (
            'person-authorization'::text,
            pg_catalog.hashtextextended(
              ${`vektorprogrammet:person-authorization:v1:${input.personId}`}, 0
            )
          ),
          (
            'authorization-rules'::text,
            pg_catalog.hashtextextended(${AUTHZ_LOCK_PROTOCOL.advisoryKey}, 0)
          )
      )
      SELECT
        lock.pid,
        semantic_key.key_name AS "keyName",
        lock.mode,
        lock.granted
      FROM pg_catalog.pg_locks AS lock
      INNER JOIN semantic_key
        ON lock.locktype = 'advisory'
        AND lock.objsubid = 1
        AND lock.classid::bigint = ((semantic_key.key_value >> 32) & 4294967295)
        AND lock.objid::bigint = (semantic_key.key_value & 4294967295)
      WHERE lock.pid IN (${input.blockedPid}, ${input.blockerPid})
      ORDER BY lock.pid ASC, semantic_key.key_name ASC, lock.mode ASC, lock.granted DESC
    `;
    return {
      blocked: {
        pid: blocked.pid,
        blockingPids: parseBlockingPids(blocked.blockingPidsText),
        waitEventType: blocked.waitEventType,
        waitEvent: blocked.waitEvent,
        observedAt: blocked.observedAt,
      },
      relationLocks,
      advisoryLocks,
    };
  }).pipe(Effect.provide(makeProofLayer(input.databaseUrl, input.applicationName)));

const hasRelationLock = (
  locks: ReadonlyArray<RelationLockRow>,
  pid: number,
  relation: string,
  mode: string,
): boolean =>
  locks.some(
    (lock) => lock.pid === pid && lock.relation === relation && lock.mode === mode && lock.granted,
  );

const hasAdvisoryLock = (
  locks: ReadonlyArray<SemanticAdvisoryLockRow>,
  pid: number,
  keyName: string,
  mode: string,
  granted: boolean,
): boolean =>
  locks.some(
    (lock) =>
      lock.pid === pid &&
      lock.keyName === keyName &&
      lock.mode === mode &&
      lock.granted === granted,
  );

const submissionCompositionFacts = (
  person: string,
  authorizationInstant: string,
  department: string,
) =>
  Effect.gen(function* () {
    const subject = personId(person);
    const departmentScope = departmentId(department);
    const organization = yield* resolveOrganizationPersonAuthorityForRead(
      subject,
      authorizationInstant,
    );
    const direct = yield* resolveReceiptAuthorityForRead(
      subject,
      authorizationInstant,
      organization,
    );
    const context = proofReceiptContext(departmentScope);
    const applicable = yield* loadApplicableAuthorizationRules(
      subject,
      "submitReceipt",
      authorizationInstant,
      context,
    );
    const composition = composeCapabilityEvidence(
      "submitReceipt",
      { paymentAuthorities: direct.paymentAuthorities },
      applicable.rules,
      {
        personId: subject,
        authorizationInstant,
        context,
        tagAssignments: applicable.tagAssignments,
      },
    );
    const composedAuthority = projectReceiptAuthority(
      organization,
      composition.evidence.paymentAuthorities ?? [],
      [],
    );
    const mapped = yield* Effect.result(
      mapReceiptSubmissionPrincipal(composedAuthority, departmentScope),
    );
    return {
      applicableRuleIds: applicable.rules.map((rule) => rule.ruleId),
      assignmentIds: applicable.tagAssignments.map((assignment) => assignment.assignmentId),
      contributingRuleIds: composition.contributingRuleIds,
      directPaymentAuthorities: direct.paymentAuthorities.map((authority) => ({
        paymentAuthorityId: authority.paymentAuthorityId,
        departmentId: authority.departmentId,
        active: authority.active,
        startAt: authority.startAt,
        endAt: authority.endAt,
      })),
      composedPaymentAuthorityIds: (composition.evidence.paymentAuthorities ?? []).map(
        (authority) => authority.paymentAuthorityId,
      ),
      mapped:
        mapped._tag === "Success"
          ? { _tag: "Success" as const, actor: mapped.success.actor }
          : { _tag: "Failure" as const, failureTag: failureTag(mapped.failure) },
    };
  });

const approvalCompositionFacts = (
  person: string,
  authorizationInstant: string,
  department: string,
) =>
  Effect.gen(function* () {
    const subject = personId(person);
    const departmentScope = departmentId(department);
    const organization = yield* resolveOrganizationPersonAuthorityForRead(
      subject,
      authorizationInstant,
    );
    const direct = yield* resolveReceiptAuthorityForRead(
      subject,
      authorizationInstant,
      organization,
    );
    const context = proofReceiptContext(departmentScope);
    const applicable = yield* loadApplicableAuthorizationRules(
      subject,
      "approveReceipt",
      authorizationInstant,
      context,
    );
    const composition = composeCapabilityEvidence(
      "approveReceipt",
      { approvalGrants: direct.approvalGrants },
      applicable.rules,
      {
        personId: subject,
        authorizationInstant,
        context,
        tagAssignments: applicable.tagAssignments,
      },
    );
    const composedAuthority = projectReceiptAuthority(
      organization,
      [],
      composition.evidence.approvalGrants ?? [],
    );
    const mapped = yield* Effect.result(
      mapReceiptApprovalActor(composedAuthority, departmentScope),
    );
    return {
      applicableRuleIds: applicable.rules.map((rule) => rule.ruleId),
      assignmentIds: applicable.tagAssignments.map((assignment) => assignment.assignmentId),
      contributingRuleIds: composition.contributingRuleIds,
      directApprovalGrants: direct.approvalGrants.map((grant) => ({
        approvalGrantId: grant.approvalGrantId,
        active: grant.active,
        startAt: grant.startAt,
        endAt: grant.endAt,
      })),
      composedApprovalGrantIds: (composition.evidence.approvalGrants ?? []).map(
        (grant) => grant.approvalGrantId,
      ),
      mapped:
        mapped._tag === "Success"
          ? { _tag: "Success" as const, actor: mapped.success }
          : { _tag: "Failure" as const, failureTag: failureTag(mapped.failure) },
    };
  });

const proveStrictWriters = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const unknownRuleId = "authz-0056-proof-rule-invalid-capability";
    const invalidParamsRuleId = "authz-0056-proof-rule-invalid-params";
    const unknownCapability = yield* Effect.result(
      createAuthzRule({
        ruleId: unknownRuleId,
        capabilityId: "unknownCapability",
        effectKind: "delegate",
        subject: { _tag: "Person", personId: ids.persons.ruleSubmit },
        scope: { _tag: "Department", departmentId: ids.departments.alpha },
        params: { slot: "EconomyPaymentAuthority", paymentAccountCiphertext: "not-stored" },
        startAt: activeStart,
        endAt: null,
        revision: 0,
      } as never),
    );
    const invalidParams = yield* Effect.result(
      createAuthzRule({
        ruleId: invalidParamsRuleId,
        capabilityId: "submitReceipt",
        effectKind: "delegate",
        subject: { _tag: "Person", personId: ids.persons.ruleSubmit },
        scope: { _tag: "Department", departmentId: ids.departments.alpha },
        params: { slot: "EconomyPaymentAuthority" },
        startAt: activeStart,
        endAt: null,
        revision: 0,
      } as never),
    );
    const [stored] = yield* sql<{ readonly count: number }>`
      SELECT count(*)::integer AS count
      FROM public.authz_rules
      WHERE rule_id IN (${unknownRuleId}, ${invalidParamsRuleId})
    `;
    assert(stored);
    assert.equal(resultFailureTag(unknownCapability), "AuthzValidationError");
    assert.equal(resultFailureTag(invalidParams), "AuthzValidationError");
    assert.equal(stored.count, 0);
    return {
      unknownCapability: {
        failureTag: resultFailureTag(unknownCapability),
        storedRows: 0,
      },
      invalidParams: {
        failureTag: resultFailureTag(invalidParams),
        storedRows: 0,
      },
      totalInvalidRowsStored: stored.count,
    };
  }).pipe(Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-strict-writer`)));

const proveDisposableAuthzBackfill = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const before = yield* readAuthzRowCounts(sql);
    const forwardPlan = yield* persistDisposableAuthzBackfill(validDisposableAuthzBackfillInput());
    const afterForward = yield* readAuthzRowCounts(sql);
    const reversedPlan = yield* persistDisposableAuthzBackfill(
      reversedDisposableAuthzBackfillInput(),
    );
    const afterReversedReplay = yield* readAuthzRowCounts(sql);
    const replayPlan = yield* persistDisposableAuthzBackfill(validDisposableAuthzBackfillInput());
    const afterReplay = yield* readAuthzRowCounts(sql);
    const forwardEvidence = backfillPlanEvidence(forwardPlan);
    const reversedEvidence = backfillPlanEvidence(reversedPlan);
    const replayEvidence = backfillPlanEvidence(replayPlan);

    assert.deepEqual(canonicalJsonBytes(reversedPlan), canonicalJsonBytes(forwardPlan));
    assert.deepEqual(canonicalJsonBytes(replayPlan), canonicalJsonBytes(forwardPlan));
    assert.deepEqual(reversedEvidence, forwardEvidence);
    assert.deepEqual(replayEvidence, forwardEvidence);
    assert.deepEqual(afterForward, {
      tags: before.tags + 2,
      assignments: before.assignments + 2,
      rules: before.rules + 3,
    });
    assert.deepEqual(afterReversedReplay, afterForward);
    assert.deepEqual(afterReplay, afterForward);

    const missingPerson = yield* Effect.flip(
      persistDisposableAuthzBackfill({
        disposable: true,
        tags: [{ name: "PG proof missing person sentinel" }],
        assignments: [],
        rulesBySubject: [
          {
            subject: {
              _tag: "Person",
              personId: "authz-0056-proof-backfill-absent-person",
            },
            rules: [
              {
                capabilityId: "approveReceipt",
                effectKind: "delegate",
                scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                params: { slot: "EconomyGlobalReceiptApprovalGrant" },
                startAt: activeStart,
                endAt: null,
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(
      {
        failureTag: missingPerson._tag,
        referenceKind:
          missingPerson._tag === "DisposableAuthzBackfillMissingReference"
            ? missingPerson.referenceKind
            : null,
        referenceId:
          missingPerson._tag === "DisposableAuthzBackfillMissingReference"
            ? missingPerson.referenceId
            : null,
      },
      {
        failureTag: "DisposableAuthzBackfillMissingReference",
        referenceKind: "Person",
        referenceId: "authz-0056-proof-backfill-absent-person",
      },
    );
    const afterMissingPerson = yield* readAuthzRowCounts(sql);
    assert.deepEqual(afterMissingPerson, afterForward);

    const missingTag = yield* Effect.flip(
      persistDisposableAuthzBackfill({
        disposable: true,
        tags: [],
        assignments: [],
        rulesBySubject: [
          {
            subject: { _tag: "Tag", tagName: "PG proof absent authored tag" },
            rules: [
              {
                capabilityId: "approveReceipt",
                effectKind: "delegate",
                scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                params: { slot: "EconomyGlobalReceiptApprovalGrant" },
                startAt: activeStart,
                endAt: null,
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(
      {
        failureTag: missingTag._tag,
        referenceKind:
          missingTag._tag === "DisposableAuthzBackfillMissingReference"
            ? missingTag.referenceKind
            : null,
        referenceId:
          missingTag._tag === "DisposableAuthzBackfillMissingReference"
            ? missingTag.referenceId
            : null,
      },
      {
        failureTag: "DisposableAuthzBackfillMissingReference",
        referenceKind: "Tag",
        referenceId: "PG proof absent authored tag",
      },
    );
    const afterMissingTag = yield* readAuthzRowCounts(sql);
    assert.deepEqual(afterMissingTag, afterForward);

    const missingDepartment = yield* Effect.flip(
      persistDisposableAuthzBackfill({
        disposable: true,
        tags: [{ name: "PG proof missing department sentinel" }],
        assignments: [
          {
            tagName: "PG proof missing department sentinel",
            personId: "authz-backfill-person-a",
            startAt: activeStart,
            endAt: null,
          },
        ],
        rulesBySubject: [
          {
            subject: { _tag: "Person", personId: "authz-backfill-person-a" },
            rules: [
              {
                capabilityId: "approveReceipt",
                effectKind: "delegate",
                scope: {
                  _tag: "Department",
                  departmentId: "authz-0056-proof-backfill-absent-department",
                },
                params: { slot: "EconomyDepartmentApprovalGrant" },
                startAt: activeStart,
                endAt: null,
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(
      {
        failureTag: missingDepartment._tag,
        referenceKind:
          missingDepartment._tag === "DisposableAuthzBackfillMissingReference"
            ? missingDepartment.referenceKind
            : null,
        referenceId:
          missingDepartment._tag === "DisposableAuthzBackfillMissingReference"
            ? missingDepartment.referenceId
            : null,
      },
      {
        failureTag: "DisposableAuthzBackfillMissingReference",
        referenceKind: "Department",
        referenceId: "authz-0056-proof-backfill-absent-department",
      },
    );
    const afterMissingDepartment = yield* readAuthzRowCounts(sql);
    assert.deepEqual(afterMissingDepartment, afterForward);

    const invalidCapability = yield* Effect.flip(
      persistDisposableAuthzBackfill({
        disposable: true,
        tags: [{ name: "PG proof invalid capability sentinel" }],
        assignments: [],
        rulesBySubject: [
          {
            subject: { _tag: "Person", personId: "authz-backfill-person-a" },
            rules: [
              {
                capabilityId: "unknownCapability",
                effectKind: "delegate",
                scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                params: { slot: "EconomyGlobalReceiptApprovalGrant" },
                startAt: activeStart,
                endAt: null,
              },
            ],
          },
        ],
      }),
    );
    assert.equal(invalidCapability._tag, "DisposableAuthzBackfillDecodeError");
    const afterInvalidCapability = yield* readAuthzRowCounts(sql);
    assert.deepEqual(afterInvalidCapability, afterForward);

    const invalidParams = yield* Effect.flip(
      persistDisposableAuthzBackfill({
        disposable: true,
        tags: [{ name: "PG proof invalid params sentinel" }],
        assignments: [],
        rulesBySubject: [
          {
            subject: { _tag: "Person", personId: "authz-backfill-person-a" },
            rules: [
              {
                capabilityId: "submitReceipt",
                effectKind: "delegate",
                scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                params: { slot: "EconomyPaymentAuthority", ignored: true },
                startAt: activeStart,
                endAt: null,
              },
            ],
          },
        ],
      }),
    );
    assert.equal(invalidParams._tag, "DisposableAuthzBackfillDecodeError");
    const afterInvalidParams = yield* readAuthzRowCounts(sql);
    assert.deepEqual(afterInvalidParams, afterForward);

    return {
      permutationAndReplay: {
        forward: forwardEvidence,
        reversed: reversedEvidence,
        replay: replayEvidence,
        byteIdentical:
          forwardEvidence.sha256 === reversedEvidence.sha256 &&
          forwardEvidence.sha256 === replayEvidence.sha256,
        counts: {
          before,
          afterForward,
          afterReversedReplay,
          afterReplay,
        },
      },
      rejections: [
        {
          fixtureId: "absent-person",
          failureTag: missingPerson._tag,
          referenceKind: "Person",
          referenceId: "authz-0056-proof-backfill-absent-person",
          before: afterForward,
          after: afterMissingPerson,
          partialRowsWritten: false,
        },
        {
          fixtureId: "absent-tag",
          failureTag: missingTag._tag,
          referenceKind: "Tag",
          referenceId: "PG proof absent authored tag",
          before: afterForward,
          after: afterMissingTag,
          partialRowsWritten: false,
        },
        {
          fixtureId: "absent-department",
          failureTag: missingDepartment._tag,
          referenceKind: "Department",
          referenceId: "authz-0056-proof-backfill-absent-department",
          before: afterForward,
          after: afterMissingDepartment,
          partialRowsWritten: false,
        },
        {
          fixtureId: "invalid-capability",
          failureTag: invalidCapability._tag,
          before: afterForward,
          after: afterInvalidCapability,
          partialRowsWritten: false,
        },
        {
          fixtureId: "invalid-params",
          failureTag: invalidParams._tag,
          before: afterForward,
          after: afterInvalidParams,
          partialRowsWritten: false,
        },
      ],
    };
  }).pipe(Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-backfill`)));

const proveZeroRuleEquivalence = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const alpha = departmentId(ids.departments.alpha);
    const {
      administrator: administratorFixture,
      leader: leaderFixture,
      inactiveLeader: inactiveLeaderFixture,
      member: memberFixture,
      absent: absentFixture,
    } = makeSpec0055OrganizationAuthorityFixtures({
      evaluatedAt: exactEnd,
      departmentId: ids.departments.alpha,
      teamId: ids.teams.alpha,
      persons: {
        administrator: ids.persons.matrixAdministrator,
        leader: ids.persons.matrixLeader,
        inactiveLeader: ids.persons.matrixInactiveLeader,
        member: ids.persons.matrixMember,
        absent: ids.persons.matrixAbsent,
      },
      memberships: {
        leader: "authz-0056-proof-membership-matrix-leader",
        inactiveLeader: "authz-0056-proof-membership-matrix-inactive-leader",
        member: "authz-0056-proof-membership-matrix-member",
      },
    });

    const leaderProjection = yield* resolveOrganizationPersonAuthorityForRead(
      leaderFixture.personId,
      exactEnd,
    );
    const inactiveLeaderProjection = yield* resolveOrganizationPersonAuthorityForRead(
      inactiveLeaderFixture.personId,
      exactEnd,
    );
    const administratorProjection = yield* resolveOrganizationPersonAuthorityForRead(
      administratorFixture.personId,
      exactEnd,
    );
    const memberProjection = yield* resolveOrganizationPersonAuthorityForRead(
      memberFixture.personId,
      exactEnd,
    );
    const absentProjection = yield* resolveOrganizationPersonAuthorityForRead(
      absentFixture.personId,
      exactEnd,
    );
    assert.deepEqual(leaderProjection, leaderFixture);
    assert.deepEqual(inactiveLeaderProjection, inactiveLeaderFixture);
    assert.deepEqual(administratorProjection, administratorFixture);
    assert.deepEqual(memberProjection, memberFixture);
    assert.deepEqual(absentProjection, absentFixture);

    const [fixtureRuleRows] = yield* sql<{ readonly count: number }>`
      SELECT count(*)::integer AS count
      FROM public.authz_rules AS rule
      WHERE rule.subject_person_id IN (
          ${ids.persons.matrixAdministrator},
          ${ids.persons.matrixLeader},
          ${ids.persons.matrixInactiveLeader},
          ${ids.persons.matrixMember},
          ${ids.persons.matrixAbsent},
          ${ids.persons.direct},
          ${ids.persons.endedDirect}
        )
        OR rule.subject_tag_id IN (
          SELECT assignment.tag_id
          FROM public.authz_tag_assignments AS assignment
          WHERE assignment.person_id IN (
            ${ids.persons.matrixAdministrator},
            ${ids.persons.matrixLeader},
            ${ids.persons.matrixInactiveLeader},
            ${ids.persons.matrixMember},
            ${ids.persons.matrixAbsent},
            ${ids.persons.direct},
            ${ids.persons.endedDirect}
          )
            AND assignment.start_at <= ${exactEnd}
            AND (assignment.end_at IS NULL OR ${exactEnd} < assignment.end_at)
        )
    `;
    assert(fixtureRuleRows);
    assert.equal(fixtureRuleRows.count, 0);

    const requireAllowed = <A>(
      decision:
        | { readonly _tag: "Allow"; readonly value: A }
        | { readonly _tag: "Deny"; readonly reason: string },
    ): A => {
      if (decision._tag !== "Allow") {
        assert.fail(`expected Allow, received Deny(${decision.reason})`);
      }
      return decision.value;
    };

    const observeMapperDenial = (
      decision:
        | { readonly _tag: "Allow"; readonly value: unknown }
        | { readonly _tag: "Deny"; readonly reason: string },
      scope: unknown,
      activeState: unknown,
    ) => {
      if (decision._tag !== "Deny") {
        assert.fail("expected mapper denial");
      }
      return {
        actor: null,
        scope,
        activeState,
        result: { _tag: "Rejected" as const, reason: decision.reason },
      };
    };

    const admissionAcceptedDirectActor = requireAllowed(
      mapOrganizationAuthorityToAdmissionPeriodActor(leaderFixture, alpha),
    );
    const admissionAcceptedRulesEmptyActor = requireAllowed(
      mapOrganizationAuthorityToAdmissionPeriodActor(leaderProjection, alpha),
    );
    const admissionSemesterId = SemesterId.make(ids.domainBoundaries.recruitmentSemester);
    const admissionCommandId = AdmissionPeriodCommandId.make(ids.commands.admissionMatrixCreate);
    const admissionPeriodId = AdmissionPeriodId.make(ids.domainBoundaries.admissionDecisionPeriod);
    const admissionSemester = {
      semesterId: admissionSemesterId,
      startAt: "2037-01-01T00:00:00.000Z",
      endAt: "2038-01-01T00:00:00.000Z",
    } as const;
    const admissionCommand = {
      _tag: "CreateAdmissionPeriod",
      commandId: admissionCommandId,
      semesterId: admissionSemesterId,
      departmentId: alpha,
      startAt: "2037-06-01T00:00:00.000Z",
      endAt: "2037-07-01T00:00:00.000Z",
    } as const;
    const admissionAcceptedDirectDecision = yield* decideAdmissionPeriod(
      undefined,
      admissionCommand,
      {
        actor: admissionAcceptedDirectActor,
        semester: admissionSemester,
        now: exactEnd,
        admissionPeriodId,
      },
    );
    const admissionAcceptedRulesEmptyDecision = yield* decideAdmissionPeriod(
      undefined,
      admissionCommand,
      {
        actor: admissionAcceptedRulesEmptyActor,
        semester: admissionSemester,
        now: exactEnd,
        admissionPeriodId,
      },
    );
    const expectedAdmissionObservation = {
      _tag: "Created" as const,
      commandId: admissionCommandId,
      period: {
        id: admissionPeriodId,
        departmentId: alpha,
        semesterId: admissionSemesterId,
        startAt: admissionCommand.startAt,
        endAt: admissionCommand.endAt,
        revision: 0,
        lastCommandId: admissionCommandId,
      },
    };
    assert.deepEqual(admissionAcceptedDirectDecision.observation, expectedAdmissionObservation);
    assert.deepEqual(admissionAcceptedRulesEmptyDecision.observation, expectedAdmissionObservation);
    const admissionAcceptedDirect = {
      actor: admissionAcceptedDirectActor,
      scope: { _tag: "Department" as const, departmentId: alpha },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: {
        _tag: "Success" as const,
        observation: admissionAcceptedDirectDecision.observation,
      },
    };
    const admissionAcceptedRulesEmpty = {
      actor: admissionAcceptedRulesEmptyActor,
      scope: { _tag: "Department" as const, departmentId: alpha },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: {
        _tag: "Success" as const,
        observation: admissionAcceptedRulesEmptyDecision.observation,
      },
    };
    const admissionRejectedDirect = observeMapperDenial(
      mapOrganizationAuthorityToAdmissionPeriodActor(inactiveLeaderFixture, alpha),
      { _tag: "Department" as const, departmentId: alpha },
      { globalAdministrator: "Absent" as const, membershipActive: false },
    );
    const admissionRejectedRulesEmpty = observeMapperDenial(
      mapOrganizationAuthorityToAdmissionPeriodActor(inactiveLeaderProjection, alpha),
      { _tag: "Department" as const, departmentId: alpha },
      { globalAdministrator: "Absent" as const, membershipActive: false },
    );

    const recruitmentAcceptedDirectActor = requireAllowed(
      mapOrganizationAuthorityToRecruitmentActor(leaderFixture, alpha),
    );
    const recruitmentAcceptedRulesEmptyActor = requireAllowed(
      mapOrganizationAuthorityToRecruitmentActor(leaderProjection, alpha),
    );
    const recruitment = yield* Recruitment;
    const recruitmentAcceptedDirectBoard = yield* recruitment.readAssignmentBoard(
      { status: "new" },
      { actor: recruitmentAcceptedDirectActor, now: exactEnd },
    );
    const recruitmentAcceptedRulesEmptyBoard = yield* recruitment.readAssignmentBoard(
      { status: "new" },
      { actor: recruitmentAcceptedRulesEmptyActor, now: exactEnd },
    );
    assert.deepEqual(recruitmentAcceptedRulesEmptyBoard, recruitmentAcceptedDirectBoard);
    assert.equal(
      recruitmentAcceptedDirectBoard.admissionPeriodId,
      ids.domainBoundaries.recruitmentAdmissionPeriod,
    );
    assert.equal(recruitmentAcceptedDirectBoard.departmentId, ids.departments.alpha);
    assert.deepEqual(recruitmentAcceptedDirectBoard.candidates, [
      {
        applicationId: ids.domainBoundaries.recruitmentApplication,
        applicantId: ids.domainBoundaries.recruitmentApplicant,
        firstName: "Rita",
        lastName: "Candidate",
        email: "authz-0056-proof-recruitment-candidate@example.invalid",
        submittedAt: "2037-06-10T12:00:00.000Z",
        applicationState: "Received",
        interviewState: "Unassigned",
        interviewer: null,
        interviewSchema: null,
        scheduledAt: null,
      },
    ]);
    assert.deepEqual(recruitmentAcceptedDirectBoard.interviewSchemas, [
      {
        interviewSchemaId: ids.domainBoundaries.recruitmentInterviewSchema,
        name: "Authorization proof interview",
        questionCount: 0,
        active: true,
        revision: 0,
      },
    ]);
    assert.ok(
      recruitmentAcceptedDirectBoard.interviewers.some(
        (interviewer) => interviewer.personId === leaderFixture.personId,
      ),
    );
    const recruitmentAcceptedDirect = {
      actor: recruitmentAcceptedDirectActor,
      scope: { _tag: "Department" as const, departmentId: alpha },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: {
        _tag: "Success" as const,
        assignmentBoard: recruitmentAcceptedDirectBoard,
      },
    };
    const recruitmentAcceptedRulesEmpty = {
      actor: recruitmentAcceptedRulesEmptyActor,
      scope: { _tag: "Department" as const, departmentId: alpha },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: {
        _tag: "Success" as const,
        assignmentBoard: recruitmentAcceptedRulesEmptyBoard,
      },
    };
    const recruitmentRejectedDirect = observeMapperDenial(
      mapOrganizationAuthorityToRecruitmentActor(inactiveLeaderFixture, alpha),
      { _tag: "Department" as const, departmentId: alpha },
      { globalAdministrator: "Absent" as const, membershipActive: false },
    );
    const recruitmentRejectedRulesEmpty = observeMapperDenial(
      mapOrganizationAuthorityToRecruitmentActor(inactiveLeaderProjection, alpha),
      { _tag: "Department" as const, departmentId: alpha },
      { globalAdministrator: "Absent" as const, membershipActive: false },
    );

    const organizationAcceptedDirectActor =
      mapOrganizationAuthorityToOrganizationActor(administratorFixture);
    const organizationAcceptedRulesEmptyActor =
      mapOrganizationAuthorityToOrganizationActor(administratorProjection);
    const organizationAcceptedDirectResult = yield* Effect.result(
      authorizeOrganizationActor(organizationAcceptedDirectActor),
    );
    const organizationAcceptedRulesEmptyResult = yield* Effect.result(
      authorizeOrganizationActor(organizationAcceptedRulesEmptyActor),
    );
    const organizationAcceptedDirect = {
      actor: organizationAcceptedDirectActor,
      scope: { _tag: "Global" as const },
      activeState: { globalAdministrator: "Active" as const },
      result: { _tag: resultFailureTag(organizationAcceptedDirectResult) },
    };
    const organizationAcceptedRulesEmpty = {
      actor: organizationAcceptedRulesEmptyActor,
      scope: { _tag: "Global" as const },
      activeState: { globalAdministrator: "Active" as const },
      result: { _tag: resultFailureTag(organizationAcceptedRulesEmptyResult) },
    };
    const organizationRejectedDirectActor =
      mapOrganizationAuthorityToOrganizationActor(memberFixture);
    const organizationRejectedRulesEmptyActor =
      mapOrganizationAuthorityToOrganizationActor(memberProjection);
    const organizationRejectedDirectResult = yield* Effect.result(
      authorizeOrganizationActor(organizationRejectedDirectActor),
    );
    const organizationRejectedRulesEmptyResult = yield* Effect.result(
      authorizeOrganizationActor(organizationRejectedRulesEmptyActor),
    );
    const organizationRejectedDirect = {
      actor: organizationRejectedDirectActor,
      scope: { _tag: "Global" as const },
      activeState: {
        globalAdministrator: "Absent" as const,
        membershipActive: true,
      },
      result: { _tag: resultFailureTag(organizationRejectedDirectResult) },
    };
    const organizationRejectedRulesEmpty = {
      actor: organizationRejectedRulesEmptyActor,
      scope: { _tag: "Global" as const },
      activeState: {
        globalAdministrator: "Absent" as const,
        membershipActive: true,
      },
      result: { _tag: resultFailureTag(organizationRejectedRulesEmptyResult) },
    };

    const profileAcceptedDirectResult = mapOrganizationAuthorityToProfileRole(leaderFixture);
    const profileAcceptedRulesEmptyResult = mapOrganizationAuthorityToProfileRole(leaderProjection);
    const profileRejectedDirectResult =
      mapOrganizationAuthorityToProfileRole(inactiveLeaderFixture);
    const profileRejectedRulesEmptyResult =
      mapOrganizationAuthorityToProfileRole(inactiveLeaderProjection);
    assert.equal(profileAcceptedDirectResult._tag, "Allow");
    assert.equal(profileAcceptedRulesEmptyResult._tag, "Allow");
    assert.equal(profileRejectedDirectResult._tag, "Deny");
    assert.equal(profileRejectedRulesEmptyResult._tag, "Deny");
    const profileAcceptedDirect = {
      actor: profileAcceptedDirectResult.value,
      scope: { _tag: "Self" as const, personId: leaderFixture.personId },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: profileAcceptedDirectResult,
    };
    const profileAcceptedRulesEmpty = {
      actor: profileAcceptedRulesEmptyResult.value,
      scope: { _tag: "Self" as const, personId: leaderProjection.personId },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: true },
      result: profileAcceptedRulesEmptyResult,
    };
    const profileRejectedDirect = {
      actor: null,
      scope: { _tag: "Self" as const, personId: inactiveLeaderFixture.personId },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: false },
      result: profileRejectedDirectResult,
    };
    const profileRejectedRulesEmpty = {
      actor: null,
      scope: { _tag: "Self" as const, personId: inactiveLeaderProjection.personId },
      activeState: { globalAdministrator: "Absent" as const, membershipActive: false },
      result: profileRejectedRulesEmptyResult,
    };

    const composition = yield* submissionCompositionFacts(
      ids.persons.direct,
      justBeforeExactEnd,
      ids.departments.alpha,
    );
    assert.equal(composition.applicableRuleIds.length, 0);
    assert.deepEqual(composition.contributingRuleIds, []);
    assert.equal(composition.mapped._tag, "Success");
    const result = yield* executeReceiptCommand(
      submitCommand(ids.commands.directSubmit, ids.departments.alpha, "direct"),
      principal(ids.persons.direct, justBeforeExactEnd),
      allocation(generatedReceiptIds.direct, generatedVisualIds.direct),
    );
    const durable = yield* readDurableCommandFacts(sql, ids.commands.directSubmit);
    const actual = {
      actor: composition.mapped._tag === "Success" ? composition.mapped.actor : null,
      scope: { domainId: RECEIPT_DOMAIN_ID, departmentId: ids.departments.alpha },
      observation: result.observation,
    };
    const spec0055Oracle = {
      actor: {
        personId: ids.persons.direct,
        departmentId: ids.departments.alpha,
        active: true,
        approvalScope: { _tag: "None" as const },
      },
      scope: { domainId: RECEIPT_DOMAIN_ID, departmentId: ids.departments.alpha },
      observation: {
        commandId: ids.commands.directSubmit,
        receiptId: generatedReceiptIds.direct,
        visualId: generatedVisualIds.direct,
        status: "Pending" as const,
        revision: 0,
        replayed: false,
      },
    };
    assert.deepEqual(actual, spec0055Oracle);
    assert.deepEqual(durable, {
      commandReceiptRows: 1,
      auditRows: 1,
      outboxRows: 3,
      outboxCommandRows: 1,
    });
    const receiptAcceptedDirect = {
      actor: spec0055Oracle.actor,
      scope: spec0055Oracle.scope,
      activeState: true,
      result: { _tag: "Accepted" as const },
    };
    const receiptAcceptedRulesEmpty = {
      actor: actual.actor,
      scope: actual.scope,
      activeState: actual.actor?.active ?? null,
      result: { _tag: "Accepted" as const },
    };

    const rejectedComposition = yield* submissionCompositionFacts(
      ids.persons.endedDirect,
      exactEnd,
      ids.departments.alpha,
    );
    assert.deepEqual(rejectedComposition.applicableRuleIds, []);
    assert.deepEqual(rejectedComposition.contributingRuleIds, []);
    assert.equal(rejectedComposition.mapped._tag, "Success");
    const rejectedResult = yield* Effect.result(
      executeReceiptCommand(
        submitCommand(
          ids.commands.matrixReceiptRejected,
          ids.departments.alpha,
          "matrix-receipt-rejected",
        ),
        principal(ids.persons.endedDirect, exactEnd),
        allocation(
          generatedReceiptIds.matrixReceiptRejected,
          generatedVisualIds.matrixReceiptRejected,
        ),
      ),
    );
    const rejectedDurable = yield* readDurableCommandFacts(sql, ids.commands.matrixReceiptRejected);
    assert.equal(resultFailureTag(rejectedResult), "InactiveActor");
    assert.deepEqual(rejectedDurable, {
      commandReceiptRows: 0,
      auditRows: 0,
      outboxRows: 0,
      outboxCommandRows: 0,
    });
    const receiptRejectedActor =
      rejectedComposition.mapped._tag === "Success" ? rejectedComposition.mapped.actor : null;
    const receiptRejectedDirect = {
      actor: {
        personId: ids.persons.endedDirect,
        departmentId: ids.departments.alpha,
        active: false,
        approvalScope: { _tag: "None" as const },
      },
      scope: { domainId: RECEIPT_DOMAIN_ID, departmentId: ids.departments.alpha },
      activeState: false,
      result: { _tag: "InactiveActor" as const },
    };
    const receiptRejectedRulesEmpty = {
      actor: receiptRejectedActor,
      scope: { domainId: RECEIPT_DOMAIN_ID, departmentId: ids.departments.alpha },
      activeState: receiptRejectedActor?.active ?? null,
      result: { _tag: resultFailureTag(rejectedResult) },
    };

    const matrix = [
      {
        fixtureId: "organization-authority-active-leader-admission",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Admission",
        expected: "Accepted",
        directOracle: admissionAcceptedDirect,
        rulesEmpty: admissionAcceptedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-inactive-leader-admission",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Admission",
        expected: "Rejected",
        directOracle: admissionRejectedDirect,
        rulesEmpty: admissionRejectedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-active-leader-recruitment",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Recruitment",
        expected: "Accepted",
        directOracle: recruitmentAcceptedDirect,
        rulesEmpty: recruitmentAcceptedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-inactive-leader-recruitment",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Recruitment",
        expected: "Rejected",
        directOracle: recruitmentRejectedDirect,
        rulesEmpty: recruitmentRejectedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-active-administrator",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Organization",
        expected: "Accepted",
        directOracle: organizationAcceptedDirect,
        rulesEmpty: organizationAcceptedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-member-role-denied",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Organization",
        expected: "Rejected",
        directOracle: organizationRejectedDirect,
        rulesEmpty: organizationRejectedRulesEmpty,
      },
      {
        fixtureId: "receipt-authority-active-payment",
        fixtureSource: "packages/domain/src/receipt/authority.test.ts",
        domain: "receipts",
        expected: "Accepted",
        directOracle: receiptAcceptedDirect,
        rulesEmpty: receiptAcceptedRulesEmpty,
      },
      {
        fixtureId: "receipt-authority-exact-end-inactive",
        fixtureSource: "packages/domain/src/receipt/authority.test.ts",
        domain: "receipts",
        expected: "Rejected",
        directOracle: receiptRejectedDirect,
        rulesEmpty: receiptRejectedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-active-leader-profile",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Profile",
        expected: "Accepted",
        directOracle: profileAcceptedDirect,
        rulesEmpty: profileAcceptedRulesEmpty,
      },
      {
        fixtureId: "organization-authority-inactive-history-profile",
        fixtureSource: "packages/domain/src/organization/authority.test.ts",
        domain: "Profile",
        expected: "Rejected",
        directOracle: profileRejectedDirect,
        rulesEmpty: profileRejectedRulesEmpty,
      },
    ].map((entry) => ({
      ...entry,
      actorScopeActiveResultEqual:
        canonicalJson(entry.directOracle) === canonicalJson(entry.rulesEmpty),
    }));
    assert.equal(matrix.length, 10);
    assert.deepEqual(
      matrix.map((entry) => [entry.domain, entry.expected]),
      [
        ["Admission", "Accepted"],
        ["Admission", "Rejected"],
        ["Recruitment", "Accepted"],
        ["Recruitment", "Rejected"],
        ["Organization", "Accepted"],
        ["Organization", "Rejected"],
        ["Receipt", "Accepted"],
        ["Receipt", "Rejected"],
        ["Profile", "Accepted"],
        ["Profile", "Rejected"],
      ],
    );
    assert.ok(matrix.every((entry) => entry.actorScopeActiveResultEqual));

    return {
      applicableRuleIds: composition.applicableRuleIds,
      directPaymentAuthorities: composition.directPaymentAuthorities,
      actual,
      spec0055Oracle,
      actorScopeObservationEqual: canonicalJson(actual) === canonicalJson(spec0055Oracle),
      durable,
      rejectedReceiptDurable: rejectedDurable,
      fixtureSubjectRuleRows: fixtureRuleRows.count,
      authoritativeProjectionFixtures: {
        leader: leaderProjection,
        inactiveLeader: inactiveLeaderProjection,
        administrator: administratorProjection,
        member: memberProjection,
        absent: absentProjection,
      },
      matrix,
    };
  }).pipe(
    Effect.provide(makeZeroRuleProofLayer(databaseUrl, `${proofApplicationPrefix}-zero-rule`)),
  );

const proveHalfOpenAndScopeDenials = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const endedRuleBefore = yield* loadApplicableAuthorizationRules(
      personId(ids.persons.endedRule),
      "approveReceipt",
      justBeforeExactEnd,
      proofReceiptContext(departmentId(ids.departments.alpha)),
    );
    const endedRuleExact = yield* loadApplicableAuthorizationRules(
      personId(ids.persons.endedRule),
      "approveReceipt",
      exactEnd,
      proofReceiptContext(departmentId(ids.departments.alpha)),
    );
    const endedRuleCommand = yield* Effect.result(
      executeReceiptCommand(
        {
          _tag: "RejectReceipt",
          commandId: ids.commands.endedRuleApprove,
          receiptId: ReceiptId.make(ids.receipts.endedRule),
          expectedRevision: 0,
        },
        principal(ids.persons.endedRule, exactEnd),
      ),
    );
    const endedRuleDurable = yield* readDurableCommandFacts(sql, ids.commands.endedRuleApprove);

    const directBefore = yield* submissionCompositionFacts(
      ids.persons.endedDirect,
      justBeforeExactEnd,
      ids.departments.alpha,
    );
    const directExact = yield* submissionCompositionFacts(
      ids.persons.endedDirect,
      exactEnd,
      ids.departments.alpha,
    );
    const endedDirectCommand = yield* Effect.result(
      executeReceiptCommand(
        submitCommand(ids.commands.endedDirectSubmit, ids.departments.alpha, "ended-direct"),
        principal(ids.persons.endedDirect, exactEnd),
        allocation(generatedReceiptIds.endedDirect, generatedVisualIds.endedDirect),
      ),
    );
    const endedDirectDurable = yield* readDurableCommandFacts(sql, ids.commands.endedDirectSubmit);

    const crossRuleMatchingScope = yield* loadApplicableAuthorizationRules(
      personId(ids.persons.crossDepartment),
      "submitReceipt",
      exactEnd,
      proofReceiptContext(departmentId(ids.departments.alpha)),
    );
    const crossRuleOtherScope = yield* loadApplicableAuthorizationRules(
      personId(ids.persons.crossDepartment),
      "submitReceipt",
      exactEnd,
      proofReceiptContext(departmentId(ids.departments.beta)),
    );
    const crossDepartmentCommand = yield* Effect.result(
      executeReceiptCommand(
        submitCommand(ids.commands.crossDepartmentSubmit, ids.departments.beta, "cross-department"),
        principal(ids.persons.crossDepartment, exactEnd),
        allocation(generatedReceiptIds.crossDepartment, generatedVisualIds.crossDepartment),
      ),
    );
    const crossDepartmentDurable = yield* readDurableCommandFacts(
      sql,
      ids.commands.crossDepartmentSubmit,
    );
    const endedRuleBeforeIds = endedRuleBefore.rules.map((rule) => rule.ruleId);
    const endedRuleExactIds = endedRuleExact.rules.map((rule) => rule.ruleId);
    const crossRuleMatchingScopeIds = crossRuleMatchingScope.rules.map((rule) => rule.ruleId);
    const crossRuleOtherScopeIds = crossRuleOtherScope.rules.map((rule) => rule.ruleId);

    assert.deepEqual(endedRuleBeforeIds, [ids.rules.endedApprove]);
    assert.deepEqual(endedRuleExactIds, []);
    assert.equal(resultFailureTag(endedRuleCommand), "ReceiptAuthorityDenied");
    assert.deepEqual(endedRuleDurable, {
      commandReceiptRows: 0,
      auditRows: 0,
      outboxRows: 0,
      outboxCommandRows: 0,
    });
    assert.equal(directBefore.mapped._tag, "Success");
    assert.deepEqual(directExact.mapped, {
      _tag: "Success",
      actor: {
        personId: ids.persons.endedDirect,
        departmentId: ids.departments.alpha,
        active: false,
        approvalScope: { _tag: "None" },
      },
    });
    assert.equal(resultFailureTag(endedDirectCommand), "InactiveActor");
    assert.deepEqual(endedDirectDurable, {
      commandReceiptRows: 0,
      auditRows: 0,
      outboxRows: 0,
      outboxCommandRows: 0,
    });
    assert.deepEqual(crossRuleMatchingScopeIds, [ids.rules.crossDepartment]);
    assert.deepEqual(crossRuleOtherScopeIds, []);
    assert.equal(resultFailureTag(crossDepartmentCommand), "ReceiptAuthorityDenied");
    assert.deepEqual(crossDepartmentDurable, {
      commandReceiptRows: 0,
      auditRows: 0,
      outboxRows: 0,
      outboxCommandRows: 0,
    });

    return {
      rule: {
        startAt: activeStart,
        endAt: exactEnd,
        beforeInstant: justBeforeExactEnd,
        beforeApplicableRuleIds: endedRuleBeforeIds,
        exactInstant: exactEnd,
        exactApplicableRuleIds: endedRuleExactIds,
        commandFailureTag: resultFailureTag(endedRuleCommand),
        durable: endedRuleDurable,
      },
      directAuthority: {
        endAt: exactEnd,
        beforeInstant: justBeforeExactEnd,
        before: directBefore.directPaymentAuthorities,
        beforeMappingTag: directBefore.mapped._tag,
        exactInstant: exactEnd,
        exact: directExact.directPaymentAuthorities,
        exactMappingTag: directExact.mapped._tag,
        commandFailureTag: resultFailureTag(endedDirectCommand),
        durable: endedDirectDurable,
      },
      crossDepartment: {
        ruleDepartmentId: ids.departments.alpha,
        requestedDepartmentId: ids.departments.beta,
        matchingScopeRuleIds: crossRuleMatchingScopeIds,
        requestedScopeRuleIds: crossRuleOtherScopeIds,
        commandFailureTag: resultFailureTag(crossDepartmentCommand),
        durable: crossDepartmentDurable,
      },
    };
  }).pipe(Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-boundaries`)));

const proveDirectAuthorityPhantomProtocol = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const economyInsertFirst = yield* Effect.gen(function* () {
        const writerPaused = yield* Deferred.make<void>();
        const resumeWriter = yield* Deferred.make<void>();
        const commandAttempted = yield* Deferred.make<void>();
        const writerStarted = yield* Deferred.make<ConnectionStamp>();
        const commandStarted = yield* Deferred.make<ConnectionStamp>();
        const writerTrace = makeSqlTrace();
        const commandTrace = makeSqlTrace();
        const before = yield* submissionCompositionFacts(
          ids.persons.phantomEconomy,
          exactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-economy-before`),
          ),
        );
        assert.deepEqual(before.applicableRuleIds, []);
        assert.equal(before.directPaymentAuthorities.length, 0);
        assert.deepEqual(before.mapped, {
          _tag: "Failure",
          failureTag: "ReceiptAuthorityDenied",
        });

        const writerFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(writerStarted, started);
            const observed = observeSql(sql, writerTrace, {
              pauseAfter: {
                phase: "direct-payment-insert",
                ready: writerPaused,
                resume: resumeWriter,
              },
            });
            const created = yield* createReceiptPaymentAuthority({
              paymentAuthorityId: ReceiptPaymentAuthorityId.make(
                ids.directAuthorities.phantomEconomyPayment,
              ),
              personId: personId(ids.persons.phantomEconomy),
              departmentId: departmentId(ids.departments.alpha),
              paymentAccountCiphertext: "ciphertext:proof:phantom-economy",
              startAt: activeStart,
              endAt: null,
            }).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, created };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-economy-writer`),
            ),
          ),
        );
        yield* Deferred.await(writerPaused);

        const commandFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(commandStarted, started);
            const observed = observeSql(sql, commandTrace, {
              signalBefore: {
                phase: "person-authorization-lock",
                deferred: commandAttempted,
              },
            });
            const value = yield* executeReceiptCommand(
              submitCommand(
                ids.commands.phantomEconomyInsert,
                ids.departments.alpha,
                "phantom-economy-insert",
              ),
              principal(ids.persons.phantomEconomy, exactEnd),
              allocation(
                generatedReceiptIds.phantomEconomyInsert,
                generatedVisualIds.phantomEconomyInsert,
              ),
            ).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, value };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-economy-command`),
            ),
          ),
        );
        yield* Deferred.await(commandAttempted);
        const writerStamp = yield* Deferred.await(writerStarted);
        const commandStamp = yield* Deferred.await(commandStarted);
        assert.notEqual(writerStamp.pid, commandStamp.pid);
        const writerAtBlock = {
          attempted: [...writerTrace.attempted],
          completed: [...writerTrace.completed],
        };
        const commandAtBlock = {
          attempted: [...commandTrace.attempted],
          completed: [...commandTrace.completed],
        };
        const locks = yield* observeBlockingAndLocks({
          databaseUrl,
          blockedPid: commandStamp.pid,
          blockerPid: writerStamp.pid,
          personId: ids.persons.phantomEconomy,
          commandId: ids.commands.phantomEconomyInsert,
          applicationName: `${proofApplicationPrefix}-phantom-economy-observer`,
        });
        assert.equal(locks.blocked.waitEventType, "Lock");
        assert.ok(locks.blocked.blockingPids.includes(writerStamp.pid));
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            writerStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            true,
          ),
        );
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            commandStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            false,
          ),
        );
        assert.ok(
          hasRelationLock(
            locks.relationLocks,
            writerStamp.pid,
            "public.economy_payment_authorities",
            "RowExclusiveLock",
          ),
        );
        assert.equal(commandAtBlock.attempted.at(-1), "person-authorization-lock");
        yield* Deferred.succeed(resumeWriter, undefined);
        const writer = yield* Fiber.join(writerFiber);
        const command = yield* Fiber.join(commandFiber);
        assert.equal(writer.created.revision, 0);
        assertSubsequence(writerTrace.completed, [
          "person-authorization-lock",
          "direct-payment-insert",
        ]);
        assertSubsequence(commandTrace.completed, [
          "person-authorization-lock",
          "organization-authority-projection",
          "direct-receipt-authority-projection",
          "authz-shared-lock",
          "authz-tag-assignment-projection",
          "authz-rule-projection",
          "durable-audit-insert",
        ]);

        const afterInsert = yield* submissionCompositionFacts(
          ids.persons.phantomEconomy,
          exactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-economy-after`),
          ),
        );
        assert.deepEqual(afterInsert.applicableRuleIds, []);
        assert.deepEqual(afterInsert.composedPaymentAuthorityIds, [
          ids.directAuthorities.phantomEconomyPayment,
        ]);
        assert.equal(afterInsert.mapped._tag, "Success");
        const cleanup = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const durable = yield* readDurableCommandFacts(sql, ids.commands.phantomEconomyInsert);
          const removed = yield* removeReceiptPaymentAuthority({
            paymentAuthorityId: ReceiptPaymentAuthorityId.make(
              ids.directAuthorities.phantomEconomyPayment,
            ),
            expectedRevision: 0,
          });
          const [remaining] = yield* sql<{ readonly count: number }>`
            SELECT count(*)::integer AS count
            FROM public.economy_payment_authorities
            WHERE payment_authority_id = ${ids.directAuthorities.phantomEconomyPayment}
          `;
          assert(remaining);
          return {
            durable,
            removed: {
              paymentAuthorityId: removed.paymentAuthorityId,
              revision: removed.revision,
            },
            remainingRows: remaining.count,
          };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-economy-cleanup`),
          ),
        );
        assert.deepEqual(cleanup.durable, {
          commandReceiptRows: 1,
          auditRows: 1,
          outboxRows: 3,
          outboxCommandRows: 1,
        });
        assert.equal(cleanup.remainingRows, 0);

        return {
          order: "WriterInsertFirst" as const,
          before,
          participants: {
            writer: writer.started,
            writerCompleted: writer.completed,
            command: command.started,
            commandCompleted: command.completed,
            independentBackendPids: writer.started.pid !== command.started.pid,
          },
          blocked: locks.blocked,
          relationLocks: locks.relationLocks,
          advisoryLocks: locks.advisoryLocks,
          sqlOrderAtBlock: { writer: writerAtBlock, command: commandAtBlock },
          sqlOrderAfterCommit: { writer: writerTrace, command: commandTrace },
          createdAuthority: {
            paymentAuthorityId: writer.created.paymentAuthorityId,
            personId: writer.created.personId,
            departmentId: writer.created.departmentId,
            startAt: writer.created.startAt,
            endAt: writer.created.endAt,
            revision: writer.created.revision,
          },
          visibleComposition: afterInsert,
          commandObservation: command.value.observation,
          cleanup,
        };
      });

      const organizationLifecycle = yield* Effect.gen(function* () {
        const approvalGrant = yield* createReceiptApprovalGrant({
          approvalGrantId: ReceiptApprovalGrantId.make(
            ids.directAuthorities.phantomOrganizationApproval,
          ),
          personId: personId(ids.persons.phantomOrganization),
          scope: { _tag: "Global" },
          startAt: activeStart,
          endAt: null,
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-approval-setup`),
          ),
        );
        const before = yield* approvalCompositionFacts(
          ids.persons.phantomOrganization,
          exactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-before`),
          ),
        );
        assert.deepEqual(before.applicableRuleIds, []);
        assert.equal(before.directApprovalGrants[0]?.active, false);
        assert.equal(before.mapped._tag, "Success");
        if (before.mapped._tag === "Success") assert.equal(before.mapped.actor.active, false);

        const writerPaused = yield* Deferred.make<void>();
        const resumeWriter = yield* Deferred.make<void>();
        const commandAttempted = yield* Deferred.make<void>();
        const writerStarted = yield* Deferred.make<ConnectionStamp>();
        const commandStarted = yield* Deferred.make<ConnectionStamp>();
        const insertWriterTrace = makeSqlTrace();
        const insertCommandTrace = makeSqlTrace();
        const insertWriterFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(writerStarted, started);
            const observed = observeSql(sql, insertWriterTrace, {
              pauseAfter: {
                phase: "organization-administrator-insert",
                ready: writerPaused,
                resume: resumeWriter,
              },
            });
            const created = yield* createOrganizationGlobalAdministratorGrant({
              grantId: OrganizationGlobalAdministratorGrantId.make(
                ids.directAuthorities.phantomOrganizationAdministrator,
              ),
              personId: personId(ids.persons.phantomOrganization),
              startAt: activeStart,
              endAt: null,
            }).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, created };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-insert-writer`),
            ),
          ),
        );
        yield* Deferred.await(writerPaused);

        const insertCommandFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(commandStarted, started);
            const observed = observeSql(sql, insertCommandTrace, {
              signalBefore: {
                phase: "person-authorization-lock",
                deferred: commandAttempted,
              },
            });
            const value = yield* executeReceiptCommand(
              {
                _tag: "RejectReceipt",
                commandId: ids.commands.phantomOrganizationInsert,
                receiptId: ReceiptId.make(ids.receipts.phantomOrganizationInsert),
                expectedRevision: 0,
              },
              principal(ids.persons.phantomOrganization, exactEnd),
            ).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, value };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-insert-command`),
            ),
          ),
        );
        yield* Deferred.await(commandAttempted);
        const insertWriterStamp = yield* Deferred.await(writerStarted);
        const insertCommandStamp = yield* Deferred.await(commandStarted);
        assert.notEqual(insertWriterStamp.pid, insertCommandStamp.pid);
        const insertWriterAtBlock = {
          attempted: [...insertWriterTrace.attempted],
          completed: [...insertWriterTrace.completed],
        };
        const insertCommandAtBlock = {
          attempted: [...insertCommandTrace.attempted],
          completed: [...insertCommandTrace.completed],
        };
        const insertLocks = yield* observeBlockingAndLocks({
          databaseUrl,
          blockedPid: insertCommandStamp.pid,
          blockerPid: insertWriterStamp.pid,
          personId: ids.persons.phantomOrganization,
          commandId: ids.commands.phantomOrganizationInsert,
          applicationName: `${proofApplicationPrefix}-phantom-org-insert-observer`,
        });
        assert.equal(insertLocks.blocked.waitEventType, "Lock");
        assert.ok(insertLocks.blocked.blockingPids.includes(insertWriterStamp.pid));
        assert.ok(
          hasAdvisoryLock(
            insertLocks.advisoryLocks,
            insertWriterStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            true,
          ),
        );
        assert.ok(
          hasAdvisoryLock(
            insertLocks.advisoryLocks,
            insertCommandStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            false,
          ),
        );
        assert.ok(
          hasRelationLock(
            insertLocks.relationLocks,
            insertWriterStamp.pid,
            "public.organization_global_administrator_grants",
            "RowExclusiveLock",
          ),
        );
        yield* Deferred.succeed(resumeWriter, undefined);
        const insertWriter = yield* Fiber.join(insertWriterFiber);
        const insertCommand = yield* Fiber.join(insertCommandFiber);
        assertSubsequence(insertWriterTrace.completed, [
          "person-authorization-lock",
          "organization-administrator-insert",
        ]);
        assertSubsequence(insertCommandTrace.completed, [
          "person-authorization-lock",
          "organization-authority-projection",
          "direct-receipt-authority-projection",
          "authz-shared-lock",
          "authz-tag-assignment-projection",
          "authz-rule-projection",
          "durable-audit-insert",
        ]);
        const afterInsert = yield* approvalCompositionFacts(
          ids.persons.phantomOrganization,
          exactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-after-insert`),
          ),
        );
        assert.equal(afterInsert.directApprovalGrants[0]?.active, true);
        assert.equal(afterInsert.mapped._tag, "Success");
        if (afterInsert.mapped._tag === "Success")
          assert.equal(afterInsert.mapped.actor.active, true);

        const commandReady = yield* Deferred.make<void>();
        const resumeCommand = yield* Deferred.make<void>();
        const endWriterAttempted = yield* Deferred.make<void>();
        const endCommandStarted = yield* Deferred.make<ConnectionStamp>();
        const endWriterStarted = yield* Deferred.make<ConnectionStamp>();
        const endCommandTrace = makeSqlTrace();
        const endWriterTrace = makeSqlTrace();
        const endCommandFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(endCommandStarted, started);
            const observed = observeSql(sql, endCommandTrace, {
              pauseAfter: {
                phase: "durable-audit-insert",
                ready: commandReady,
                resume: resumeCommand,
              },
            });
            const value = yield* executeReceiptCommand(
              {
                _tag: "RejectReceipt",
                commandId: ids.commands.phantomOrganizationRemove,
                receiptId: ReceiptId.make(ids.receipts.phantomOrganizationRemove),
                expectedRevision: 0,
              },
              principal(ids.persons.phantomOrganization, exactEnd),
            ).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, value };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-end-command`),
            ),
          ),
        );
        yield* Deferred.await(commandReady);

        const endWriterFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(endWriterStarted, started);
            const observed = observeSql(sql, endWriterTrace, {
              signalBefore: {
                phase: "person-authorization-lock",
                deferred: endWriterAttempted,
              },
            });
            const ended = yield* endOrganizationGlobalAdministratorGrant({
              grantId: OrganizationGlobalAdministratorGrantId.make(
                ids.directAuthorities.phantomOrganizationAdministrator,
              ),
              endAt: exactEnd,
              expectedRevision: 0,
            }).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, ended };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-end-writer`),
            ),
          ),
        );
        yield* Deferred.await(endWriterAttempted);
        const endCommandStamp = yield* Deferred.await(endCommandStarted);
        const endWriterStamp = yield* Deferred.await(endWriterStarted);
        assert.notEqual(endCommandStamp.pid, endWriterStamp.pid);
        const endCommandAtBlock = {
          attempted: [...endCommandTrace.attempted],
          completed: [...endCommandTrace.completed],
        };
        const endWriterAtBlock = {
          attempted: [...endWriterTrace.attempted],
          completed: [...endWriterTrace.completed],
        };
        const endLocks = yield* observeBlockingAndLocks({
          databaseUrl,
          blockedPid: endWriterStamp.pid,
          blockerPid: endCommandStamp.pid,
          personId: ids.persons.phantomOrganization,
          commandId: ids.commands.phantomOrganizationRemove,
          applicationName: `${proofApplicationPrefix}-phantom-org-end-observer`,
        });
        assert.equal(endLocks.blocked.waitEventType, "Lock");
        assert.ok(endLocks.blocked.blockingPids.includes(endCommandStamp.pid));
        assert.ok(
          hasAdvisoryLock(
            endLocks.advisoryLocks,
            endCommandStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            true,
          ),
        );
        assert.ok(
          hasAdvisoryLock(
            endLocks.advisoryLocks,
            endWriterStamp.pid,
            "person-authorization",
            "ExclusiveLock",
            false,
          ),
        );
        assert.equal(endWriterAtBlock.attempted.at(-1), "person-authorization-lock");
        yield* Deferred.succeed(resumeCommand, undefined);
        const endCommand = yield* Fiber.join(endCommandFiber);
        const endWriter = yield* Fiber.join(endWriterFiber);
        assert.equal(endWriter.ended.endAt, exactEnd);
        assert.equal(endWriter.ended.revision, 1);
        assertSubsequence(endWriterTrace.completed, [
          "person-authorization-lock",
          "organization-administrator-end",
        ]);

        const afterEnd = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const beforeExact = yield* resolveOrganizationPersonAuthorityForRead(
            personId(ids.persons.phantomOrganization),
            justBeforeExactEnd,
          );
          const atExact = yield* resolveOrganizationPersonAuthorityForRead(
            personId(ids.persons.phantomOrganization),
            exactEnd,
          );
          const insertDurable = yield* readDurableCommandFacts(
            sql,
            ids.commands.phantomOrganizationInsert,
          );
          const endDurable = yield* readDurableCommandFacts(
            sql,
            ids.commands.phantomOrganizationRemove,
          );
          const fresh = yield* Effect.result(
            executeReceiptCommand(
              {
                _tag: "RejectReceipt",
                commandId: ids.commands.phantomOrganizationFresh,
                receiptId: ReceiptId.make(ids.receipts.phantomOrganizationFresh),
                expectedRevision: 0,
              },
              principal(ids.persons.phantomOrganization, exactEnd),
            ),
          );
          const freshDurable = yield* readDurableCommandFacts(
            sql,
            ids.commands.phantomOrganizationFresh,
          );
          const removedAdministrator = yield* removeOrganizationGlobalAdministratorGrant({
            grantId: OrganizationGlobalAdministratorGrantId.make(
              ids.directAuthorities.phantomOrganizationAdministrator,
            ),
            expectedRevision: 1,
          });
          const removedApproval = yield* removeReceiptApprovalGrant({
            approvalGrantId: ReceiptApprovalGrantId.make(
              ids.directAuthorities.phantomOrganizationApproval,
            ),
            expectedRevision: 0,
          });
          const [remaining] = yield* sql<{
            readonly administrators: number;
            readonly approvals: number;
          }>`
            SELECT
              (
                SELECT count(*)::integer
                FROM public.organization_global_administrator_grants
                WHERE grant_id = ${ids.directAuthorities.phantomOrganizationAdministrator}
              ) AS administrators,
              (
                SELECT count(*)::integer
                FROM public.economy_receipt_approval_grants
                WHERE approval_grant_id = ${ids.directAuthorities.phantomOrganizationApproval}
              ) AS approvals
          `;
          assert(remaining);
          return {
            beforeExactGlobalAdministrator: beforeExact.globalAdministrator,
            exactGlobalAdministrator: atExact.globalAdministrator,
            insertDurable,
            endDurable,
            freshFailureTag: resultFailureTag(fresh),
            freshDurable,
            removedAdministrator: {
              grantId: removedAdministrator.grantId,
              endAt: removedAdministrator.endAt,
              revision: removedAdministrator.revision,
            },
            removedApproval: {
              approvalGrantId: removedApproval.approvalGrantId,
              revision: removedApproval.revision,
            },
            remaining,
          };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-phantom-org-after-end`),
          ),
        );
        assert.equal(afterEnd.beforeExactGlobalAdministrator, "Active");
        assert.equal(afterEnd.exactGlobalAdministrator, "Inactive");
        assert.deepEqual(afterEnd.insertDurable, {
          commandReceiptRows: 1,
          auditRows: 1,
          outboxRows: 2,
          outboxCommandRows: 1,
        });
        assert.deepEqual(afterEnd.endDurable, {
          commandReceiptRows: 1,
          auditRows: 1,
          outboxRows: 2,
          outboxCommandRows: 1,
        });
        assert.equal(afterEnd.freshFailureTag, "InactiveActor");
        assert.deepEqual(afterEnd.freshDurable, {
          commandReceiptRows: 0,
          auditRows: 0,
          outboxRows: 0,
          outboxCommandRows: 0,
        });
        assert.deepEqual(afterEnd.remaining, { administrators: 0, approvals: 0 });

        return {
          setupApprovalGrant: {
            approvalGrantId: approvalGrant.approvalGrantId,
            personId: approvalGrant.personId,
            scope: approvalGrant.scope,
            startAt: approvalGrant.startAt,
            endAt: approvalGrant.endAt,
            revision: approvalGrant.revision,
          },
          before,
          insertFirst: {
            order: "WriterInsertFirst" as const,
            participants: {
              writer: insertWriter.started,
              writerCompleted: insertWriter.completed,
              command: insertCommand.started,
              commandCompleted: insertCommand.completed,
              independentBackendPids: insertWriter.started.pid !== insertCommand.started.pid,
            },
            blocked: insertLocks.blocked,
            relationLocks: insertLocks.relationLocks,
            advisoryLocks: insertLocks.advisoryLocks,
            sqlOrderAtBlock: {
              writer: insertWriterAtBlock,
              command: insertCommandAtBlock,
            },
            sqlOrderAfterCommit: {
              writer: insertWriterTrace,
              command: insertCommandTrace,
            },
            createdAdministrator: {
              grantId: insertWriter.created.grantId,
              personId: insertWriter.created.personId,
              startAt: insertWriter.created.startAt,
              endAt: insertWriter.created.endAt,
              revision: insertWriter.created.revision,
            },
            visibleComposition: afterInsert,
            commandObservation: insertCommand.value.observation,
          },
          commandFirstEnd: {
            order: "CommandFirst" as const,
            instant: exactEnd,
            participants: {
              command: endCommand.started,
              commandCompleted: endCommand.completed,
              writer: endWriter.started,
              writerCompleted: endWriter.completed,
              independentBackendPids: endCommand.started.pid !== endWriter.started.pid,
            },
            blocked: endLocks.blocked,
            relationLocks: endLocks.relationLocks,
            advisoryLocks: endLocks.advisoryLocks,
            sqlOrderAtBlock: {
              command: endCommandAtBlock,
              writer: endWriterAtBlock,
            },
            sqlOrderAfterCommit: {
              command: endCommandTrace,
              writer: endWriterTrace,
            },
            commandObservation: endCommand.value.observation,
            endedAdministrator: {
              grantId: endWriter.ended.grantId,
              endAt: endWriter.ended.endAt,
              revision: endWriter.ended.revision,
            },
          },
          afterEndAndRemoval: afterEnd,
        };
      });

      return { economyInsertFirst, organizationLifecycle };
    }),
  );

const proveDirectAuthorityRowLock = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandReady = yield* Deferred.make<void>();
      const resumeCommand = yield* Deferred.make<void>();
      const writerAttempted = yield* Deferred.make<void>();
      const commandTrace = makeSqlTrace();
      const writerTrace = makeSqlTrace();
      const composition = yield* approvalCompositionFacts(
        ids.persons.ruleApprove,
        justBeforeExactEnd,
        ids.departments.alpha,
      ).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-composition`),
        ),
      );
      assert.deepEqual(composition.applicableRuleIds, [ids.rules.approve]);
      assert.equal(composition.directApprovalGrants[0]?.active, false);
      assert.equal(composition.mapped._tag, "Success");

      const commandFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, commandTrace, {
            pauseAfter: {
              phase: "durable-audit-insert",
              ready: commandReady,
              resume: resumeCommand,
            },
          });
          const value = yield* executeReceiptCommand(
            {
              _tag: "RejectReceipt",
              commandId: ids.commands.approveLock,
              receiptId: ReceiptId.make(ids.receipts.approveLock),
              expectedRevision: 0,
            },
            principal(ids.persons.ruleApprove, justBeforeExactEnd),
          ).pipe(Effect.provideService(Database, observed));
          const completed = yield* connectionStamp(sql);
          return { started, completed, value };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-command`),
          ),
        ),
      );
      yield* Deferred.await(commandReady);

      const writerFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, writerTrace);
          const rows = yield* observed.withTransaction(
            Deferred.succeed(writerAttempted, undefined).pipe(
              Effect.andThen(observed<{ readonly revision: number }>`
                UPDATE public.economy_receipt_approval_grants
                SET revision = revision + 1
                WHERE approval_grant_id = ${ids.directAuthorities.inactiveRuleApprove}
                RETURNING revision
              `),
            ),
          );
          const completed = yield* connectionStamp(sql);
          return { started, completed, rows };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-writer`),
          ),
        ),
      );
      yield* Deferred.await(writerAttempted);

      const commandStartStamp = yield* Effect.gen(function* () {
        const sql = yield* Database;
        return yield* sql<{ readonly pid: number }>`
          SELECT pid
          FROM pg_catalog.pg_stat_activity
          WHERE application_name = ${`${proofApplicationPrefix}-direct-lock-command`}
        `;
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-pid-observer`),
        ),
      );
      const writerStartStamp = yield* Effect.gen(function* () {
        const sql = yield* Database;
        return yield* sql<{ readonly pid: number }>`
          SELECT pid
          FROM pg_catalog.pg_stat_activity
          WHERE application_name = ${`${proofApplicationPrefix}-direct-lock-writer`}
        `;
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-writer-pid-observer`),
        ),
      );
      const commandPid = commandStartStamp[0]?.pid;
      const writerPid = writerStartStamp[0]?.pid;
      assert.equal(typeof commandPid, "number");
      assert.equal(typeof writerPid, "number");
      assert.notEqual(commandPid, writerPid);
      const lockObservation = yield* observeBlockingAndLocks({
        databaseUrl,
        blockedPid: writerPid!,
        blockerPid: commandPid!,
        personId: ids.persons.ruleApprove,
        commandId: ids.commands.approveLock,
        applicationName: `${proofApplicationPrefix}-direct-lock-observer`,
      });
      assert.equal(lockObservation.blocked.waitEventType, "Lock");
      assert.ok(lockObservation.blocked.blockingPids.includes(commandPid!));
      assert.ok(
        hasRelationLock(
          lockObservation.relationLocks,
          commandPid!,
          "public.economy_receipt_approval_grants",
          "RowShareLock",
        ),
      );
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          commandPid!,
          "person-authorization",
          "ExclusiveLock",
          true,
        ),
      );
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          commandPid!,
          "authorization-rules",
          "ShareLock",
          true,
        ),
      );
      const commandAtBlock = {
        attempted: [...commandTrace.attempted],
        completed: [...commandTrace.completed],
      };
      const writerAtBlock = {
        attempted: [...writerTrace.attempted],
        completed: [...writerTrace.completed],
      };
      yield* Deferred.succeed(resumeCommand, undefined);
      const command = yield* Fiber.join(commandFiber);
      const writer = yield* Fiber.join(writerFiber);
      assert.equal(command.started.pid, commandPid);
      assert.equal(writer.started.pid, writerPid);
      assert.equal(writer.rows[0]?.revision, 1);
      assertSubsequence(commandTrace.completed, [
        "command-receipt-lock",
        "receipt-target-lock",
        "person-authorization-lock",
        "organization-authority-projection",
        "direct-receipt-authority-projection",
        "authz-shared-lock",
        "authz-tag-assignment-projection",
        "authz-rule-projection",
        "durable-audit-insert",
      ]);
      const durable = yield* Effect.gen(function* () {
        const sql = yield* Database;
        return yield* readDurableCommandFacts(sql, ids.commands.approveLock);
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-direct-lock-durable`),
        ),
      );
      assert.deepEqual(durable, {
        commandReceiptRows: 1,
        auditRows: 1,
        outboxRows: 2,
        outboxCommandRows: 1,
      });
      return {
        composition,
        participants: {
          command: command.started,
          commandCompleted: command.completed,
          writer: writer.started,
          writerCompleted: writer.completed,
          independentBackendPids: commandPid !== writerPid,
        },
        blocked: lockObservation.blocked,
        relationLocks: lockObservation.relationLocks,
        advisoryLocks: lockObservation.advisoryLocks,
        sqlOrderAtBlock: { command: commandAtBlock, writer: writerAtBlock },
        sqlOrderAfterCommit: { command: commandTrace, writer: writerTrace },
        writerRevision: writer.rows[0]?.revision ?? -1,
        observation: command.value.observation,
        durable,
      };
    }),
  );

const proveCommandFirstRuleRemoval = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandReady = yield* Deferred.make<void>();
      const resumeCommand = yield* Deferred.make<void>();
      const writerAttempted = yield* Deferred.make<void>();
      const commandTrace = makeSqlTrace();
      const writerTrace = makeSqlTrace();
      const composition = yield* submissionCompositionFacts(
        ids.persons.ruleSubmit,
        exactEnd,
        ids.departments.alpha,
      ).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-rule-removal-composition`),
        ),
      );
      assert.deepEqual(composition.applicableRuleIds, [ids.rules.submit]);
      assert.equal(composition.directPaymentAuthorities[0]?.active, false);
      assert.equal(composition.mapped._tag, "Success");

      const commandFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, commandTrace, {
            pauseAfter: {
              phase: "durable-audit-insert",
              ready: commandReady,
              resume: resumeCommand,
            },
          });
          const value = yield* executeReceiptCommand(
            submitCommand(ids.commands.ruleSubmit, ids.departments.alpha, "rule-submit"),
            principal(ids.persons.ruleSubmit, exactEnd),
            allocation(generatedReceiptIds.ruleSubmit, generatedVisualIds.ruleSubmit),
          ).pipe(Effect.provideService(Database, observed));
          const completed = yield* connectionStamp(sql);
          return { started, completed, value };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-rule-removal-command`),
          ),
        ),
      );
      yield* Deferred.await(commandReady);

      const writerFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, writerTrace, {
            signalBefore: { phase: "authz-exclusive-lock", deferred: writerAttempted },
          });
          yield* removeAuthzRule({
            ruleId: AuthzRuleId.make(ids.rules.submit),
            expectedRevision: 0,
          }).pipe(Effect.provideService(Database, observed));
          const completed = yield* connectionStamp(sql);
          return { started, completed };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-rule-removal-writer`),
          ),
        ),
      );
      yield* Deferred.await(writerAttempted);

      const commandAtBlock = {
        attempted: [...commandTrace.attempted],
        completed: [...commandTrace.completed],
      };
      const writerAtBlock = {
        attempted: [...writerTrace.attempted],
        completed: [...writerTrace.completed],
      };
      const participantPids = yield* Effect.gen(function* () {
        const sql = yield* Database;
        return yield* sql<{ readonly applicationName: string; readonly pid: number }>`
          SELECT application_name AS "applicationName", pid
          FROM pg_catalog.pg_stat_activity
          WHERE application_name IN (
            ${`${proofApplicationPrefix}-rule-removal-command`},
            ${`${proofApplicationPrefix}-rule-removal-writer`}
          )
          ORDER BY application_name ASC
        `;
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-rule-removal-pid-observer`),
        ),
      );
      const commandPid = participantPids.find((row) =>
        row.applicationName.endsWith("rule-removal-command"),
      )?.pid;
      const writerPid = participantPids.find((row) =>
        row.applicationName.endsWith("rule-removal-writer"),
      )?.pid;
      assert.equal(typeof commandPid, "number");
      assert.equal(typeof writerPid, "number");
      assert.notEqual(commandPid, writerPid);
      const lockObservation = yield* observeBlockingAndLocks({
        databaseUrl,
        blockedPid: writerPid!,
        blockerPid: commandPid!,
        personId: ids.persons.ruleSubmit,
        commandId: ids.commands.ruleSubmit,
        applicationName: `${proofApplicationPrefix}-rule-removal-observer`,
      });
      assert.equal(lockObservation.blocked.waitEventType, "Lock");
      assert.ok(lockObservation.blocked.blockingPids.includes(commandPid!));
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          commandPid!,
          "authorization-rules",
          "ShareLock",
          true,
        ),
      );
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          writerPid!,
          "authorization-rules",
          "ExclusiveLock",
          false,
        ),
      );
      assert.ok(
        hasRelationLock(
          lockObservation.relationLocks,
          commandPid!,
          "public.authz_tag_assignments",
          "RowShareLock",
        ),
      );
      assert.ok(
        hasRelationLock(
          lockObservation.relationLocks,
          commandPid!,
          "public.authz_rules",
          "RowShareLock",
        ),
      );
      yield* Deferred.succeed(resumeCommand, undefined);
      const command = yield* Fiber.join(commandFiber);
      const writer = yield* Fiber.join(writerFiber);
      assert.equal(command.started.pid, commandPid);
      assert.equal(writer.started.pid, writerPid);
      assertSubsequence(commandTrace.completed, [
        "person-authorization-lock",
        "organization-authority-projection",
        "direct-receipt-authority-projection",
        "authz-shared-lock",
        "authz-tag-assignment-projection",
        "authz-rule-projection",
        "durable-audit-insert",
      ]);
      assertSubsequence(writerTrace.completed, ["authz-exclusive-lock", "remove-rule"]);

      const replayAndFresh = yield* Effect.gen(function* () {
        const sql = yield* Database;
        const beforeReplay = yield* readDurableCommandFacts(sql, ids.commands.ruleSubmit);
        const [stored] = yield* sql<{ readonly observationJson: unknown }>`
          SELECT observation_json AS "observationJson"
          FROM public.economy_receipt_command_receipts
          WHERE command_id = ${ids.commands.ruleSubmit}
        `;
        assert(stored);
        const replay = yield* executeReceiptCommand(
          submitCommand(ids.commands.ruleSubmit, ids.departments.alpha, "rule-submit"),
          principal(ids.persons.ruleSubmit, exactEnd),
          allocation(generatedReceiptIds.ruleSubmit, generatedVisualIds.ruleSubmit),
        );
        const afterReplay = yield* readDurableCommandFacts(sql, ids.commands.ruleSubmit);
        const freshCommand = submitCommand(
          ids.commands.ruleSubmitFresh,
          ids.departments.alpha,
          "rule-submit",
        );
        const fresh = yield* Effect.result(
          executeReceiptCommand(
            freshCommand,
            principal(ids.persons.ruleSubmit, exactEnd),
            allocation(generatedReceiptIds.ruleSubmitFresh, generatedVisualIds.ruleSubmitFresh),
          ),
        );
        const freshDurable = yield* readDurableCommandFacts(sql, ids.commands.ruleSubmitFresh);
        const [ruleCount] = yield* sql<{ readonly count: number }>`
          SELECT count(*)::integer AS count
          FROM public.authz_rules
          WHERE rule_id = ${ids.rules.submit}
        `;
        assert(ruleCount);
        const replayComparable = { ...replay.observation, replayed: false };
        return {
          beforeReplay,
          storedObservation: stored.observationJson,
          replayObservation: replay.observation,
          replayed: replay.replayed,
          replayOutboxCount: replay.outboxCount,
          storedObservationFieldsEqual:
            canonicalJson(replayComparable) === canonicalJson(stored.observationJson),
          afterReplay,
          freshCommandFailureTag: resultFailureTag(fresh),
          freshDurable,
          sameSemanticPayloadExceptCommandId:
            canonicalJson({
              ...submitCommand(ids.commands.ruleSubmit, ids.departments.alpha, "rule-submit"),
              commandId: "[COMMAND]",
            }) === canonicalJson({ ...freshCommand, commandId: "[COMMAND]" }),
          remainingRuleRows: ruleCount.count,
        };
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-rule-removal-replay`),
        ),
      );
      assert.equal(replayAndFresh.replayed, true);
      assert.equal(replayAndFresh.replayOutboxCount, 0);
      assert.equal(replayAndFresh.storedObservationFieldsEqual, true);
      assert.deepEqual(replayAndFresh.beforeReplay, replayAndFresh.afterReplay);
      assert.equal(replayAndFresh.freshCommandFailureTag, "InactiveActor");
      assert.deepEqual(replayAndFresh.freshDurable, {
        commandReceiptRows: 0,
        auditRows: 0,
        outboxRows: 0,
        outboxCommandRows: 0,
      });
      assert.equal(replayAndFresh.sameSemanticPayloadExceptCommandId, true);
      assert.equal(replayAndFresh.remainingRuleRows, 0);

      return {
        composition,
        participants: {
          command: command.started,
          commandCompleted: command.completed,
          writer: writer.started,
          writerCompleted: writer.completed,
          independentBackendPids: commandPid !== writerPid,
        },
        blocked: lockObservation.blocked,
        relationLocks: lockObservation.relationLocks,
        advisoryLocks: lockObservation.advisoryLocks,
        sqlOrderAtBlock: { command: commandAtBlock, writer: writerAtBlock },
        sqlOrderAfterCommit: { command: commandTrace, writer: writerTrace },
        acceptedObservation: command.value.observation,
        acceptedDurable: replayAndFresh.beforeReplay,
        replayAndFresh,
      };
    }),
  );

const proveRuleExpiryRaces = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandFirst = yield* Effect.gen(function* () {
        const commandReady = yield* Deferred.make<void>();
        const resumeCommand = yield* Deferred.make<void>();
        const writerAttempted = yield* Deferred.make<void>();
        const commandStarted = yield* Deferred.make<ConnectionStamp>();
        const writerStarted = yield* Deferred.make<ConnectionStamp>();
        const commandTrace = makeSqlTrace();
        const writerTrace = makeSqlTrace();
        const before = yield* submissionCompositionFacts(
          ids.persons.expiryCommandFirst,
          exactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-cf-before`)),
        );
        assert.deepEqual(before.applicableRuleIds, [ids.rules.expiryCommandFirst]);
        assert.deepEqual(before.contributingRuleIds, [ids.rules.expiryCommandFirst]);
        assert.equal(before.directPaymentAuthorities.length, 0);
        assert.equal(before.mapped._tag, "Success");

        const commandFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(commandStarted, started);
            const observed = observeSql(sql, commandTrace, {
              pauseAfter: {
                phase: "durable-audit-insert",
                ready: commandReady,
                resume: resumeCommand,
              },
            });
            const value = yield* executeReceiptCommand(
              submitCommand(
                ids.commands.expiryCommandFirst,
                ids.departments.alpha,
                "expiry-command-first",
              ),
              principal(ids.persons.expiryCommandFirst, exactEnd),
              allocation(
                generatedReceiptIds.expiryCommandFirst,
                generatedVisualIds.expiryCommandFirst,
              ),
            ).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, value };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-cf-command`),
            ),
          ),
        );
        yield* Deferred.await(commandReady);

        const writerFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(writerStarted, started);
            const observed = observeSql(sql, writerTrace, {
              signalBefore: { phase: "authz-exclusive-lock", deferred: writerAttempted },
            });
            const ended = yield* endAuthzRule({
              ruleId: AuthzRuleId.make(ids.rules.expiryCommandFirst),
              endAt: exactEnd,
              expectedRevision: 0,
            }).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, ended };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-cf-writer`),
            ),
          ),
        );
        yield* Deferred.await(writerAttempted);
        const commandStamp = yield* Deferred.await(commandStarted);
        const writerStamp = yield* Deferred.await(writerStarted);
        assert.notEqual(commandStamp.pid, writerStamp.pid);
        const commandAtBlock = {
          attempted: [...commandTrace.attempted],
          completed: [...commandTrace.completed],
        };
        const writerAtBlock = {
          attempted: [...writerTrace.attempted],
          completed: [...writerTrace.completed],
        };
        const locks = yield* observeBlockingAndLocks({
          databaseUrl,
          blockedPid: writerStamp.pid,
          blockerPid: commandStamp.pid,
          personId: ids.persons.expiryCommandFirst,
          commandId: ids.commands.expiryCommandFirst,
          applicationName: `${proofApplicationPrefix}-expiry-cf-observer`,
        });
        assert.equal(locks.blocked.waitEventType, "Lock");
        assert.ok(locks.blocked.blockingPids.includes(commandStamp.pid));
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            commandStamp.pid,
            "authorization-rules",
            "ShareLock",
            true,
          ),
        );
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            writerStamp.pid,
            "authorization-rules",
            "ExclusiveLock",
            false,
          ),
        );
        yield* Deferred.succeed(resumeCommand, undefined);
        const command = yield* Fiber.join(commandFiber);
        const writer = yield* Fiber.join(writerFiber);
        assert.equal(writer.ended.endAt, exactEnd);
        assert.equal(writer.ended.revision, 1);
        assertSubsequence(commandTrace.completed, [
          "person-authorization-lock",
          "organization-authority-projection",
          "direct-receipt-authority-projection",
          "authz-shared-lock",
          "authz-tag-assignment-projection",
          "authz-rule-projection",
          "durable-audit-insert",
        ]);
        assertSubsequence(writerTrace.completed, ["authz-exclusive-lock", "end-rule"]);

        const after = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const beforeExact = yield* loadApplicableAuthorizationRules(
            personId(ids.persons.expiryCommandFirst),
            "submitReceipt",
            justBeforeExactEnd,
            proofReceiptContext(departmentId(ids.departments.alpha)),
          );
          const atExact = yield* loadApplicableAuthorizationRules(
            personId(ids.persons.expiryCommandFirst),
            "submitReceipt",
            exactEnd,
            proofReceiptContext(departmentId(ids.departments.alpha)),
          );
          const acceptedDurable = yield* readDurableCommandFacts(
            sql,
            ids.commands.expiryCommandFirst,
          );
          const fresh = yield* Effect.result(
            executeReceiptCommand(
              submitCommand(
                ids.commands.expiryCommandFirstFresh,
                ids.departments.alpha,
                "expiry-command-first-fresh",
              ),
              principal(ids.persons.expiryCommandFirst, exactEnd),
              allocation(
                generatedReceiptIds.expiryCommandFirstFresh,
                generatedVisualIds.expiryCommandFirstFresh,
              ),
            ),
          );
          const freshDurable = yield* readDurableCommandFacts(
            sql,
            ids.commands.expiryCommandFirstFresh,
          );
          return {
            beforeExactRuleIds: beforeExact.rules.map((rule) => rule.ruleId),
            exactRuleIds: atExact.rules.map((rule) => rule.ruleId),
            acceptedDurable,
            freshFailureTag: resultFailureTag(fresh),
            freshDurable,
          };
        }).pipe(
          Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-cf-after`)),
        );
        assert.deepEqual(after.beforeExactRuleIds, [ids.rules.expiryCommandFirst]);
        assert.deepEqual(after.exactRuleIds, []);
        assert.deepEqual(after.acceptedDurable, {
          commandReceiptRows: 1,
          auditRows: 1,
          outboxRows: 3,
          outboxCommandRows: 1,
        });
        assert.equal(after.freshFailureTag, "ReceiptAuthorityDenied");
        assert.deepEqual(after.freshDurable, {
          commandReceiptRows: 0,
          auditRows: 0,
          outboxRows: 0,
          outboxCommandRows: 0,
        });

        return {
          order: "CommandFirst" as const,
          instant: exactEnd,
          compositionBefore: before,
          participants: {
            command: command.started,
            commandCompleted: command.completed,
            writer: writer.started,
            writerCompleted: writer.completed,
            independentBackendPids: command.started.pid !== writer.started.pid,
          },
          blocked: locks.blocked,
          relationLocks: locks.relationLocks,
          advisoryLocks: locks.advisoryLocks,
          sqlOrderAtBlock: { command: commandAtBlock, writer: writerAtBlock },
          sqlOrderAfterCommit: { command: commandTrace, writer: writerTrace },
          commandObservation: command.value.observation,
          endedRule: {
            ruleId: writer.ended.ruleId,
            endAt: writer.ended.endAt,
            revision: writer.ended.revision,
          },
          ...after,
        };
      });

      const writerFirst = yield* Effect.gen(function* () {
        const writerPaused = yield* Deferred.make<void>();
        const resumeWriter = yield* Deferred.make<void>();
        const commandAttempted = yield* Deferred.make<void>();
        const writerStarted = yield* Deferred.make<ConnectionStamp>();
        const commandStarted = yield* Deferred.make<ConnectionStamp>();
        const writerTrace = makeSqlTrace();
        const commandTrace = makeSqlTrace();
        const before = yield* submissionCompositionFacts(
          ids.persons.expiryWriterFirst,
          justBeforeExactEnd,
          ids.departments.alpha,
        ).pipe(
          Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-wf-before`)),
        );
        assert.deepEqual(before.applicableRuleIds, [ids.rules.expiryWriterFirst]);
        assert.deepEqual(before.contributingRuleIds, [ids.rules.expiryWriterFirst]);
        assert.equal(before.directPaymentAuthorities.length, 0);
        assert.equal(before.mapped._tag, "Success");

        const writerFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(writerStarted, started);
            const observed = observeSql(sql, writerTrace, {
              pauseAfter: {
                phase: "end-rule",
                ready: writerPaused,
                resume: resumeWriter,
              },
            });
            const ended = yield* endAuthzRule({
              ruleId: AuthzRuleId.make(ids.rules.expiryWriterFirst),
              endAt: exactEnd,
              expectedRevision: 0,
            }).pipe(Effect.provideService(Database, observed));
            const completed = yield* connectionStamp(sql);
            return { started, completed, ended };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-wf-writer`),
            ),
          ),
        );
        yield* Deferred.await(writerPaused);

        const commandFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const sql = yield* Database;
            const started = yield* connectionStamp(sql);
            yield* Deferred.succeed(commandStarted, started);
            const observed = observeSql(sql, commandTrace, {
              signalBefore: { phase: "authz-shared-lock", deferred: commandAttempted },
            });
            const result = yield* Effect.result(
              executeReceiptCommand(
                submitCommand(
                  ids.commands.expiryWriterFirst,
                  ids.departments.alpha,
                  "expiry-writer-first",
                ),
                principal(ids.persons.expiryWriterFirst, exactEnd),
                allocation(
                  generatedReceiptIds.expiryWriterFirst,
                  generatedVisualIds.expiryWriterFirst,
                ),
              ).pipe(Effect.provideService(Database, observed)),
            );
            const completed = yield* connectionStamp(sql);
            return { started, completed, result };
          }).pipe(
            Effect.provide(
              makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-wf-command`),
            ),
          ),
        );
        yield* Deferred.await(commandAttempted);
        const writerStamp = yield* Deferred.await(writerStarted);
        const commandStamp = yield* Deferred.await(commandStarted);
        assert.notEqual(writerStamp.pid, commandStamp.pid);
        const writerAtBlock = {
          attempted: [...writerTrace.attempted],
          completed: [...writerTrace.completed],
        };
        const commandAtBlock = {
          attempted: [...commandTrace.attempted],
          completed: [...commandTrace.completed],
        };
        const locks = yield* observeBlockingAndLocks({
          databaseUrl,
          blockedPid: commandStamp.pid,
          blockerPid: writerStamp.pid,
          personId: ids.persons.expiryWriterFirst,
          commandId: ids.commands.expiryWriterFirst,
          applicationName: `${proofApplicationPrefix}-expiry-wf-observer`,
        });
        assert.equal(locks.blocked.waitEventType, "Lock");
        assert.ok(locks.blocked.blockingPids.includes(writerStamp.pid));
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            writerStamp.pid,
            "authorization-rules",
            "ExclusiveLock",
            true,
          ),
        );
        assert.ok(
          hasAdvisoryLock(
            locks.advisoryLocks,
            commandStamp.pid,
            "authorization-rules",
            "ShareLock",
            false,
          ),
        );
        assertSubsequence(commandAtBlock.completed, [
          "person-authorization-lock",
          "organization-authority-projection",
          "direct-receipt-authority-projection",
        ]);
        assert.equal(commandAtBlock.attempted.at(-1), "authz-shared-lock");
        yield* Deferred.succeed(resumeWriter, undefined);
        const writer = yield* Fiber.join(writerFiber);
        const command = yield* Fiber.join(commandFiber);
        assert.equal(writer.ended.endAt, exactEnd);
        assert.equal(writer.ended.revision, 1);
        assert.equal(resultFailureTag(command.result), "ReceiptAuthorityDenied");
        assertSubsequence(writerTrace.completed, ["authz-exclusive-lock", "end-rule"]);
        assertSubsequence(commandTrace.completed, [
          "person-authorization-lock",
          "organization-authority-projection",
          "direct-receipt-authority-projection",
          "authz-shared-lock",
          "authz-tag-assignment-projection",
          "authz-rule-projection",
        ]);

        const after = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const beforeExact = yield* loadApplicableAuthorizationRules(
            personId(ids.persons.expiryWriterFirst),
            "submitReceipt",
            justBeforeExactEnd,
            proofReceiptContext(departmentId(ids.departments.alpha)),
          );
          const atExact = yield* loadApplicableAuthorizationRules(
            personId(ids.persons.expiryWriterFirst),
            "submitReceipt",
            exactEnd,
            proofReceiptContext(departmentId(ids.departments.alpha)),
          );
          const durable = yield* readDurableCommandFacts(sql, ids.commands.expiryWriterFirst);
          return {
            beforeExactRuleIds: beforeExact.rules.map((rule) => rule.ruleId),
            exactRuleIds: atExact.rules.map((rule) => rule.ruleId),
            durable,
          };
        }).pipe(
          Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-expiry-wf-after`)),
        );
        assert.deepEqual(after.beforeExactRuleIds, [ids.rules.expiryWriterFirst]);
        assert.deepEqual(after.exactRuleIds, []);
        assert.deepEqual(after.durable, {
          commandReceiptRows: 0,
          auditRows: 0,
          outboxRows: 0,
          outboxCommandRows: 0,
        });

        return {
          order: "WriterFirst" as const,
          instant: exactEnd,
          compositionBefore: before,
          participants: {
            writer: writer.started,
            writerCompleted: writer.completed,
            command: command.started,
            commandCompleted: command.completed,
            independentBackendPids: writer.started.pid !== command.started.pid,
          },
          blocked: locks.blocked,
          relationLocks: locks.relationLocks,
          advisoryLocks: locks.advisoryLocks,
          sqlOrderAtBlock: { writer: writerAtBlock, command: commandAtBlock },
          sqlOrderAfterCommit: { writer: writerTrace, command: commandTrace },
          endedRule: {
            ruleId: writer.ended.ruleId,
            endAt: writer.ended.endAt,
            revision: writer.ended.revision,
          },
          commandFailureTag: resultFailureTag(command.result),
          ...after,
        };
      });

      return { commandFirst, writerFirst };
    }),
  );

const proveTagDetachmentWriterFirst = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const beforeComposition = yield* approvalCompositionFacts(
        ids.persons.tagApprove,
        justBeforeExactEnd,
        ids.departments.alpha,
      ).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-before-composition`),
        ),
      );
      assert.deepEqual(beforeComposition.applicableRuleIds, [ids.rules.tagApprove]);
      assert.deepEqual(beforeComposition.assignmentIds, [ids.assignment]);
      assert.equal(beforeComposition.directApprovalGrants.length, 0);
      assert.equal(beforeComposition.mapped._tag, "Success");
      const accepted = yield* Effect.gen(function* () {
        const sql = yield* Database;
        const value = yield* executeReceiptCommand(
          {
            _tag: "RejectReceipt",
            commandId: ids.commands.tagAccepted,
            receiptId: ReceiptId.make(ids.receipts.tagAccepted),
            expectedRevision: 0,
          },
          principal(ids.persons.tagApprove, justBeforeExactEnd),
        );
        const durable = yield* readDurableCommandFacts(sql, ids.commands.tagAccepted);
        return { value, durable };
      }).pipe(
        Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-accepted`)),
      );
      assert.deepEqual(accepted.durable, {
        commandReceiptRows: 1,
        auditRows: 1,
        outboxRows: 2,
        outboxCommandRows: 1,
      });

      const writerPaused = yield* Deferred.make<void>();
      const resumeWriter = yield* Deferred.make<void>();
      const commandAttemptedRuleLock = yield* Deferred.make<void>();
      const writerTrace = makeSqlTrace();
      const commandTrace = makeSqlTrace();

      const writerFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, writerTrace, {
            pauseAfter: {
              phase: "end-tag-assignment",
              ready: writerPaused,
              resume: resumeWriter,
            },
          });
          const assignment = yield* endAuthzTagAssignment({
            assignmentId: AuthzTagAssignmentId.make(ids.assignment),
            endAt: exactEnd,
            expectedRevision: 0,
          }).pipe(Effect.provideService(Database, observed));
          const completed = yield* connectionStamp(sql);
          return { started, completed, assignment };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-writer-first-writer`),
          ),
        ),
      );
      yield* Deferred.await(writerPaused);

      const commandFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const sql = yield* Database;
          const started = yield* connectionStamp(sql);
          const observed = observeSql(sql, commandTrace, {
            signalBefore: {
              phase: "authz-shared-lock",
              deferred: commandAttemptedRuleLock,
            },
          });
          const result = yield* Effect.result(
            executeReceiptCommand(
              {
                _tag: "RejectReceipt",
                commandId: ids.commands.tagWriterFirst,
                receiptId: ReceiptId.make(ids.receipts.tagWriterFirst),
                expectedRevision: 0,
              },
              principal(ids.persons.tagApprove, exactEnd),
            ).pipe(Effect.provideService(Database, observed)),
          );
          const completed = yield* connectionStamp(sql);
          return { started, completed, result };
        }).pipe(
          Effect.provide(
            makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-writer-first-command`),
          ),
        ),
      );
      yield* Deferred.await(commandAttemptedRuleLock);

      const writerAtBlock = {
        attempted: [...writerTrace.attempted],
        completed: [...writerTrace.completed],
      };
      const commandAtBlock = {
        attempted: [...commandTrace.attempted],
        completed: [...commandTrace.completed],
      };
      const participantPids = yield* Effect.gen(function* () {
        const sql = yield* Database;
        return yield* sql<{ readonly applicationName: string; readonly pid: number }>`
          SELECT application_name AS "applicationName", pid
          FROM pg_catalog.pg_stat_activity
          WHERE application_name IN (
            ${`${proofApplicationPrefix}-tag-writer-first-writer`},
            ${`${proofApplicationPrefix}-tag-writer-first-command`}
          )
          ORDER BY application_name ASC
        `;
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-writer-first-pid-observer`),
        ),
      );
      const writerPid = participantPids.find((row) =>
        row.applicationName.endsWith("tag-writer-first-writer"),
      )?.pid;
      const commandPid = participantPids.find((row) =>
        row.applicationName.endsWith("tag-writer-first-command"),
      )?.pid;
      assert.equal(typeof writerPid, "number");
      assert.equal(typeof commandPid, "number");
      assert.notEqual(writerPid, commandPid);
      const lockObservation = yield* observeBlockingAndLocks({
        databaseUrl,
        blockedPid: commandPid!,
        blockerPid: writerPid!,
        personId: ids.persons.tagApprove,
        commandId: ids.commands.tagWriterFirst,
        applicationName: `${proofApplicationPrefix}-tag-writer-first-observer`,
      });
      assert.equal(lockObservation.blocked.waitEventType, "Lock");
      assert.ok(lockObservation.blocked.blockingPids.includes(writerPid!));
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          writerPid!,
          "authorization-rules",
          "ExclusiveLock",
          true,
        ),
      );
      assert.ok(
        hasAdvisoryLock(
          lockObservation.advisoryLocks,
          commandPid!,
          "authorization-rules",
          "ShareLock",
          false,
        ),
      );
      assertSubsequence(commandAtBlock.completed, [
        "person-authorization-lock",
        "organization-authority-projection",
        "direct-receipt-authority-projection",
      ]);
      assert.equal(commandAtBlock.attempted.at(-1), "authz-shared-lock");
      yield* Deferred.succeed(resumeWriter, undefined);
      const writer = yield* Fiber.join(writerFiber);
      const command = yield* Fiber.join(commandFiber);
      assert.equal(writer.started.pid, writerPid);
      assert.equal(command.started.pid, commandPid);
      assert.equal(writer.assignment.endAt, exactEnd);
      assert.equal(writer.assignment.revision, 1);
      assert.equal(resultFailureTag(command.result), "ReceiptAuthorityDenied");
      assertSubsequence(writerTrace.completed, ["authz-exclusive-lock", "end-tag-assignment"]);
      assertSubsequence(commandTrace.completed, [
        "person-authorization-lock",
        "organization-authority-projection",
        "direct-receipt-authority-projection",
        "authz-shared-lock",
        "authz-tag-assignment-projection",
        "authz-rule-projection",
      ]);

      const after = yield* Effect.gen(function* () {
        const sql = yield* Database;
        const beforeInstant = yield* loadApplicableAuthorizationRules(
          personId(ids.persons.tagApprove),
          "approveReceipt",
          justBeforeExactEnd,
          proofReceiptContext(departmentId(ids.departments.alpha)),
        );
        const exactInstant = yield* loadApplicableAuthorizationRules(
          personId(ids.persons.tagApprove),
          "approveReceipt",
          exactEnd,
          proofReceiptContext(departmentId(ids.departments.alpha)),
        );
        const durable = yield* readDurableCommandFacts(sql, ids.commands.tagWriterFirst);
        const [receipt] = yield* sql<{ readonly status: string; readonly revision: number }>`
          SELECT status, revision
          FROM public.economy_receipts
          WHERE receipt_id = ${ids.receipts.tagWriterFirst}
        `;
        assert(receipt);
        return {
          beforeInstantRuleIds: beforeInstant.rules.map((rule) => rule.ruleId),
          beforeInstantAssignmentIds: beforeInstant.tagAssignments.map(
            (assignment) => assignment.assignmentId,
          ),
          exactInstantRuleIds: exactInstant.rules.map((rule) => rule.ruleId),
          exactInstantAssignmentIds: exactInstant.tagAssignments.map(
            (assignment) => assignment.assignmentId,
          ),
          durable,
          receipt,
        };
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-writer-first-after`),
        ),
      );
      assert.deepEqual(after.beforeInstantRuleIds, [ids.rules.tagApprove]);
      assert.deepEqual(after.beforeInstantAssignmentIds, [ids.assignment]);
      assert.deepEqual(after.exactInstantRuleIds, []);
      assert.deepEqual(after.exactInstantAssignmentIds, []);
      assert.deepEqual(after.durable, {
        commandReceiptRows: 0,
        auditRows: 0,
        outboxRows: 0,
        outboxCommandRows: 0,
      });
      assert.deepEqual(after.receipt, { status: "Pending", revision: 0 });
      const retry = yield* Effect.gen(function* () {
        const sql = yield* Database;
        const createdAssignment = yield* createAuthzTagAssignment({
          assignmentId: AuthzTagAssignmentId.make(ids.retryAssignment),
          tagId: AuthzTagId.make(ids.tag),
          personId: personId(ids.persons.tagApprove),
          startAt: exactEnd,
          endAt: null,
          revision: 0,
        });
        const applicable = yield* loadApplicableAuthorizationRules(
          personId(ids.persons.tagApprove),
          "approveReceipt",
          exactEnd,
          proofReceiptContext(departmentId(ids.departments.alpha)),
        );
        const value = yield* executeReceiptCommand(
          {
            _tag: "RejectReceipt",
            commandId: ids.commands.tagWriterFirst,
            receiptId: ReceiptId.make(ids.receipts.tagWriterFirst),
            expectedRevision: 0,
          },
          principal(ids.persons.tagApprove, exactEnd),
        );
        const durable = yield* readDurableCommandFacts(sql, ids.commands.tagWriterFirst);
        return {
          sameCommandId: ids.commands.tagWriterFirst,
          createdAssignment: {
            assignmentId: createdAssignment.assignmentId,
            startAt: createdAssignment.startAt,
            endAt: createdAssignment.endAt,
            revision: createdAssignment.revision,
          },
          applicableRuleIds: applicable.rules.map((rule) => rule.ruleId),
          applicableAssignmentIds: applicable.tagAssignments.map(
            (assignment) => assignment.assignmentId,
          ),
          observation: value.observation,
          durable,
        };
      }).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, `${proofApplicationPrefix}-tag-failed-command-retry`),
        ),
      );
      assert.deepEqual(retry.applicableRuleIds, [ids.rules.tagApprove]);
      assert.deepEqual(retry.applicableAssignmentIds, [ids.retryAssignment]);
      assert.deepEqual(retry.durable, {
        commandReceiptRows: 1,
        auditRows: 1,
        outboxRows: 2,
        outboxCommandRows: 1,
      });

      return {
        beforeDetachment: {
          composition: beforeComposition,
          acceptedObservation: accepted.value.observation,
          durable: accepted.durable,
        },
        participants: {
          writer: writer.started,
          writerCompleted: writer.completed,
          command: command.started,
          commandCompleted: command.completed,
          independentBackendPids: writerPid !== commandPid,
        },
        blocked: lockObservation.blocked,
        relationLocks: lockObservation.relationLocks,
        advisoryLocks: lockObservation.advisoryLocks,
        sqlOrderAtBlock: { writer: writerAtBlock, command: commandAtBlock },
        sqlOrderAfterCommit: { writer: writerTrace, command: commandTrace },
        endedAssignment: {
          assignmentId: writer.assignment.assignmentId,
          startAt: writer.assignment.startAt,
          endAt: writer.assignment.endAt,
          revision: writer.assignment.revision,
        },
        exactEnd: {
          instant: exactEnd,
          commandFailureTag: resultFailureTag(command.result),
          ...after,
        },
        retryAfterFailedAttempt: retry,
      };
    }),
  );

interface CleanupEvidence {
  readonly participantConnectionsBeforeCleanup: number;
  readonly remainingUserSchemas: number;
  readonly remainingPublicRelations: number;
  readonly remainingPublicRoutines: number;
  readonly remainingNonDefaultExtensions: number;
}

const cleanupDatabase = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const [connections] = yield* sql<{ readonly count: number }>`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_stat_activity
      WHERE application_name LIKE ${`${proofApplicationPrefix}%`}
        AND pid <> pg_backend_pid()
    `;
    assert(connections);
    yield* resetDatabaseObjects(sql);
    const [remaining] = yield* sql<CleanupEvidence>`
      SELECT
        ${connections.count}::integer AS "participantConnectionsBeforeCleanup",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_namespace
          WHERE nspname NOT LIKE 'pg_%'
            AND nspname NOT IN ('information_schema', 'public')
        ) AS "remainingUserSchemas",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ) AS "remainingPublicRelations",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_proc AS routine
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = routine.pronamespace
          WHERE namespace.nspname = 'public'
        ) AS "remainingPublicRoutines",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_extension
          WHERE extname <> 'plpgsql'
        ) AS "remainingNonDefaultExtensions"
    `;
    assert(remaining);
    return remaining;
  }).pipe(Effect.provide(makeProofLayer(databaseUrl, `${proofApplicationPrefix}-cleanup`)));

const runProof = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const migrationPreflight = yield* proveRuleReconciliationMigration(databaseUrl);
    const migration = yield* replayCanonicalMigrationsAndSeed(databaseUrl);
    const strictWriters = yield* proveStrictWriters(databaseUrl);
    const backfill = yield* proveDisposableAuthzBackfill(databaseUrl);
    const zeroRuleEquivalence = yield* proveZeroRuleEquivalence(databaseUrl);
    const boundaries = yield* proveHalfOpenAndScopeDenials(databaseUrl);
    const directAuthorityPhantomProtocol = yield* proveDirectAuthorityPhantomProtocol(databaseUrl);
    const directAuthorityLock = yield* proveDirectAuthorityRowLock(databaseUrl);
    const ruleExpiry = yield* proveRuleExpiryRaces(databaseUrl);
    const commandFirstRuleRemoval = yield* proveCommandFirstRuleRemoval(databaseUrl);
    const writerFirstTagDetachment = yield* proveTagDetachmentWriterFirst(databaseUrl);
    return {
      schema: "AuthorizationRulesPostgresProofEvidence/v1" as const,
      specId: "0056" as const,
      implementationBaseRevision,
      database: {
        engine: "PostgreSQL" as const,
        serverVersionNum: migration.serverVersionNum,
        schemaRevision: databaseSchemaRevision,
        canonicalMigrationRows: migration.migrationRows,
        idempotentReplayRows: migration.idempotentReplayRows,
      },
      migrationPreflight,
      seedRecords: migration.seedRecords,
      strictWriters,
      backfill,
      zeroRuleEquivalence,
      boundaries,
      ruleOnly: {
        approve: directAuthorityLock.composition,
        submit: commandFirstRuleRemoval.composition,
        tagApprove: writerFirstTagDetachment.beforeDetachment.composition,
      },
      concurrency: {
        directAuthorityPhantomProtocol,
        directAuthorityRowLock: directAuthorityLock,
        ruleExpiry,
        commandFirstRuleRemoval,
        writerFirstTagDetachment,
      },
    };
  });

export const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL").pipe(
    Config.withDefault(Redacted.make("postgres://receipt:receipt@127.0.0.1:55432/receipt_proof")),
  );
  assertDisposablePostgres(databaseUrl);
  let cleaned = false;
  const cleanupOnce = Effect.suspend(() =>
    cleaned
      ? Effect.void
      : cleanupDatabase(databaseUrl).pipe(
          Effect.tap(() => Effect.sync(() => void (cleaned = true))),
          Effect.asVoid,
        ),
  ).pipe(
    Effect.catchTags({
      MigrationError: Effect.die,
      SqlError: Effect.die,
    }),
  );
  const evidence = yield* Effect.scoped(runProof(databaseUrl)).pipe(
    Effect.flatMap((proof) =>
      cleanupDatabase(databaseUrl).pipe(
        Effect.tap(() => Effect.sync(() => void (cleaned = true))),
        Effect.map((cleanup) => ({ ...proof, cleanup, passed: true as const })),
      ),
    ),
    Effect.ensuring(cleanupOnce),
  );
  assert.deepEqual(evidence.cleanup, {
    participantConnectionsBeforeCleanup: 0,
    remainingUserSchemas: 0,
    remainingPublicRelations: 0,
    remainingPublicRoutines: 0,
    remainingNonDefaultExtensions: 0,
  });
  const canonicalEvidence = canonicalJson(evidence);
  assert.equal(canonicalEvidence.includes("postgres://"), false);
  assert.equal(canonicalEvidence.includes("paymentAccountCiphertext"), false);
  assert.equal(canonicalEvidence.includes("ciphertext:proof:"), false);
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});
