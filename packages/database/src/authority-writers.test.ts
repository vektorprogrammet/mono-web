import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import {
  OrganizationGlobalAdministratorGrantId,
  OrganizationAuthorityWriteConflict,
  createOrganizationGlobalAdministratorGrant,
  endOrganizationGlobalAdministratorGrant,
  removeOrganizationGlobalAdministratorGrant,
  lockOrganizationGlobalAdministratorGrantForWrite,
} from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  ReceiptApprovalGrantId,
  ReceiptAuthorityWriteConflict,
  ReceiptPaymentAuthorityId,
  createReceiptApprovalGrant,
  createReceiptPaymentAuthority,
  endReceiptApprovalGrant,
  endReceiptPaymentAuthority,
  lockReceiptApprovalGrantForWrite,
  lockReceiptPaymentAuthorityForWrite,
  removeReceiptApprovalGrant,
  removeReceiptPaymentAuthority,
} from "@vektorprogrammet/domain/receipt";
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
  it("takes the canonical person lock before direct authority rows and inserts", async () => {
    const events: Array<string> = [];
    const sql = ((
      strings: TemplateStringsArray,
      ...values: ReadonlyArray<unknown>
    ): Effect.Effect<ReadonlyArray<unknown>> => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) {
        events.push(`PersonLock:${String(values[0])}`);
        return Effect.succeed([]);
      }
      if (statement.includes("FROM public.organization_global_administrator_grants")) {
        if (statement.includes("FOR UPDATE")) {
          events.push("GlobalAdminRowLock");
          return Effect.succeed([{ grantId, personId, startAt, endAt: null, revision: 0 }]);
        }
        events.push("GlobalAdminPersonRead");
        return Effect.succeed([{ personId }]);
      }
      if (statement.includes("FROM public.economy_payment_authorities")) {
        if (statement.includes("FOR UPDATE")) {
          events.push("PaymentRowLock");
          return Effect.succeed([
            {
              authorityKind: "Payment",
              authorityId: paymentAuthorityId,
              personId,
              departmentId,
              paymentAccountCiphertext: "ciphertext:authority-writer",
              approvalScope: null,
              startAt,
              endAt: null,
              revision: 0,
            },
          ]);
        }
        events.push("PaymentPersonRead");
        return Effect.succeed([{ personId }]);
      }
      if (statement.includes("FROM public.economy_receipt_approval_grants")) {
        if (statement.includes("FOR UPDATE")) {
          events.push("ApprovalRowLock");
          return Effect.succeed([
            {
              authorityKind: "Approval",
              authorityId: approvalGrantId,
              personId,
              departmentId,
              paymentAccountCiphertext: null,
              approvalScope: "Department",
              startAt,
              endAt: null,
              revision: 0,
            },
          ]);
        }
        events.push("ApprovalPersonRead");
        return Effect.succeed([{ personId }]);
      }
      if (statement.includes("INSERT INTO public.organization_global_administrator_grants")) {
        events.push("GlobalAdminInsert");
        return Effect.succeed([]);
      }
      if (statement.includes("INSERT INTO public.economy_payment_authorities")) {
        events.push("PaymentInsert");
        return Effect.succeed([]);
      }
      if (statement.includes("INSERT INTO public.economy_receipt_approval_grants")) {
        events.push("ApprovalInsert");
        return Effect.succeed([]);
      }
      return Effect.die(`Unexpected authority writer statement: ${statement}`);
    }) as unknown as DatabaseShape;
    const database = Object.assign(sql, {
      withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program,
    });

    await runtime.runPromise(lockOrganizationGlobalAdministratorGrantForWrite(sql, grantId, 0));
    await runtime.runPromise(lockReceiptPaymentAuthorityForWrite(sql, paymentAuthorityId, 0));
    await runtime.runPromise(lockReceiptApprovalGrantForWrite(sql, approvalGrantId, 0));
    expect(events).toEqual([
      "GlobalAdminPersonRead",
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "GlobalAdminRowLock",
      "PaymentPersonRead",
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "PaymentRowLock",
      "ApprovalPersonRead",
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "ApprovalRowLock",
    ]);

    events.length = 0;
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* createOrganizationGlobalAdministratorGrant({
          grantId,
          personId,
          startAt,
          endAt: null,
        });
        yield* createReceiptPaymentAuthority({
          paymentAuthorityId,
          personId,
          departmentId,
          paymentAccountCiphertext: "ciphertext:authority-writer",
          startAt,
          endAt: null,
        });
        yield* createReceiptApprovalGrant({
          approvalGrantId,
          personId,
          scope: { _tag: "Department", departmentId },
          startAt,
          endAt: null,
        });
      }).pipe(Effect.provideService(Database, database)),
    );
    expect(events).toEqual([
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "GlobalAdminInsert",
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "PaymentInsert",
      `PersonLock:vektorprogrammet:person-authorization:v1:${personId}`,
      "ApprovalInsert",
    ]);
  });

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
          scope: { _tag: "Department", departmentId },
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
        const excessProperty = yield* Effect.flip(
          createOrganizationGlobalAdministratorGrant({
            grantId: OrganizationGlobalAdministratorGrantId.make("authority-writer-invalid-admin"),
            personId,
            startAt,
            endAt: null,
            revision: 0,
          }),
        );
        return { paddedCiphertext, excessProperty };
      }),
    );

    expect(evidence.paddedCiphertext).toMatchObject({ _tag: "ReceiptDecodeError" });
    expect(evidence.excessProperty).toMatchObject({ _tag: "OrganizationDecodeError" });
  }, 15_000);
});
