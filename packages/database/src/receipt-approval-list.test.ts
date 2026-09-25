import { afterAll, describe, expect, it } from "vitest";
import { Database } from "./service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Economy, decodeReceiptCursor } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/database/receipt/postgres";
import { Effect, Layer } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const databaseLayer = DatabaseTest();

const runtime = makeControlledTestRuntime(
  Layer.merge(databaseLayer, EconomyLive.pipe(Layer.provide(databaseLayer))),
);

afterAll(async () => {
  await runtime.dispose();
});

describe("rule-aware Receipt approval projection in PGlite", () => {
  it("unions direct and rule scopes without broadening a Department rule", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const economy = yield* Economy;
        const departmentA = DepartmentId.make("approval-query-department-a");
        const departmentB = DepartmentId.make("approval-query-department-b");
        const authorizationInstant = "2038-06-15T12:00:00.000Z";
        const directGlobal = PersonId.make("approval-query-direct-global");
        const directDepartment = PersonId.make("approval-query-direct-department");
        const ruleDepartment = PersonId.make("approval-query-rule-department");
        const ruleGlobal = PersonId.make("approval-query-rule-global");
        const scopedGlobalSlot = PersonId.make("approval-query-scoped-global-slot");
        const multipleScopes = PersonId.make("approval-query-multiple-scopes");
        const expiredRule = PersonId.make("approval-query-expired-rule");
        const detachedTag = PersonId.make("approval-query-detached-tag");
        const noRule = PersonId.make("approval-query-no-rule");

        yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES
            (${directGlobal}, 'Direct', 'Global'),
            (${directDepartment}, 'Direct', 'Department'),
            (${ruleDepartment}, 'Rule', 'Department'),
            (${ruleGlobal}, 'Rule', 'Global'),
            (${scopedGlobalSlot}, 'Scoped', 'GlobalSlot'),
            (${multipleScopes}, 'Multiple', 'Scopes'),
            (${expiredRule}, 'Expired', 'Rule'),
            (${detachedTag}, 'Detached', 'Tag'),
            (${noRule}, 'No', 'Rule')
        `;
        yield* database`
          INSERT INTO public.organization_departments (
            department_id, name, short_name, email, city
          ) VALUES
            (${departmentA}, 'Approval Department A', 'AQA',
              'approval-a@example.invalid', 'Bergen'),
            (${departmentB}, 'Approval Department B', 'AQB',
              'approval-b@example.invalid', 'Trondheim')
        `;
        yield* database`
          INSERT INTO public.organization_teams (team_id, department_id, name)
          VALUES
            ('approval-query-team-a', ${departmentA}, 'Approval Team A'),
            ('approval-query-team-b', ${departmentB}, 'Approval Team B')
        `;
        yield* database`
          INSERT INTO public.organization_memberships (
            membership_id, person_id, team_id, start_at
          ) VALUES
            ('approval-query-membership-direct-global', ${directGlobal},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-direct-department', ${directDepartment},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-rule-department', ${ruleDepartment},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-rule-global', ${ruleGlobal},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-scoped-global', ${scopedGlobalSlot},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-multiple-a', ${multipleScopes},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-multiple-b', ${multipleScopes},
              'approval-query-team-b', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-expired', ${expiredRule},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-detached', ${detachedTag},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z'),
            ('approval-query-membership-none', ${noRule},
              'approval-query-team-a', '2038-01-01T00:00:00.000Z')
        `;
        yield* database`
          INSERT INTO public.economy_receipt_approval_grants (
            approval_grant_id, person_id, scope, department_id, start_at
          ) VALUES
            ('approval-query-grant-global', ${directGlobal}, 'Global', NULL,
              '2038-01-01T00:00:00.000Z'),
            ('approval-query-grant-department', ${directDepartment}, 'Department',
              ${departmentA}, '2038-01-01T00:00:00.000Z'),
            ('approval-query-grant-multiple', ${multipleScopes}, 'Department',
              ${departmentA}, '2038-01-01T00:00:00.000Z')
        `;
        yield* database`
          INSERT INTO public.authz_tags (tag_id, name)
          VALUES ('approval-query-tag', 'Approval Query Tag')
        `;
        yield* database`
          INSERT INTO public.authz_tag_assignments (
            assignment_id, tag_id, person_id, start_at, end_at
          ) VALUES (
            'approval-query-detached-assignment', 'approval-query-tag', ${detachedTag},
            '2038-01-01T00:00:00.000Z', ${authorizationInstant}
          )
        `;
        yield* database`
          INSERT INTO public.authz_rules (
            rule_id, capability_id, effect_kind, subject_kind, subject_person_id,
            subject_tag_id, scope, department_id, params, start_at, end_at
          ) VALUES
            (
              'approval-query-rule-department', 'approveReceipt', 'delegate', 'Person',
              ${ruleDepartment}, NULL, 'Department', ${departmentA},
              ${database.json({ slot: "EconomyDepartmentApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', NULL
            ),
            (
              'approval-query-rule-global', 'approveReceipt', 'delegate', 'Person',
              ${ruleGlobal}, NULL, 'Global', NULL,
              ${database.json({ slot: "EconomyGlobalReceiptApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', NULL
            ),
            (
              'approval-query-rule-scoped-global', 'approveReceipt', 'delegate', 'Person',
              ${scopedGlobalSlot}, NULL, 'Department', ${departmentA},
              ${database.json({ slot: "EconomyGlobalReceiptApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', NULL
            ),
            (
              'approval-query-rule-multiple', 'approveReceipt', 'delegate', 'Person',
              ${multipleScopes}, NULL, 'Department', ${departmentB},
              ${database.json({ slot: "EconomyDepartmentApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', NULL
            ),
            (
              'approval-query-rule-expired', 'approveReceipt', 'delegate', 'Person',
              ${expiredRule}, NULL, 'Department', ${departmentA},
              ${database.json({ slot: "EconomyDepartmentApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', '2038-06-01T00:00:00.000Z'
            ),
            (
              'approval-query-rule-tagged', 'approveReceipt', 'delegate', 'Tag',
              NULL, 'approval-query-tag', 'Department', ${departmentA},
              ${database.json({ slot: "EconomyDepartmentApprovalGrant" })},
              '2038-01-01T00:00:00.000Z', NULL
            )
        `;
        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, submitted_at, status, approved_at,
            payment_account_ciphertext, file_ref, file_object_key, file_content_type,
            file_byte_length, file_sha256, revision
          ) VALUES
            (
              'approval-query-receipt-a', 'APPROVAL-A', 'approval-query-owner',
              ${departmentA}, 1000, 'NOK', 'Department A receipt', '2038-06-10',
              '2038-06-10T12:00:00.000Z', 'Pending', NULL, 'ciphertext:a',
              'approval-query-file-a', 'approval-query-object-a', 'application/pdf',
              100, ${"a".repeat(64)}, 0
            ),
            (
              'approval-query-receipt-b', 'APPROVAL-B', 'approval-query-owner',
              ${departmentB}, 2000, 'NOK', 'Department B receipt', '2038-06-11',
              '2038-06-11T12:00:00.000Z', 'Rejected', NULL, 'ciphertext:b',
              'approval-query-file-b', 'approval-query-object-b', 'application/pdf',
              200, ${"b".repeat(64)}, 0
            )
        `;

        const list = (queryPersonId: PersonId, status?: "Pending" | "Rejected") =>
          economy.listReceiptsForApproval(queryPersonId, authorizationInstant, status);

        const directGlobalRows = yield* list(directGlobal);
        const directDepartmentRows = yield* list(directDepartment);
        const ruleDepartmentRows = yield* list(ruleDepartment);
        const ruleGlobalRows = yield* list(ruleGlobal);
        const scopedGlobalRows = yield* list(scopedGlobalSlot);
        const multipleRows = yield* list(multipleScopes);
        const filteredRows = yield* list(directGlobal, "Rejected");
        const expiredFailure = yield* Effect.flip(list(expiredRule));
        const detachedFailure = yield* Effect.flip(list(detachedTag));
        const noRuleFailure = yield* Effect.flip(list(noRule));

        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, submitted_at, status, approved_at,
            payment_account_ciphertext, file_ref, file_object_key, file_content_type,
            file_byte_length, file_sha256, revision
          ) SELECT
            'approval-page-' || side || '-' || lpad(n::text, 3, '0'),
            'APPROVAL-PAGE-' || side || '-' || n, 'approval-query-owner', department_id,
            1000, 'NOK', 'Paged receipt', '2038-06-13',
            CASE WHEN side = 'b' THEN '2038-06-14T12:00:00.123456Z'::timestamptz
              ELSE '2038-06-13T12:00:00.123456Z'::timestamptz END,
            'Pending', NULL, 'ciphertext:page',
            'approval-page-file-' || side || '-' || n,
            'approval-page-object-' || side || '-' || n,
            'application/pdf', 100, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0
          FROM generate_series(0, 59) AS n
          CROSS JOIN (VALUES ('a', ${departmentA}), ('b', ${departmentB})) AS departments(side, department_id)
        `;
        const firstPage = yield* list(ruleDepartment, "Pending");

        if (firstPage.nextCursor === undefined)
          throw new Error("First approval page lost continuation");
        const firstCursor = yield* decodeReceiptCursor(firstPage.nextCursor);
        yield* database`UPDATE public.economy_receipts SET status = 'Approved', approved_at = '2038-06-15T11:00:00Z'
          WHERE receipt_id = 'approval-page-a-000'`;
        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, submitted_at, status, approved_at,
            payment_account_ciphertext, file_ref, file_object_key, file_content_type,
            file_byte_length, file_sha256, revision
          ) SELECT 'approval-page-new', 'APPROVAL-PAGE-NEW', owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, '2038-06-15T11:00:00Z', 'Pending', NULL,
            payment_account_ciphertext, 'approval-page-file-new', 'approval-page-object-new', file_content_type,
            file_byte_length, file_sha256, revision
          FROM public.economy_receipts WHERE receipt_id = 'approval-page-a-000'
        `;

        const nextPage = yield* economy.listReceiptsForApproval(
          ruleDepartment,
          authorizationInstant,
          "Pending",
          firstPage.nextCursor,
        );

        const pageDenied = yield* Effect.flip(
          economy.listReceiptsForApproval(
            noRule,
            authorizationInstant,
            "Pending",
            firstPage.nextCursor,
          ),
        );

        const ownerFirst = yield* economy.listOwnedReceipts("approval-query-owner", "Pending");

        if (ownerFirst.nextCursor === undefined)
          throw new Error("First owner page lost continuation");

        const ownerNext = yield* economy.listOwnedReceipts(
          "approval-query-owner",
          "Pending",
          ownerFirst.nextCursor,
        );

        const pagination = {
          first: firstPage.items.map((row) => row.receiptId),
          cursor: firstCursor,
          next: nextPage.items.map((row) => row.receiptId),
          nextCursor: nextPage.nextCursor,
          denied: pageDenied._tag,
          ownerFirst: ownerFirst.items.map((row) => row.receiptId),
          ownerNext: ownerNext.items.map((row) => row.receiptId),
        };

        return {
          pagination,
          directGlobal: directGlobalRows.items.map((row) => row.receiptId),
          directDepartment: directDepartmentRows.items.map((row) => row.receiptId),
          ruleDepartment: ruleDepartmentRows.items.map((row) => row.receiptId),
          ruleGlobal: ruleGlobalRows.items.map((row) => row.receiptId),
          scopedGlobal: scopedGlobalRows.items.map((row) => row.receiptId),
          multiple: multipleRows.items.map((row) => row.receiptId),
          filtered: filteredRows.items.map((row) => row.receiptId),
          expiredFailure: expiredFailure._tag,
          detachedFailure: detachedFailure._tag,
          noRuleFailure: noRuleFailure._tag,
        };
      }),
    );

    const { pagination, ...authorityEvidence } = evidence;
    expect(authorityEvidence).toEqual({
      directGlobal: ["approval-query-receipt-b", "approval-query-receipt-a"],
      directDepartment: ["approval-query-receipt-a"],
      ruleDepartment: ["approval-query-receipt-a"],
      ruleGlobal: ["approval-query-receipt-b", "approval-query-receipt-a"],
      scopedGlobal: ["approval-query-receipt-a"],
      multiple: ["approval-query-receipt-b", "approval-query-receipt-a"],
      filtered: ["approval-query-receipt-b"],
      expiredFailure: "ReceiptScopeDenied",
      detachedFailure: "ReceiptScopeDenied",
      noRuleFailure: "ReceiptScopeDenied",
    });
    expect(pagination.first).toEqual(
      Array.from({ length: 50 }, (_, index) => `approval-page-a-${String(index).padStart(3, "0")}`),
    );
    expect(pagination.cursor).toEqual({
      timestamp: "2038-06-13T12:00:00.123456Z",
      receiptId: "approval-page-a-049",
    });
    expect(pagination.next).toEqual([
      ...Array.from(
        { length: 10 },
        (_, index) => `approval-page-a-${String(index + 50).padStart(3, "0")}`,
      ),
      "approval-query-receipt-a",
    ]);
    expect(pagination.nextCursor).toBeUndefined();
    expect(pagination.denied).toBe("ReceiptScopeDenied");
    expect(pagination.ownerFirst).toEqual([
      "approval-page-new",
      ...Array.from(
        { length: 49 },
        (_, index) => `approval-page-b-${String(index).padStart(3, "0")}`,
      ),
    ]);
    expect(pagination.ownerNext).toEqual([
      ...Array.from(
        { length: 11 },
        (_, index) => `approval-page-b-${String(index + 49).padStart(3, "0")}`,
      ),
      ...Array.from(
        { length: 39 },
        (_, index) => `approval-page-a-${String(index + 1).padStart(3, "0")}`,
      ),
    ]);
  }, 15_000);
});
