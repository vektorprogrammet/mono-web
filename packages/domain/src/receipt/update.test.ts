import { ReceiptOutboxRequestSchema } from "./effects.js";
import { Scope } from "../authz/access.js";
import { expect, it } from "@effect/vitest";
import { Predicate, Effect } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import {
  importLegacyReceipt,
  importLegacyReceipts,
  type ReceiptImportProvenance,
} from "./import.js";
import {
  ReceiptId,
  ReceiptCommandRequestSchema,
  type LegacyReceiptRow,
  type ReceiptActor,
  type ReceiptFile,
  ApprovalScopeSchema,
} from "./schema.js";
import { AuthorizedReceiptCommandSchema, decideReceipt } from "./update.js";

const file: ReceiptFile = {
  fileRef: "file-1",
  objectKey: "tmp/file-1",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const owner: ReceiptActor = {
  personId: PersonId.make("person-1"),
  departmentId: DepartmentId.make("department-1"),
  active: true,
  approvalScope: ApprovalScopeSchema.cases.None.make({}),
};

const approver: ReceiptActor = {
  personId: PersonId.make("approver-1"),
  departmentId: DepartmentId.make("department-1"),
  active: true,
  approvalScope: Scope.Department({ departmentId: DepartmentId.make("department-1") }),
};

const context = {
  receiptId: ReceiptId.make("receipt-1"),
  visualId: "REC-0001",
  now: "2026-08-20T12:00:00.000Z",
} as const;

const submit = AuthorizedReceiptCommandSchema.cases.SubmitReceipt.make({
  commandId: "command-submit",
  actor: owner,
  departmentId: DepartmentId.make("department-1"),
  paymentAccountCiphertext: "ciphertext:v1:account",
  description: "Travel",
  amountOre: 12_345,
  receiptDate: "2026-08-19",
  file,
});

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
      AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
        commandId: "command-revise",
        actor: owner,
        receiptId: ReceiptId.make("receipt-1"),
        expectedRevision: 0,
        description: "Travel and tolls",
        amountOre: 13_000,
        receiptDate: "2026-08-19",
        file,
      }),
      { ...context, now: "2026-08-20T12:01:00.000Z" },
    );

    expect(revised.receipt.revision).toBe(1);
    expect(revised.receipt.submittedAt).toBe(context.now);

    const withdrawn = yield* decideReceipt(
      revised.receipt,
      AuthorizedReceiptCommandSchema.cases.WithdrawPendingReceipt.make({
        commandId: "command-withdraw",
        actor: owner,
        receiptId: ReceiptId.make("receipt-1"),
        expectedRevision: 1,
      }),
      { ...context, now: "2026-08-20T12:02:00.000Z" },
    );

    expect(withdrawn.receipt.status).toBe("Withdrawn");

    const terminal = yield* Effect.flip(
      decideReceipt(
        withdrawn.receipt,
        AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
          commandId: "command-approve-terminal",
          actor: approver,
          receiptId: ReceiptId.make("receipt-1"),
          expectedRevision: 2,
        }),
        { ...context, now: "2026-08-20T12:03:00.000Z" },
      ),
    );

    expect(terminal._tag).toBe("InvalidReceiptTransition");
  }),
);

it.effect("resolves KeepCurrentFile from the locked current receipt", () =>
  Effect.gen(function* () {
    const submitted = yield* decideReceipt(undefined, submit, context);

    const revised = yield* decideReceipt(
      submitted.receipt,
      AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
        commandId: "command-keep-current-file",
        actor: owner,
        receiptId: ReceiptId.make("receipt-1"),
        expectedRevision: 0,
        description: "Travel without replacement",
        amountOre: 12_500,
        receiptDate: "2026-08-20",
        file: ReceiptCommandRequestSchema.cases.RevisePendingReceipt.fields.file.members[1].cases.KeepCurrentFile.make(
          {},
        ),
      }),
      { ...context, now: "2026-08-20T12:01:00.000Z" },
    );

    expect(revised.receipt.file).toEqual(file);
    expect(revised.outbox.map((item) => item._tag)).toEqual(["WriteReceiptAudit"]);
  }),
);

