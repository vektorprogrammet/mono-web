import assert from "node:assert/strict";
import {
  composeCapabilityEvidence,
  readApplicableAuthorizationRules,
} from "@vektorprogrammet/domain/authz";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  makeReceiptApprovalContext,
  ReceiptId,
  resolveReceiptAuthorityForRead,
  type ReceiptApprovalCandidate,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Redacted } from "effect";
import { resolveOrganizationPersonAuthorityForRead } from "../../domain/src/organization/authority-postgres.js";
import { executeReceiptCommand } from "../../domain/src/receipt/postgres.js";
import { DatabaseLive } from "./layers.js";
import { proveRuleReconciliationMigration } from "./rule-reconciliation-migration-postgres-proof.js";

const authorizationInstant = "2037-06-15T12:00:00.000Z";
const activeStart = "2037-01-01T00:00:00.000Z";
const principalId = PersonId.make("rule-reconciliation-principal");
const ownerId = PersonId.make("rule-reconciliation-owner");
const relatedDepartmentId = DepartmentId.make("rule-reconciliation-related");
const foreignDepartmentId = DepartmentId.make("rule-reconciliation-foreign");

const assertDisposablePostgres = (url: Redacted.Redacted<string>): void => {
  const parsed = new URL(Redacted.value(url));
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /proof|test/u);
};

const resetDatabase = (sql: DatabaseShape) =>
  sql
    .unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
    .pipe(Effect.asVoid, Effect.orDie);

