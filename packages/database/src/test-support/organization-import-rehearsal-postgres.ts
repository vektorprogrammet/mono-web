import type { DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Effect } from "effect";

export interface StableTableProjection {
  readonly qualifiedName: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface StableByteSet {
  readonly name:
    | "canonical"
    | "provenance"
    | "prerequisite"
    | "rule"
    | "auth"
    | "receipt"
    | "outbox";
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
  readonly tables: ReadonlyArray<{
    readonly qualifiedName: string;
    readonly rowCount: number;
    readonly byteLength: number;
    readonly sha256: string;
  }>;
}

export interface OrganizationImportStableState {
  readonly byteSets: Readonly<Record<StableByteSet["name"], StableByteSet>>;
  readonly importedTableCounts: {
    readonly departments: number;
    readonly teams: number;
    readonly memberships: number;
    readonly quarantine: number;
    readonly ledger: number;
  };
}

export type StableByteSetComparison = Readonly<
  Record<
    StableByteSet["name"],
    {
      readonly byteLengthEqual: boolean;
      readonly sha256Equal: boolean;
      readonly directBytesEqual: boolean;
    }
  >
>;

const makeStableByteSet = (
  name: StableByteSet["name"],
  projections: ReadonlyArray<StableTableProjection>,
): StableByteSet => {
  const bytes = canonicalJsonBytes(
    projections.map(({ qualifiedName, rows }) => ({ qualifiedName, rows })),
  );
  return {
    name,
    bytes,
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    tables: projections.map(({ qualifiedName, rows }) => {
      const rowBytes = canonicalJsonBytes(rows);
      return {
        qualifiedName,
        rowCount: rows.length,
        byteLength: rowBytes.byteLength,
        sha256: sha256Hex(rowBytes),
      };
    }),
  };
};

const table = (
  qualifiedName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): StableTableProjection => ({ qualifiedName, rows });

export const stableByteSetEvidence = (state: OrganizationImportStableState) =>
  Object.fromEntries(
    Object.entries(state.byteSets).map(([name, byteSet]) => [
      name,
      {
        byteLength: byteSet.byteLength,
        sha256: byteSet.sha256,
        tables: byteSet.tables,
      },
    ]),
  );

export const compareStableByteSets = (
  before: OrganizationImportStableState,
  after: OrganizationImportStableState,
): StableByteSetComparison =>
  Object.fromEntries(
    (Object.keys(before.byteSets) as Array<StableByteSet["name"]>).map((name) => {
      const left = before.byteSets[name];
      const right = after.byteSets[name];
      return [
        name,
        {
          byteLengthEqual: left.byteLength === right.byteLength,
          sha256Equal: left.sha256 === right.sha256,
          directBytesEqual: Buffer.from(left.bytes).equals(Buffer.from(right.bytes)),
        },
      ];
    }),
  ) as StableByteSetComparison;

export const readOrganizationImportStableState = (
  sql: DatabaseShape,
): Effect.Effect<OrganizationImportStableState, unknown> =>
  Effect.gen(function* () {
    const departments = yield* sql<Record<string, unknown>>`
      SELECT
        department_id AS "departmentId",
        name,
        short_name AS "shortName",
        email,
        address,
        city,
        latitude,
        longitude,
        slack_channel AS "slackChannel",
        logo_path AS "logoPath",
        active,
        revision,
        native_creation_command_id AS "nativeCreationCommandId"
      FROM public.organization_departments
      ORDER BY department_id ASC
    `;
    const teams = yield* sql<Record<string, unknown>>`
      SELECT
        team_id AS "teamId",
        department_id AS "departmentId",
        name,
        email,
        description,
        short_description AS "shortDescription",
        accept_application AS "acceptApplication",
        CASE WHEN deadline IS NULL THEN NULL
          ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS deadline,
        active,
        revision,
        native_creation_command_id AS "nativeCreationCommandId"
      FROM public.organization_teams
      ORDER BY team_id ASC
    `;
    const memberships = yield* sql<Record<string, unknown>>`
      SELECT
        membership_id AS "membershipId",
        person_id AS "personId",
        team_id AS "teamId",
        deleted_team_name AS "deletedTeamName",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        position_id AS "positionId",
        is_team_leader AS "isTeamLeader",
        is_suspended AS "isSuspended",
        revision
      FROM public.organization_memberships
      ORDER BY membership_id ASC
    `;
    const quarantine = yield* sql<Record<string, unknown>>`
      SELECT
        source_repository AS "sourceRepository",
        source_revision AS "sourceRevision",
        snapshot_id AS "snapshotId",
        source_kind AS "sourceKind",
        source_primary_key AS "sourcePrimaryKey",
        source_occurrence AS "sourceOccurrence",
        transformation_revision AS "transformationRevision",
        target_semantic_identity AS "targetSemanticIdentity",
        reason,
        raw_json AS raw,
        to_char(quarantined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "quarantinedAt"
      FROM public.organization_membership_quarantine
      ORDER BY
        source_repository ASC,
        source_revision ASC,
        snapshot_id ASC,
        source_kind ASC,
        source_primary_key ASC,
        source_occurrence ASC,
        transformation_revision ASC
    `;
    const ledger = yield* sql<Record<string, unknown>>`
      SELECT
        source_repository AS "sourceRepository",
        source_revision AS "sourceRevision",
        snapshot_id AS "snapshotId",
        source_kind AS "sourceKind",
        source_primary_key AS "sourcePrimaryKey",
        source_occurrence AS "sourceOccurrence",
        transformation_revision AS "transformationRevision",
        target_semantic_identity AS "targetSemanticIdentity",
        destination_identity AS "destinationIdentity",
        result,
        reason_json AS "reasonJson",
        source_metadata_json AS "sourceMetadataJson",
        to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
      FROM public.organization_import_ledger
      ORDER BY
        source_repository ASC,
        source_revision ASC,
        snapshot_id ASC,
        source_kind ASC,
        source_primary_key ASC,
        source_occurrence ASC,
        transformation_revision ASC
    `;

    const profiles = yield* sql<Record<string, unknown>>`
      SELECT person_id AS "personId", first_name AS "firstName", last_name AS "lastName", revision
      FROM public.person_profiles
      ORDER BY person_id ASC
    `;
    const contacts = yield* sql<Record<string, unknown>>`
      SELECT person_id AS "personId", email, phone, revision
      FROM public.person_contact_profiles
      ORDER BY person_id ASC
    `;
    const grants = yield* sql<Record<string, unknown>>`
      SELECT
        grant_id AS "grantId",
        person_id AS "personId",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.organization_global_administrator_grants
      ORDER BY grant_id ASC
    `;

    const authzTags = yield* sql<Record<string, unknown>>`
      SELECT tag_id AS "tagId", name, revision
      FROM public.authz_tags
      ORDER BY tag_id ASC
    `;
    const authzAssignments = yield* sql<Record<string, unknown>>`
      SELECT
        assignment_id AS "assignmentId",
        tag_id AS "tagId",
        person_id AS "personId",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.authz_tag_assignments
      ORDER BY assignment_id ASC
    `;
    const authzRules = yield* sql<Record<string, unknown>>`
      SELECT
        rule_id AS "ruleId",
        capability_id AS "capabilityId",
        effect_kind AS "effectKind",
        subject_kind AS "subjectKind",
        subject_person_id AS "subjectPersonId",
        subject_tag_id AS "subjectTagId",
        scope,
        department_id AS "departmentId",
        params,
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.authz_rules
      ORDER BY rule_id ASC
    `;

    const authTables = yield* sql<Record<string, unknown>>`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'auth' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;
    const authColumns = yield* sql<Record<string, unknown>>`
      SELECT
        table_name AS "tableName",
        column_name AS "columnName",
        ordinal_position AS "ordinalPosition",
        data_type AS "dataType",
        udt_name AS "udtName",
        is_nullable AS "isNullable",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'auth'
      ORDER BY table_name ASC, ordinal_position ASC
    `;
    const authConstraints = yield* sql<Record<string, unknown>>`
      SELECT
        relation.relname AS "tableName",
        constraint_record.conname AS "constraintName",
        constraint_record.contype AS "constraintType",
        pg_get_constraintdef(constraint_record.oid, true) AS definition
      FROM pg_catalog.pg_constraint AS constraint_record
      INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'auth'
      ORDER BY relation.relname ASC, constraint_record.conname ASC
    `;
    const authIndexes = yield* sql<Record<string, unknown>>`
      SELECT
        relation.relname AS "tableName",
        index_relation.relname AS "indexName",
        pg_get_indexdef(index_record.indexrelid, 0, true) AS definition
      FROM pg_catalog.pg_index AS index_record
      INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = index_record.indrelid
      INNER JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'auth'
      ORDER BY relation.relname ASC, index_relation.relname ASC
    `;
    const authTriggers = yield* sql<Record<string, unknown>>`
      SELECT
        relation.relname AS "tableName",
        trigger_record.tgname AS "triggerName",
        pg_get_triggerdef(trigger_record.oid, true) AS definition
      FROM pg_catalog.pg_trigger AS trigger_record
      INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'auth' AND NOT trigger_record.tgisinternal
      ORDER BY relation.relname ASC, trigger_record.tgname ASC
    `;
    const authFunctions = yield* sql<Record<string, unknown>>`
      SELECT
        procedure.proname AS "functionName",
        pg_get_function_identity_arguments(procedure.oid) AS arguments,
        pg_get_function_result(procedure.oid) AS result
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'auth'
      ORDER BY procedure.proname ASC, pg_get_function_identity_arguments(procedure.oid) ASC
    `;
    const authRowCounts = yield* sql<Record<string, unknown>>`
      SELECT 'account' AS "tableName", count(*)::integer AS "rowCount" FROM auth."account"
      UNION ALL
      SELECT 'session', count(*)::integer FROM auth."session"
      UNION ALL
      SELECT 'user', count(*)::integer FROM auth."user"
      UNION ALL
      SELECT 'verification', count(*)::integer FROM auth."verification"
      ORDER BY "tableName" ASC
    `;

    const receipts = yield* sql<Record<string, unknown>>`
      SELECT
        receipt_id AS "receiptId", visual_id AS "visualId", owner_person_id AS "ownerPersonId",
        department_id AS "departmentId", amount_ore::text AS "amountOre", currency, description,
        receipt_date::text AS "receiptDate",
        to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
        status,
        CASE WHEN refund_date IS NULL THEN NULL
          ELSE to_char(refund_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "refundDate",
        payment_account_ciphertext AS "paymentAccountCiphertext", file_ref AS "fileRef",
        file_object_key AS "fileObjectKey", file_content_type AS "fileContentType",
        file_byte_length::text AS "fileByteLength", file_sha256 AS "fileSha256", revision
      FROM public.economy_receipts
      ORDER BY receipt_id ASC
    `;
    const receiptCommands = yield* sql<Record<string, unknown>>`
      SELECT
        command_id AS "commandId", command_sha256 AS "commandSha256", command_json AS "commandJson",
        observation_json AS "observationJson", receipt_id AS "receiptId",
        to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"
      FROM public.economy_receipt_command_receipts
      ORDER BY command_id ASC
    `;
    const receiptOutbox = yield* sql<Record<string, unknown>>`
      SELECT
        effect_id AS "effectId", effect_type AS "effectType", receipt_id AS "receiptId",
        command_id AS "commandId", ordinal, payload_json AS "payloadJson", status, attempts,
        claim_id AS "claimId",
        CASE WHEN claimed_at IS NULL THEN NULL
          ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "claimedAt",
        last_failure_tag AS "lastFailureTag"
      FROM public.economy_receipt_outbox
      ORDER BY effect_id ASC
    `;
    const receiptAudit = yield* sql<Record<string, unknown>>`
      SELECT
        command_id AS "commandId", receipt_id AS "receiptId", actor_person_id AS "actorPersonId",
        action, receipt_revision AS "receiptRevision",
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
      FROM public.economy_receipt_audit
      ORDER BY command_id ASC
    `;
    const receiptLedger = yield* sql<Record<string, unknown>>`
      SELECT
        source_repository AS "sourceRepository", source_revision AS "sourceRevision",
        snapshot_id AS "snapshotId", source_watermark AS "sourceWatermark",
        source_primary_key AS "sourcePrimaryKey", source_occurrence AS "sourceOccurrence",
        source_digest AS "sourceDigest", transformation_revision AS "transformationRevision",
        target_semantic_identity AS "targetSemanticIdentity", destination_identity AS "destinationIdentity",
        result, reconciliation_result AS "reconciliationResult", reasons_json AS "reasonsJson"
      FROM public.economy_receipt_import_ledger
      ORDER BY
        source_repository ASC, source_revision ASC, snapshot_id ASC, source_primary_key ASC,
        source_occurrence ASC, transformation_revision ASC
    `;
    const paymentAuthorities = yield* sql<Record<string, unknown>>`
      SELECT
        payment_authority_id AS "paymentAuthorityId", person_id AS "personId",
        department_id AS "departmentId", payment_account_ciphertext AS "paymentAccountCiphertext",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.economy_payment_authorities
      ORDER BY payment_authority_id ASC
    `;
    const approvalGrants = yield* sql<Record<string, unknown>>`
      SELECT
        approval_grant_id AS "approvalGrantId", person_id AS "personId", scope,
        department_id AS "departmentId",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.economy_receipt_approval_grants
      ORDER BY approval_grant_id ASC
    `;

    const admissionPeriodOutbox = yield* sql<Record<string, unknown>>`
      SELECT
        effect_id AS "effectId", effect_type AS "effectType", admission_period_id AS "admissionPeriodId",
        command_id AS "commandId", ordinal, payload_json AS "payloadJson", status, attempts,
        claim_id AS "claimId",
        CASE WHEN claimed_at IS NULL THEN NULL
          ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "claimedAt",
        last_failure_tag AS "lastFailureTag"
      FROM public.admission_period_outbox
      ORDER BY effect_id ASC
    `;
    const applicationOutbox = yield* sql<Record<string, unknown>>`
      SELECT
        effect_id AS "effectId", effect_type AS "effectType", application_id AS "applicationId",
        applicant_id AS "applicantId", command_id AS "commandId", ordinal,
        payload_json AS "payloadJson", status, attempts, claim_id AS "claimId",
        CASE WHEN claimed_at IS NULL THEN NULL
          ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "claimedAt",
        last_failure_tag AS "lastFailureTag"
      FROM public.admission_application_outbox
      ORDER BY effect_id ASC
    `;
    const invitationOutbox = yield* sql<Record<string, unknown>>`
      SELECT
        effect_id AS "effectId", effect_type AS "effectType", command_id AS "commandId",
        interview_id AS "interviewId", invitation_id AS "invitationId",
        schedule_revision AS "scheduleRevision", ordinal, payload_json AS "payloadJson", status,
        attempts, claim_id AS "claimId",
        CASE WHEN claimed_at IS NULL THEN NULL
          ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "claimedAt",
        CASE WHEN delivered_at IS NULL THEN NULL
          ELSE to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "deliveredAt",
        last_failure_tag AS "lastFailureTag"
      FROM public.recruitment_invitation_outbox
      ORDER BY effect_id ASC
    `;
    const invitationResponseOutbox = yield* sql<Record<string, unknown>>`
      SELECT
        effect_id AS "effectId", effect_type AS "effectType", invitation_id AS "invitationId",
        interview_id AS "interviewId", schedule_revision AS "scheduleRevision",
        response_revision AS "responseRevision", response_state AS "responseState",
        response_message AS "responseMessage", ordinal, payload_json AS "payloadJson", status,
        attempts, claim_id AS "claimId",
        CASE WHEN claimed_at IS NULL THEN NULL
          ELSE to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "claimedAt",
        CASE WHEN delivered_at IS NULL THEN NULL
          ELSE to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "deliveredAt",
        last_failure_tag AS "lastFailureTag"
      FROM public.recruitment_invitation_response_outbox
      ORDER BY effect_id ASC
    `;

    const canonical = makeStableByteSet("canonical", [
      table("public.organization_departments", departments),
      table("public.organization_teams", teams),
      table("public.organization_memberships", memberships),
    ]);
    const provenance = makeStableByteSet("provenance", [
      table("public.organization_membership_quarantine", quarantine),
      table("public.organization_import_ledger", ledger),
    ]);
    const prerequisite = makeStableByteSet("prerequisite", [
      table("public.person_profiles", profiles),
      table("public.person_contact_profiles", contacts),
      table("public.organization_global_administrator_grants", grants),
    ]);
    const rule = makeStableByteSet("rule", [
      table("public.authz_tags", authzTags),
      table("public.authz_tag_assignments", authzAssignments),
      table("public.authz_rules", authzRules),
    ]);
    const auth = makeStableByteSet("auth", [
      table("auth.catalog.tables", authTables),
      table("auth.catalog.columns", authColumns),
      table("auth.catalog.constraints", authConstraints),
      table("auth.catalog.indexes", authIndexes),
      table("auth.catalog.triggers", authTriggers),
      table("auth.catalog.functions", authFunctions),
      table("auth.row-counts", authRowCounts),
    ]);
    const receipt = makeStableByteSet("receipt", [
      table("public.economy_receipts", receipts),
      table("public.economy_receipt_command_receipts", receiptCommands),
      table("public.economy_receipt_outbox", receiptOutbox),
      table("public.economy_receipt_audit", receiptAudit),
      table("public.economy_receipt_import_ledger", receiptLedger),
      table("public.economy_payment_authorities", paymentAuthorities),
      table("public.economy_receipt_approval_grants", approvalGrants),
    ]);
    const outbox = makeStableByteSet("outbox", [
      table("public.admission_application_outbox", applicationOutbox),
      table("public.admission_period_outbox", admissionPeriodOutbox),
      table("public.economy_receipt_outbox", receiptOutbox),
      table("public.recruitment_invitation_outbox", invitationOutbox),
      table("public.recruitment_invitation_response_outbox", invitationResponseOutbox),
    ]);

    return {
      byteSets: { canonical, provenance, prerequisite, rule, auth, receipt, outbox },
      importedTableCounts: {
        departments: departments.length,
        teams: teams.length,
        memberships: memberships.length,
        quarantine: quarantine.length,
        ledger: ledger.length,
      },
    };
  });

export const installOrganizationImportFailureTrigger = (sql: DatabaseShape) =>
  sql.unsafe(`CREATE FUNCTION public.spec_0067_fail_organization_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION
    USING ERRCODE = 'P0001',
          MESSAGE = 'spec 0067 injected organization ledger failure';
END;
$function$;

CREATE TRIGGER spec_0067_fail_organization_ledger
BEFORE INSERT ON public.organization_import_ledger
FOR EACH STATEMENT
EXECUTE FUNCTION public.spec_0067_fail_organization_ledger();`);

export const removeOrganizationImportFailureTrigger = (sql: DatabaseShape) =>
  sql.unsafe(`DROP TRIGGER spec_0067_fail_organization_ledger
  ON public.organization_import_ledger;
DROP FUNCTION public.spec_0067_fail_organization_ledger();`);
