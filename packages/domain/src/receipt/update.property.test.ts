import { Scope } from "../authz/access.js";
import { expect, it } from "@effect/vitest";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { Effect, Schema } from "effect";
import type { CheckOptions } from "effect/unstable/arbitrary/Arbitrary";
import { ReceiptId, type ReceiptActor, type ReceiptFile, ApprovalScopeSchema } from "./schema.js";
import { AuthorizedReceiptCommandSchema, decideReceipt } from "./update.js";

const propertyOptions = {
  arbitrary: { seed: 22082034, runs: 100 } satisfies CheckOptions,
} as const;

const owner: ReceiptActor = {
  personId: PersonId.make("property-owner"),
  departmentId: DepartmentId.make("property-department"),
  active: true,
  approvalScope: ApprovalScopeSchema.cases.None.make({}),
};

const approver: ReceiptActor = {
  personId: PersonId.make("property-approver"),
  departmentId: DepartmentId.make("property-department"),
  active: true,
  approvalScope: Scope.Department({ departmentId: DepartmentId.make("property-department") }),
};

const file: ReceiptFile = {
  fileRef: "staged/property-file",
  objectKey: "receipts/property-file",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const context = {
  receiptId: ReceiptId.make("property-receipt"),
  visualId: "PROPERTY-1",
  now: "2026-08-20T12:00:00.000Z",
};

const submit = (amount: number) =>
  AuthorizedReceiptCommandSchema.cases.SubmitReceipt.make({
    commandId: "property-submit",
    actor: owner,
    departmentId: owner.departmentId,
    paymentAccountCiphertext: "ciphertext:v1:property-account",
    description: "Property receipt",
    amountOre: amount,
    receiptDate: "2026-08-20",
    file,
  });

const positiveAmount = (generated: number): number => (Math.abs(generated) % 1_000_000_000) + 1;

it.effect.prop(
  "revision preserves Receipt identity and increments exactly once",
  { amount: Schema.Int },
  ({ amount }) =>
    Effect.gen(function* () {
      const submitted = yield* decideReceipt(undefined, submit(positiveAmount(amount)), context);

      const revised = yield* decideReceipt(
        submitted.receipt,
        AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
          commandId: "property-revise",
          actor: owner,
          receiptId: submitted.receipt.receiptId,
          expectedRevision: 0,
          description: "Revised property receipt",
          amountOre: positiveAmount(amount) + 1,
          receiptDate: "2026-08-21",
          file,
        }),
        { ...context, now: "2026-08-20T12:01:00.000Z" },
      );

      expect(revised.receipt).toMatchObject({
        receiptId: submitted.receipt.receiptId,
        visualId: submitted.receipt.visualId,
        ownerPersonId: submitted.receipt.ownerPersonId,
        departmentId: submitted.receipt.departmentId,
        submittedAt: submitted.receipt.submittedAt,
        status: "Pending",
        revision: 1,
      });
    }),
  propertyOptions,
);

it.effect.prop(
  "owners cannot withdraw withdrawn, approved, or rejected Receipts",
  { amount: Schema.Int },
  ({ amount }) =>
    Effect.gen(function* () {
      const terminalCommands = [
        { command: AuthorizedReceiptCommandSchema.cases.WithdrawPendingReceipt, actor: owner },
        { command: AuthorizedReceiptCommandSchema.cases.ApproveReceipt, actor: approver },
        { command: AuthorizedReceiptCommandSchema.cases.RejectReceipt, actor: approver },
      ];

      for (const [index, terminal] of terminalCommands.entries()) {
        const submitted = yield* decideReceipt(
          undefined,
          { ...submit(positiveAmount(amount)), commandId: `property-submit-${index}` },
          { ...context, receiptId: `property-receipt-${index}`, visualId: `PROPERTY-${index}` },
        );

        const result = yield* decideReceipt(
          submitted.receipt,
          terminal.command.make({
            actor: terminal.actor,
            commandId: `property-terminal-${index}`,
            receiptId: submitted.receipt.receiptId,
            expectedRevision: 0,
          }),
          context,
        );

        const secondTransition = yield* Effect.exit(
          decideReceipt(
            result.receipt,
            AuthorizedReceiptCommandSchema.cases.WithdrawPendingReceipt.make({
              commandId: `property-reopen-${index}`,
              actor: owner,
              receiptId: result.receipt.receiptId,
              expectedRevision: 1,
            }),
            context,
          ),
        );

        expect(secondTransition._tag).toBe("Failure");
        expect(result.receipt.revision).toBe(1);
      }
    }),
  propertyOptions,
);
