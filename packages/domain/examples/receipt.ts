import assert from "node:assert/strict";
import { decideReceipt, Receipt } from "@vektorprogrammet/domain/receipt";
import { Effect, Schema } from "effect";

const context = {
  receiptId: "example-receipt",
  visualId: "example-visual",
  now: "2026-09-25T12:00:00Z",
};

// Synthetic decision inputs, not authenticated authority or stored private bytes.
const owner = {
  personId: "example-owner",
  departmentId: "example-department",
  active: true,
  approvalScope: { _tag: "None" },
};

const approver = {
  ...owner,
  personId: "example-approver",
  approvalScope: { _tag: "Department", departmentId: owner.departmentId },
};

const program = Effect.gen(function* () {
  const submitted = yield* decideReceipt(
    undefined,
    {
      _tag: "SubmitReceipt",
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
    },
    context,
  );

  assert.equal(submitted.receipt.status, "Pending");

  const approval = {
    _tag: "ApproveReceipt",
    commandId: "example-approve",
    receiptId: submitted.receipt.receiptId,
    expectedRevision: submitted.receipt.revision,
    actor: approver,
  };

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

  console.log(
    "Pending -> Approved; owner approval denied; stale revision rejected; public encoding omits private fields. No persistence, delivery, or payment occurred.",
  );
});

await Effect.runPromise(program);