it.effect("authorizes approval by explicit department scope", () =>
  Effect.gen(function* () {
    const submitted = yield* decideReceipt(undefined, submit, context);

    const wrongDepartment: ReceiptActor = {
      ...approver,
      departmentId: DepartmentId.make("department-2"),
      approvalScope: Scope.Department({ departmentId: DepartmentId.make("department-2") }),
    };

    const denied = yield* Effect.flip(
      decideReceipt(
        submitted.receipt,
        AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
          commandId: "command-denied",
          actor: wrongDepartment,
          receiptId: ReceiptId.make("receipt-1"),
          expectedRevision: 0,
        }),
        context,
      ),
    );

    expect(denied._tag).toBe("ReceiptScopeDenied");

    const approved = yield* decideReceipt(
      submitted.receipt,
      AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
        commandId: "command-approve",
        actor: approver,
        receiptId: ReceiptId.make("receipt-1"),
        expectedRevision: 0,
      }),
      context,
    );

    expect(approved.receipt.status).toBe("Approved");
    expect(approved.receipt.approvedAt).toBe(context.now);
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
  ownerPersonId: PersonId.make("person-1"),
  departmentId: DepartmentId.make("department-1"),
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

  if (Predicate.isTagged(accepted, "AcceptedReceiptImport")) {
    expect(accepted.receipt.amountOre).toBe(12_345);
    expect(accepted.provenance.sourceWatermark).toBe("binlog:100");
  }

  const quarantined = importLegacyReceipt(
    { ...legacyRow, amountDecimal: "123.456", file: null },
    "receipt-imported-2",
    { ...provenance, destinationIdentity: "receipt-imported-2" },
  );

  {
    const observedTaggedValue = quarantined;
    expect(observedTaggedValue).toHaveProperty(["_tag"], "QuarantinedReceiptImport");
    expect(observedTaggedValue).toMatchObject({
      reasons: ["InvalidAmount", "MissingFile"],
      reconciliation: "NotApplicable",
    });
  }

  const unsupportedFile = importLegacyReceipt(
    {
      ...legacyRow,
      file: { ...file, contentType: "image/gif", byteLength: 0, sha256: "invalid" },
    },
    "receipt-imported-unsupported",
    { ...provenance, destinationIdentity: "receipt-imported-unsupported" },
  );

  {
    const observedTaggedValue = unsupportedFile;
    expect(observedTaggedValue).toHaveProperty(["_tag"], "QuarantinedReceiptImport");
    expect(observedTaggedValue).toMatchObject({
      reasons: ["UnsupportedFile"],
    });
  }
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
      AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
        commandId: "command-replace",
        actor: owner,
        receiptId: ReceiptId.make("receipt-1"),
        expectedRevision: 0,
        description: "Travel",
        amountOre: 12_345,
        receiptDate: "2026-08-19",
        file: replacement,
      }),
      context,
    );

    expect(revised.outbox.map((item) => item._tag)).toEqual([
      "PromoteReceiptFile",
      "WriteReceiptAudit",
      "DeleteReceiptFile",
    ]);
    expect(revised.outbox.find(ReceiptOutboxRequestSchema.guards.PromoteReceiptFile)?.file).toEqual(
      replacement,
    );
    expect(revised.outbox.find(ReceiptOutboxRequestSchema.guards.DeleteReceiptFile)?.file).toEqual(
      file,
    );
  }),
);

it.effect("rejects impossible calendar dates and offset-free timestamps", () =>
  Effect.gen(function* () {
    const invalidDate = yield* Effect.flip(
      decideReceipt(undefined, { ...submit, receiptDate: "2026-02-31" }, context),
    );

    expect(invalidDate._tag).toBe("ReceiptDecodeError");

    const invalidContext = yield* Effect.flip(
      decideReceipt(undefined, submit, {
        ...context,
        now: "2026-02-31T12:00:00.000Z",
      }),
    );

    expect(invalidContext._tag).toBe("ReceiptDecodeError");

    const imported = importLegacyReceipt(
      { ...legacyRow, submittedAt: "2026-08-20 10:00:00" },
      "receipt-imported-3",
      { ...provenance, destinationIdentity: "receipt-imported-3" },
    );

    {
      const observedTaggedValue = imported;
      expect(observedTaggedValue).toHaveProperty(["_tag"], "QuarantinedReceiptImport");
      expect(observedTaggedValue).toMatchObject({
        reasons: ["InvalidSubmittedAt"],
      });
    }
  }),
);

