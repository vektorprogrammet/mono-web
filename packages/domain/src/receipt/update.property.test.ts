import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { ReceiptActor, ReceiptFile } from "./schema.js";
import { decideReceipt } from "./update.js";

const propertyOptions = {
  fastCheck: { seed: 22082034, numRuns: 100 },
} as const;

const owner: ReceiptActor = {
  personId: "property-owner",
  departmentId: "property-department",
  active: true,
  approvalScope: { _tag: "None" },
};

const approver: ReceiptActor = {
  personId: "property-approver",
  departmentId: "property-department",
  active: true,
  approvalScope: { _tag: "Department", departmentId: "property-department" },
};

const file: ReceiptFile = {
  fileRef: "staged/property-file",
  objectKey: "receipts/property-file",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const context = {
  receiptId: "property-receipt",
  visualId: "PROPERTY-1",
  now: "2026-08-20T12:00:00.000Z",
};

const submit = (amount: number) => ({
  _tag: "SubmitReceipt" as const,
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
        {
          _tag: "RevisePendingReceipt",
          commandId: "property-revise",
          actor: owner,
          receiptId: submitted.receipt.receiptId,
          expectedRevision: 0,
          description: "Revised property receipt",
          amountOre: positiveAmount(amount) + 1,
          receiptDate: "2026-08-21",
          file,
        },
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
  "withdrawn, refunded, and rejected Receipts are terminal",
  { amount: Schema.Int },
  ({ amount }) =>
    Effect.gen(function* () {
      const terminalCommands = [
        { _tag: "WithdrawPendingReceipt" as const, actor: owner },
        { _tag: "RefundReceipt" as const, actor: approver },
        { _tag: "RejectReceipt" as const, actor: approver },
      ];
      for (const [index, terminal] of terminalCommands.entries()) {
        const submitted = yield* decideReceipt(
          undefined,
          { ...submit(positiveAmount(amount)), commandId: `property-submit-${index}` },
          { ...context, receiptId: `property-receipt-${index}`, visualId: `PROPERTY-${index}` },
        );
        const result = yield* decideReceipt(
          submitted.receipt,
          {
            ...terminal,
            commandId: `property-terminal-${index}`,
            receiptId: submitted.receipt.receiptId,
            expectedRevision: 0,
          },
          context,
        );
        const secondTransition = yield* Effect.exit(
          decideReceipt(
            result.receipt,
            {
              _tag: "WithdrawPendingReceipt",
              commandId: `property-reopen-${index}`,
              actor: owner,
              receiptId: result.receipt.receiptId,
              expectedRevision: 1,
            },
            context,
          ),
        );
        expect(secondTransition._tag).toBe("Failure");
        expect(result.receipt.revision).toBe(1);
      }
    }),
  propertyOptions,
);
