import { DepartmentId, PersonId } from "../organization/schema.js";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ReceiptId, Receipt } from "./schema.js";

it.effect("decodes a selected Receipt and rejects an excess persisted field", () => {
  const selected = {
    receiptId: ReceiptId.make("receipt-model-1"),
    visualId: "REC-MODEL-1",
    ownerPersonId: PersonId.make("person-1"),
    departmentId: DepartmentId.make("department-1"),
    amountOre: "12345",
    currency: "NOK",
    description: "Travel",
    receiptDate: "2026-08-20",
    submittedAt: "2026-08-20T10:00:00.000Z",
    status: "Pending",
    approvedAt: null,
    paymentAccountCiphertext: "ciphertext:v1:account",
    file: {
      fileRef: "staging/receipt-model-1",
      objectKey: "receipts/receipt-model-1",
      contentType: "application/pdf",
      byteLength: "128",
      sha256: "a".repeat(64),
    },
    revision: 0,
  } as const;

  return Effect.gen(function* () {
    const receipt = yield* Schema.decodeUnknownEffect(Receipt)(selected, {
      onExcessProperty: "error",
    });

    expect(receipt.receiptId).toBe("receipt-model-1");
    expect(receipt.file.byteLength).toBe(128);

    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(Receipt)(
        { ...selected, duplicateAuthority: true },
        {
          onExcessProperty: "error",
        },
      ),
    );

    expect(String(failure)).toContain("duplicateAuthority");

    const oversizedFile = yield* Effect.flip(
      Schema.decodeUnknownEffect(Receipt)(
        {
          ...selected,
          file: {
            ...selected.file,
            byteLength: Number.MAX_SAFE_INTEGER + 1,
          },
        },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(oversizedFile)).toContain("byteLength");

    const fractionalAmount = yield* Effect.flip(
      Schema.decodeUnknownEffect(Receipt)(
        { ...selected, amountOre: "12.5" },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(fractionalAmount)).toContain("amountOre");
  });
});