it("quarantines duplicate visual and source identities across an import snapshot", () => {
  const results = importLegacyReceipts([
    { row: legacyRow, receiptId: ReceiptId.make("import-1"), provenance },
    {
      row: { ...legacyRow, sourcePrimaryKey: "43" },
      receiptId: ReceiptId.make("import-2"),
      provenance: { ...provenance, destinationIdentity: "import-2" },
    },
    {
      row: { ...legacyRow, visualId: "LEGACY-44" },
      receiptId: ReceiptId.make("import-3"),
      provenance: { ...provenance, destinationIdentity: "import-3" },
    },
  ]);

  {
    const observedTaggedValue = results[1];
    expect(observedTaggedValue).toHaveProperty(["_tag"], "QuarantinedReceiptImport");
    expect(observedTaggedValue).toMatchObject({
      reasons: ["DuplicateVisualId"],
    });
  }

  {
    const observedTaggedValue = results[2];
    expect(observedTaggedValue).toHaveProperty(["_tag"], "QuarantinedReceiptImport");
    expect(observedTaggedValue).toMatchObject({
      reasons: ["SourceIdentityCollision"],
    });
  }
});

it.effect(
  "reopens only a rejected claim under current approval authority, preserving content without effects",
  () =>
    Effect.gen(function* () {
      const submitted = yield* decideReceipt(undefined, submit, context);

      const rejected = yield* decideReceipt(
        submitted.receipt,
        AuthorizedReceiptCommandSchema.cases.RejectReceipt.make({
          commandId: "reject-for-correction",
          actor: approver,
          receiptId: context.receiptId,
          expectedRevision: 0,
        }),
        context,
      );

      const reopen = AuthorizedReceiptCommandSchema.cases.ReopenRejectedReceipt.make({
        commandId: "reopen-for-correction",
        actor: approver,
        receiptId: context.receiptId,
        expectedRevision: 1,
      });

      const reopened = yield* decideReceipt(rejected.receipt, reopen, context);
      expect(reopened.receipt).toEqual({ ...rejected.receipt, status: "Pending", revision: 2 });
      expect(reopened.outbox).toEqual([]);
      expect(reopened.auditAction).toBe("RejectedReceiptReopened");

      for (const actor of [
        owner,
        { ...approver, active: false },
        {
          ...approver,
          approvalScope: Scope.Department({ departmentId: DepartmentId.make("elsewhere") }),
        },
      ]) {
        const denied = yield* Effect.exit(
          decideReceipt(rejected.receipt, { ...reopen, actor }, context),
        );

        expect(denied._tag).toBe("Failure");
      }

      for (const status of ["Pending", "Approved", "Withdrawn"] as const) {
        const denied = yield* Effect.flip(
          decideReceipt({ ...rejected.receipt, status }, reopen, context),
        );

        expect(denied._tag).toBe("InvalidReceiptTransition");
      }

      const stale = yield* Effect.flip(
        decideReceipt(rejected.receipt, { ...reopen, expectedRevision: 0 }, context),
      );

      expect(stale._tag).toBe("StaleReceiptRevision");

      const excess = yield* Effect.flip(
        decideReceipt(rejected.receipt, { ...reopen, status: "Pending" }, context),
      );

      expect(excess._tag).toBe("ReceiptDecodeError");

      const revise = AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
        expectedRevision: 1,
        commandId: "correction",
        actor: owner,
        receiptId: context.receiptId,
        description: "Corrected travel",
        amountOre: 12000,
        receiptDate: "2026-08-19",
        file: ReceiptCommandRequestSchema.cases.RevisePendingReceipt.fields.file.members[1].cases.KeepCurrentFile.make(
          {},
        ),
      });

      expect(
        (yield* Effect.flip(
          decideReceipt(rejected.receipt, { ...revise, expectedRevision: 1 }, context),
        ))._tag,
      ).toBe("InvalidReceiptTransition");

      const corrected = yield* decideReceipt(
        reopened.receipt,
        { ...revise, expectedRevision: 2 },
        context,
      );

      expect(corrected.receipt.receiptId).toBe(context.receiptId);

      const resolved = yield* decideReceipt(
        corrected.receipt,
        AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
          commandId: "corrected-approve",
          actor: approver,
          receiptId: context.receiptId,
          expectedRevision: 3,
        }),
        context,
      );

      expect(resolved.receipt.status).toBe("Approved");
      expect(resolved.receipt.revision).toBe(4);
    }),
);
