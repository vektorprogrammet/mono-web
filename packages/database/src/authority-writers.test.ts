import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Scope } from "@vektorprogrammet/domain/authz";
import { Database } from "./service.js";
import {
  OrganizationGlobalAdministratorGrantId,
  OrganizationAuthorityWriteConflict,
  OrganizationDecodeError,
} from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  ReceiptApprovalGrantId,
  ReceiptAuthorityWriteConflict,
  ReceiptDecodeError,
  ReceiptPaymentAuthorityId,
} from "@vektorprogrammet/domain/receipt";
import {
  createOrganizationGlobalAdministratorGrant,
  endOrganizationGlobalAdministratorGrant,
  removeOrganizationGlobalAdministratorGrant,
} from "./organization/authority-postgres.js";
import {
  createReceiptApprovalGrant,
  createReceiptPaymentAuthority,
  endReceiptApprovalGrant,
  endReceiptPaymentAuthority,
  removeReceiptApprovalGrant,
  removeReceiptPaymentAuthority,
} from "./receipt/authority-postgres.js";
import { makeControlledTestRuntime } from "../test/runtime.js";
import { DatabaseTest } from "./layers.js";

const runtime = makeControlledTestRuntime(DatabaseTest());

const personId = PersonId.make("authority-writer-person");

const departmentId = DepartmentId.make("authority-writer-department");

const grantId = OrganizationGlobalAdministratorGrantId.make("authority-writer-global-admin");

const paymentAuthorityId = ReceiptPaymentAuthorityId.make("authority-writer-payment");

const approvalGrantId = ReceiptApprovalGrantId.make("authority-writer-approval");

const startAt = "2040-01-01T00:00:00.000Z";

const endAt = "2040-06-01T00:00:00.000Z";

const seedReferences = Effect.gen(function* () {
  const database = yield* Database;
  yield* database`
    INSERT INTO public.person_profiles (person_id, first_name, last_name)
    VALUES (${personId}, 'Authority', 'Writer')
    ON CONFLICT (person_id) DO NOTHING
  `;
  yield* database`
    INSERT INTO public.organization_departments (
      department_id, name, short_name, email, city
    ) VALUES (
      ${departmentId}, 'Authority Writer Department', 'AWD',
      'authority-writer@example.invalid', 'Trondheim'
    ) ON CONFLICT (department_id) DO NOTHING
  `;
});

afterAll(async () => {
  await runtime.dispose();
});

describe("person-keyed authority writers in PGlite", () => {
  it("creates, optimistically ends, and removes the Organization global-admin grant", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedReferences;

        const created = yield* createOrganizationGlobalAdministratorGrant({
          grantId,
          personId,
          startAt,
          endAt: null,
        });

        const stale = yield* Effect.flip(
          endOrganizationGlobalAdministratorGrant({
            grantId,
            endAt,
            expectedRevision: 9,
          }),
        );

        const ended = yield* endOrganizationGlobalAdministratorGrant({
          grantId,
          endAt,
          expectedRevision: 0,
        });

        const removed = yield* removeOrganizationGlobalAdministratorGrant({
          grantId,
          expectedRevision: 1,
        });

        const database = yield* Database;

        const rows = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS count
          FROM public.organization_global_administrator_grants
          WHERE grant_id = ${grantId}
        `;

        return { created, stale, ended, removed, count: rows[0]?.count };
      }),
    );

    expect(evidence.created).toMatchObject({ grantId, personId, endAt: null, revision: 0 });
    expect(evidence.stale).toBeInstanceOf(OrganizationAuthorityWriteConflict);
    expect(evidence.ended).toMatchObject({ grantId, endAt, revision: 1 });
    expect(evidence.removed).toMatchObject({ grantId, endAt, revision: 1 });
    expect(evidence.count).toBe("0");
  }, 15_000);

  it("creates, optimistically ends, and removes Economy payment and approval authority", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedReferences;

        const payment = yield* createReceiptPaymentAuthority({
          paymentAuthorityId,
          personId,
          departmentId,
          paymentAccountCiphertext: "ciphertext:authority-writer",
          startAt,
          endAt: null,
        });

        const approval = yield* createReceiptApprovalGrant({
          approvalGrantId,
          personId,
          scope: Scope.Department({ departmentId }),
          startAt,
          endAt: null,
        });

        const endedPayment = yield* endReceiptPaymentAuthority({
          paymentAuthorityId,
          endAt,
          expectedRevision: 0,
        });

        const endedApproval = yield* endReceiptApprovalGrant({
          approvalGrantId,
          endAt,
          expectedRevision: 0,
        });

        const staleRemoval = yield* Effect.flip(
          removeReceiptPaymentAuthority({
            paymentAuthorityId,
            expectedRevision: 0,
          }),
        );

        const removedPayment = yield* removeReceiptPaymentAuthority({
          paymentAuthorityId,
          expectedRevision: 1,
        });

        const removedApproval = yield* removeReceiptApprovalGrant({
          approvalGrantId,
          expectedRevision: 1,
        });

        const database = yield* Database;

        const rows = yield* database<{
          readonly paymentCount: string;
          readonly approvalCount: string;
        }>`
          SELECT
            (SELECT count(*)::text FROM public.economy_payment_authorities
              WHERE payment_authority_id = ${paymentAuthorityId}) AS "paymentCount",
            (SELECT count(*)::text FROM public.economy_receipt_approval_grants
              WHERE approval_grant_id = ${approvalGrantId}) AS "approvalCount"
        `;

        return {
          payment,
          approval,
          endedPayment,
          endedApproval,
          staleRemoval,
          removedPayment,
          removedApproval,
          counts: rows[0],
        };
      }),
    );

    expect(evidence.payment).toMatchObject({ paymentAuthorityId, personId, revision: 0 });
    expect(evidence.approval).toMatchObject({ approvalGrantId, personId, revision: 0 });
    expect(evidence.endedPayment).toMatchObject({ paymentAuthorityId, endAt, revision: 1 });
    expect(evidence.endedApproval).toMatchObject({ approvalGrantId, endAt, revision: 1 });
    expect(evidence.staleRemoval).toBeInstanceOf(ReceiptAuthorityWriteConflict);
    expect(evidence.removedPayment.revision).toBe(1);
    expect(evidence.removedApproval.revision).toBe(1);
    expect(evidence.counts).toEqual({ paymentCount: "0", approvalCount: "0" });
  }, 15_000);

  it("strictly rejects decoder-invalid create inputs before persistence", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedReferences;

        const paddedCiphertext = yield* Effect.flip(
          createReceiptPaymentAuthority({
            paymentAuthorityId: ReceiptPaymentAuthorityId.make("authority-writer-invalid-payment"),
            personId,
            departmentId,
            paymentAccountCiphertext: "\tciphertext:invalid",
            startAt,
            endAt: null,
          }),
        );

        const excessInput = {
          grantId: OrganizationGlobalAdministratorGrantId.make("authority-writer-invalid-admin"),
          personId,
          startAt,
          endAt: null,
          revision: 0,
        };

        const excessProperty = yield* Effect.flip(
          createOrganizationGlobalAdministratorGrant(excessInput),
        );

        return { paddedCiphertext, excessProperty };
      }),
    );

    expect(evidence.paddedCiphertext).toBeInstanceOf(ReceiptDecodeError);
    expect(evidence.excessProperty).toBeInstanceOf(OrganizationDecodeError);
  }, 15_000);
});
