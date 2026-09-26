import assert from "node:assert/strict";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain";
import {
  ApprovalScopeSchema,
  AuthorizedReceiptCommandSchema,
  decideReceipt,
  Receipt,
} from "@vektorprogrammet/domain/receipt";
import { Console, Effect, Schema } from "effect";

const context = {
  receiptId: "example-receipt",
  visualId: "example-visual",
  now: "2026-09-25T12:00:00Z",
};

// Synthetic decision inputs, not authenticated authority or stored private bytes.
const owner = {
  personId: PersonId.make("example-owner"),
  departmentId: DepartmentId.make("example-department"),
  active: true,
  approvalScope: ApprovalScopeSchema.cases.None.make({}),
};

const approver = {
  ...owner,
  personId: PersonId.make("example-approver"),
  approvalScope: ApprovalScopeSchema.cases.Department.make({ departmentId: owner.departmentId }),
};

const program = Effect.gen(function* () {
  const submitted = yield* decideReceipt(
    undefined,
    AuthorizedReceiptCommandSchema.cases.SubmitReceipt.make({
      commandId: "example-submit",
      actor: owner,
      departmentId: owner.departmentId,
      paymentAccountCiphertext: "synthetic-ciphertext-not-a-payment-account",
      description: "Travel to a school visit",
      amountOre: 12500,
      receiptDate: "2026-09-24",
      file: {
        fileRef: "staging/example-file",
        objectKey: "committed/example-file",
        contentType: "application/pdf",
        byteLength: 1,
        sha256: "0".repeat(64),
      },
    }),
    context,
  );

  assert.equal(submitted.receipt.status, "Pending");

  const approval = AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
    commandId: "example-approve",
    receiptId: submitted.receipt.receiptId,
    expectedRevision: submitted.receipt.revision,
    actor: approver,
  });

  const denied = yield* Effect.flip(
    decideReceipt(submitted.receipt, { ...approval, actor: owner }, context),
  );

  assert.equal(denied._tag, "ReceiptScopeDenied");

  const approved = yield* decideReceipt(submitted.receipt, approval, context);

  assert.equal(approved.receipt.status, "Approved");
  assert.equal(approved.receipt.revision, submitted.receipt.revision + 1);

  const stale = yield* Effect.flip(
    decideReceipt(approved.receipt, { ...approval, commandId: "example-stale" }, context),
  );

  assert.equal(stale._tag, "StaleReceiptRevision");

  const publicReceipt = yield* Schema.encodeEffect(Receipt.json)(approved.receipt);

  assert.equal(publicReceipt.status, "Approved");
  assert.equal(Object.hasOwn(publicReceipt, "paymentAccountCiphertext"), false);
  assert.equal(Object.hasOwn(publicReceipt, "file"), false);

  yield* Console.log(
    "Pending -> Approved; owner approval denied; stale revision rejected; public encoding omits private fields. No persistence, delivery, or payment occurred.",
  );
});

await Effect.runPromise(program);
