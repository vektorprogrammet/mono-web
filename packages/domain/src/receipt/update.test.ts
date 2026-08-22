import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  importLegacyReceipt,
  importLegacyReceipts,
  type ReceiptImportProvenance,
} from "./import.js";
import type { LegacyReceiptRow, ReceiptActor, ReceiptFile } from "./schema.js";
import { decideReceipt } from "./update.js";

const file: ReceiptFile = {
  fileRef: "file-1",
  objectKey: "tmp/file-1",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const owner: ReceiptActor = {
  personId: "person-1",
  departmentId: "department-1",
  active: true,
  approvalScope: { _tag: "None" },
};

const approver: ReceiptActor = {
  personId: "approver-1",
  departmentId: "department-1",
  active: true,
  approvalScope: { _tag: "Department", departmentId: "department-1" },
};

const context = {
  receiptId: "receipt-1",
  visualId: "REC-0001",
  now: "2026-08-20T12:00:00.000Z",
} as const;

const submit = {
  _tag: "SubmitReceipt",
  commandId: "command-submit",
  actor: owner,
  departmentId: "department-1",
  paymentAccountCiphertext: "ciphertext:v1:account",
  description: "Travel",
  amountOre: 12_345,
  receiptDate: "2026-08-19",
  file,
} as const;

it.effect("submits, revises, and withdraws only a pending owner receipt", () =>
  Effect.gen(function* () {
    const submitted = yield* decideReceipt(undefined, submit, context);
    expect(submitted.receipt.status).toBe("Pending");
    expect(submitted.receipt.amountOre).toBe(12_345);
    expect(submitted.outbox.map((item) => item._tag)).toEqual([
      "PromoteReceiptFile",
      "NotifyEconomyReceiptSubmitted",
      "WriteReceiptAudit",
    ]);

    const revised = yield* decideReceipt(
      submitted.receipt,
      {
        _tag: "RevisePendingReceipt",
        commandId: "command-revise",
        actor: owner,
        receiptId: "receipt-1",
        expectedRevision: 0,
        description: "Travel and tolls",
        amountOre: 13_000,
        receiptDate: "2026-08-19",
        file,
      },
      { ...context, now: "2026-08-20T12:01:00.000Z" },
    );
    expect(revised.receipt.revision).toBe(1);
    expect(revised.receipt.submittedAt).toBe(context.now);

    const withdrawn = yield* decideReceipt(
      revised.receipt,
      {
        _tag: "WithdrawPendingReceipt",
        commandId: "command-withdraw",
        actor: owner,
        receiptId: "receipt-1",
        expectedRevision: 1,
      },
      { ...context, now: "2026-08-20T12:02:00.000Z" },
    );
    expect(withdrawn.receipt.status).toBe("Withdrawn");

    const terminal = yield* Effect.flip(
      decideReceipt(
        withdrawn.receipt,
        {
          _tag: "RefundReceipt",
          commandId: "command-refund-terminal",
          actor: approver,
          receiptId: "receipt-1",
          expectedRevision: 2,
        },
        { ...context, now: "2026-08-20T12:03:00.000Z" },
      ),
    );
    expect(terminal._tag).toBe("InvalidReceiptTransition");
  }),
);

it.effect("authorizes a refund by explicit department scope", () =>
  Effect.gen(function* () {
    const submitted = yield* decideReceipt(undefined, submit, context);
    const wrongDepartment: ReceiptActor = {
      ...approver,
      departmentId: "department-2",
      approvalScope: { _tag: "Department", departmentId: "department-2" },
    };
    const denied = yield* Effect.flip(
      decideReceipt(
        submitted.receipt,
        {
          _tag: "RefundReceipt",
          commandId: "command-denied",
          actor: wrongDepartment,
          receiptId: "receipt-1",
          expectedRevision: 0,
        },
        context,
      ),
    );
    expect(denied._tag).toBe("ReceiptScopeDenied");

    const refunded = yield* decideReceipt(
      submitted.receipt,
      {
        _tag: "RefundReceipt",
        commandId: "command-refund",
        actor: approver,
        receiptId: "receipt-1",
        expectedRevision: 0,
      },
      context,
    );
    expect(refunded.receipt.status).toBe("Refunded");
    expect(refunded.receipt.refundDate).toBe(context.now);
  }),
);

it.effect("strict decoding rejects non-positive and excess input", () =>
  Effect.gen(function* () {
    const invalidAmount = yield* Effect.flip(
      decideReceipt(undefined, { ...submit, amountOre: 0 }, context),
    );
    expect(invalidAmount._tag).toBe("ReceiptDecodeError");

    const excess = yield* Effect.flip(
      decideReceipt(undefined, { ...submit, plaintextAccount: "1234" }, context),
    );
    expect(excess._tag).toBe("ReceiptDecodeError");
  }),
);

const provenance: ReceiptImportProvenance = {
  sourceRepository: "legacy",
  sourceRevision: "d05c261",
  snapshotId: "snapshot-1",
  sourceWatermark: "binlog:100",
  transformationRevision: "receipt-import-v1",
  sourceDigest: "b".repeat(64),
  destinationIdentity: "receipt-imported-1",
};

const legacyRow: LegacyReceiptRow = {
  sourcePrimaryKey: "42",
  ownerPersonId: "person-1",
  departmentId: "department-1",
  visualId: "LEGACY-42",
  amountDecimal: "123.45",
  description: "Legacy travel",
  receiptDate: "2026-08-19",
  submittedAt: "2026-08-20T10:00:00.000Z",
  status: "pending",
  refundDate: null,
  paymentAccountCiphertext: "ciphertext:v1:legacy",
  file,
};

it("imports exact øre and quarantines ambiguous legacy facts", () => {
  const accepted = importLegacyReceipt(legacyRow, "receipt-imported-1", provenance);
  expect(accepted._tag).toBe("AcceptedReceiptImport");
  if (accepted._tag === "AcceptedReceiptImport") {
    expect(accepted.receipt.amountOre).toBe(12_345);
    expect(accepted.provenance.sourceWatermark).toBe("binlog:100");
  }

  const quarantined = importLegacyReceipt(
    { ...legacyRow, amountDecimal: "123.456", file: null },
    "receipt-imported-2",
    { ...provenance, destinationIdentity: "receipt-imported-2" },
  );
  expect(quarantined).toMatchObject({
    _tag: "QuarantinedReceiptImport",
    reasons: ["InvalidAmount", "MissingFile"],
    reconciliation: "NotApplicable",
  });
  const unsupportedFile = importLegacyReceipt(
    {
      ...legacyRow,
      file: { ...file, contentType: "image/gif", byteLength: 0, sha256: "invalid" },
    },
    "receipt-imported-unsupported",
    { ...provenance, destinationIdentity: "receipt-imported-unsupported" },
  );
  expect(unsupportedFile).toMatchObject({
    _tag: "QuarantinedReceiptImport",
    reasons: ["UnsupportedFile"],
  });
});

it.effect("binds file lifecycle effects to the exact old and new objects", () =>
  Effect.gen(function* () {
    const submitted = yield* decideReceipt(undefined, submit, context);
    const replacement: ReceiptFile = {
      ...file,
      objectKey: "tmp/replacement",
      sha256: "d".repeat(64),
    };
    const revised = yield* decideReceipt(
      submitted.receipt,
      {
        _tag: "RevisePendingReceipt",
        commandId: "command-replace",
        actor: owner,
        receiptId: "receipt-1",
        expectedRevision: 0,
        description: "Travel",
        amountOre: 12_345,
        receiptDate: "2026-08-19",
        file: replacement,
      },
      context,
    );
    expect(revised.outbox).toEqual([
      expect.objectContaining({
        _tag: "PromoteReceiptFile",
        file: expect.objectContaining({
          objectKey: "tmp/replacement",
          sha256: "d".repeat(64),
        }),
      }),
      expect.objectContaining({ _tag: "WriteReceiptAudit" }),
      expect.objectContaining({
        _tag: "DeleteReceiptFile",
        file: expect.objectContaining({
          objectKey: "tmp/file-1",
          sha256: "a".repeat(64),
        }),
      }),
    ]);
  }),
);

it.effect("rejects impossible calendar dates and offset-free timestamps", () =>
  Effect.gen(function* () {
    const invalidDate = yield* Effect.flip(
      decideReceipt(undefined, { ...submit, receiptDate: "2026-02-31" }, context),
    );
    expect(invalidDate._tag).toBe("ReceiptDecodeError");
    const imported = importLegacyReceipt(
      { ...legacyRow, submittedAt: "2026-08-20 10:00:00" },
      "receipt-imported-3",
      { ...provenance, destinationIdentity: "receipt-imported-3" },
    );
    expect(imported).toMatchObject({
      _tag: "QuarantinedReceiptImport",
      reasons: ["InvalidSubmittedAt"],
    });
  }),
);

it("quarantines duplicate visual and source identities across an import snapshot", () => {
  const results = importLegacyReceipts([
    { row: legacyRow, receiptId: "import-1", provenance },
    {
      row: { ...legacyRow, sourcePrimaryKey: "43" },
      receiptId: "import-2",
      provenance: { ...provenance, destinationIdentity: "import-2" },
    },
    {
      row: { ...legacyRow, visualId: "LEGACY-44" },
      receiptId: "import-3",
      provenance: { ...provenance, destinationIdentity: "import-3" },
    },
  ]);
  expect(results[1]).toMatchObject({
    _tag: "QuarantinedReceiptImport",
    reasons: ["DuplicateVisualId"],
  });
  expect(results[2]).toMatchObject({
    _tag: "QuarantinedReceiptImport",
    reasons: ["SourceIdentityCollision"],
  });
});