const seed = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO public.person_profiles (person_id, first_name, last_name)
        VALUES
          (${principalId}, 'Rule', 'Principal'),
          (${ownerId}, 'Receipt', 'Owner')
      `;
      yield* sql`
        INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
        VALUES
          (${relatedDepartmentId}, 'Rule reconciliation related', 'RR', 'related@example.invalid', 'Oslo'),
          (${foreignDepartmentId}, 'Rule reconciliation foreign', 'RF', 'foreign@example.invalid', 'Oslo')
      `;
      yield* sql`
        INSERT INTO public.organization_teams (team_id, department_id, name)
        VALUES ('rule-reconciliation-team', ${relatedDepartmentId}, 'Rule reconciliation team')
      `;
      yield* sql`
        INSERT INTO public.organization_memberships (
          membership_id, person_id, team_id, start_at, end_at, position_id, is_team_leader
        ) VALUES (
          'rule-reconciliation-membership', ${principalId}, 'rule-reconciliation-team',
          ${activeStart}, NULL, NULL, FALSE
        )
      `;
      yield* sql`
        INSERT INTO public.authz_rules (
          rule_id, capability_id, effect_kind, subject_kind,
          subject_person_id, subject_tag_id, scope, domain_id, department_id,
          params, start_at, end_at, revision
        ) VALUES
          (
            'rule-reconciliation-delegate', 'approveReceipt', 'delegate', 'Person',
            ${principalId}, NULL, 'Global', NULL, NULL,
            ${sql.json({ slot: "EconomyGlobalReceiptApprovalGrant" })},
            ${activeStart}, NULL, 0
          ),
          (
            'rule-reconciliation-pending-a', 'approveReceipt', 'requirement', 'Person',
            ${principalId}, NULL, 'Global', NULL, NULL,
            ${sql.json({ requirementId: "receipts.pending", parameters: {} })},
            ${activeStart}, NULL, 0
          ),
          (
            'rule-reconciliation-pending-b', 'approveReceipt', 'requirement', 'Person',
            ${principalId}, NULL, 'Global', NULL, NULL,
            ${sql.json({ requirementId: "receipts.pending", parameters: {} })},
            ${activeStart}, NULL, 0
          ),
          (
            'rule-reconciliation-approver', 'approveReceipt', 'requirement', 'Person',
            ${principalId}, NULL, 'Global', NULL, NULL,
            ${sql.json({
              requirementId: "receipts.approver-relationship",
              parameters: {},
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
            'rule-reconciliation-pending', 'RR-PENDING', ${ownerId}, ${relatedDepartmentId},
            1000, 'NOK', 'Pending requirement trace', '2037-06-14', ${activeStart},
            'Pending', NULL, 'ciphertext:trace', 'trace-pending', 'temporary/trace-pending',
            'application/pdf', 1, ${"a".repeat(64)}, 0
          ),
          (
            'rule-reconciliation-nonpending', 'RR-NONPENDING', ${ownerId}, ${relatedDepartmentId},
            1000, 'NOK', 'Nonpending requirement trace', '2037-06-14', ${activeStart},
            'Rejected', NULL, 'ciphertext:trace', 'trace-nonpending', 'temporary/trace-nonpending',
            'application/pdf', 1, ${"b".repeat(64)}, 0
          ),
          (
            'rule-reconciliation-foreign', 'RR-FOREIGN', ${ownerId}, ${foreignDepartmentId},
            1000, 'NOK', 'Foreign requirement trace', '2037-06-14', ${activeStart},
            'Pending', NULL, 'ciphertext:trace', 'trace-foreign', 'temporary/trace-foreign',
            'application/pdf', 1, ${"c".repeat(64)}, 0
          )
      `;
    }),
  );

type ReceiptTraceRow = ReceiptApprovalCandidate & {
  readonly auditCount: number;
  readonly outboxCount: number;
};

const readTraceRow = (sql: DatabaseShape, receiptId: string) =>
  sql<ReceiptTraceRow>`
    SELECT
      receipt.receipt_id AS "receiptId",
      receipt.owner_person_id AS "ownerPersonId",
      receipt.department_id AS "departmentId",
      receipt.status,
      receipt.revision,
      (
        SELECT count(*)::integer
        FROM public.economy_receipt_outbox AS outbox
        WHERE outbox.receipt_id = receipt.receipt_id
      ) AS "outboxCount",
      (
        SELECT count(*)::integer
        FROM public.economy_receipt_audit AS audit
        WHERE audit.receipt_id = receipt.receipt_id
      ) AS "auditCount"
    FROM public.economy_receipts AS receipt
    WHERE receipt.receipt_id = ${receiptId}
  `.pipe(Effect.map((rows) => rows[0]!));

const traceReceipt = (sql: DatabaseShape, receiptId: string) =>
  Effect.gen(function* () {
    const before = yield* readTraceRow(sql, receiptId);
    const organization = yield* resolveOrganizationPersonAuthorityForRead(
      principalId,
      authorizationInstant,
    );
    const direct = yield* resolveReceiptAuthorityForRead(
      principalId,
      authorizationInstant,
      organization,
    );
    const unresolvedContext = makeReceiptApprovalContext(before, organization, direct, []);
    const applicable = yield* readApplicableAuthorizationRules(
      sql,
      { _tag: "Person", personId: principalId },
      "approveReceipt",
      authorizationInstant,
      unresolvedContext,
      "None",
    );
    const context = makeReceiptApprovalContext(before, organization, direct, applicable.rules);
    const composition = composeCapabilityEvidence(
      "approveReceipt",
      { approvalGrants: direct.approvalGrants },
      applicable.rules,
      {
        principal: { _tag: "Person", personId: principalId },
        authorizationInstant,
        context,
        tagAssignments: applicable.tagAssignments,
      },
    );
    const command = yield* Effect.result(
      executeReceiptCommand(
        {
          _tag: "RejectReceipt",
          commandId: `rule-reconciliation-command-${receiptId}`,
          receiptId: ReceiptId.make(receiptId),
          expectedRevision: before.revision,
        },
        { personId: principalId, authorizationInstant },
      ),
    );
    const after = yield* readTraceRow(sql, receiptId);
    return {
      receiptId,
      decision: composition.decision._tag === "Allow" ? "Allow" : composition.decision.reason,
      command: command._tag === "Success" ? "Accepted" : command.failure._tag,
      contributingRuleIds: composition.contributingRuleIds,
      requirementSources:
        composition.requirements._tag === "Ambiguous"
          ? composition.requirements.sourceRuleIds
          : composition.requirements.requirements.map((requirement) => ({
              requirementId: requirement.requirement.id,
              sourceRuleIds: requirement.sourceRuleIds,
              result: requirement.result._tag,
            })),
      auditDelta: after.auditCount - before.auditCount,
      transitionDelta: after.revision - before.revision,
      outboxDelta: after.outboxCount - before.outboxCount,
    };
  });

const trace = Effect.gen(function* () {
  const sql = yield* Database;
  yield* seed(sql);
  const pending = yield* traceReceipt(sql, "rule-reconciliation-pending");
  const nonpending = yield* traceReceipt(sql, "rule-reconciliation-nonpending");
  const foreign = yield* traceReceipt(sql, "rule-reconciliation-foreign");

  assert.equal(pending.decision, "Allow");
  assert.equal(pending.command, "Accepted");
  assert(pending.transitionDelta > 0);
  assert(pending.auditDelta > 0);
  assert(pending.outboxDelta > 0);
  assert.equal(nonpending.decision, "RequirementFailed");
  assert.equal(nonpending.command, "FailedComposedRequirement");
  assert.equal(nonpending.transitionDelta, 0);
  assert.equal(nonpending.auditDelta, 0);
  assert.equal(nonpending.outboxDelta, 0);
  assert.equal(foreign.decision, "RequirementFailed");
  assert.equal(foreign.command, "FailedComposedRequirement");
  assert.equal(foreign.transitionDelta, 0);
  assert.equal(foreign.auditDelta, 0);
  assert.equal(foreign.outboxDelta, 0);
  const allRuleIds = [
    "rule-reconciliation-approver",
    "rule-reconciliation-delegate",
    "rule-reconciliation-pending-a",
    "rule-reconciliation-pending-b",
  ];
  assert.deepEqual(pending.contributingRuleIds, allRuleIds);
  assert.deepEqual(nonpending.contributingRuleIds, allRuleIds);
  assert.deepEqual(foreign.contributingRuleIds, allRuleIds);
  const pendingRequirement = {
    requirementId: "receipts.pending",
    sourceRuleIds: ["rule-reconciliation-pending-a", "rule-reconciliation-pending-b"],
    result: "Satisfied",
  };
  const approverRequirement = {
    requirementId: "receipts.approver-relationship",
    sourceRuleIds: ["rule-reconciliation-approver"],
    result: "Satisfied",
  };
  assert.deepEqual(pending.requirementSources, [pendingRequirement, approverRequirement]);
  assert.deepEqual(nonpending.requirementSources, [{ ...pendingRequirement, result: "Failed" }]);
  assert.deepEqual(foreign.requirementSources, [
    pendingRequirement,
    { ...approverRequirement, result: "Failed" },
  ]);
  return { pending, nonpending, foreign };
});

export const makeRuleReconciliationTracerProgram = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    assertDisposablePostgres(databaseUrl);
    const migrationPreflight = yield* proveRuleReconciliationMigration(databaseUrl);
    const layer = DatabaseLive({
      url: Redacted.make(Redacted.value(databaseUrl)),
      applicationName: "rule-reconciliation-tracer-0056-2",
      maxConnections: 1,
    });
    const receipts = yield* trace.pipe(
      Effect.ensuring(Database.use(resetDatabase)),
      Effect.provide(layer),
    );
    const evidence = {
      migrationPreflight: {
        invalidRowCount: migrationPreflight.invalidRows.length,
        invalidRows: migrationPreflight.invalidRows,
        preservedConstraint: migrationPreflight.preservedConstraint,
        validRowCount: migrationPreflight.validRuleIds.length,
        validRuleIds: migrationPreflight.validRuleIds,
      },
      receipts,
    };
    yield* Effect.sync(() => process.stdout.write(`${canonicalJson(evidence)}\n`));
  });
