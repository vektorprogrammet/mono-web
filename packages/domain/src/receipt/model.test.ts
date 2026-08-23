import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Receipt } from "./schema.js";

const keys = (fields: object): ReadonlyArray<string> => Object.keys(fields).sort();

it("derives Receipt persistence and JSON variants from one model", () => {
  expect(keys(Receipt.fields)).toEqual([
    "amountOre",
    "currency",
    "departmentId",
    "description",
    "file",
    "ownerPersonId",
    "paymentAccountCiphertext",
    "receiptDate",
    "receiptId",
    "refundDate",
    "revision",
    "status",
    "submittedAt",
    "visualId",
  ]);
  expect(keys(Receipt.insert.fields)).toEqual([
    "amountOre",
    "currency",
    "departmentId",
    "description",
    "file",
    "ownerPersonId",
    "paymentAccountCiphertext",
    "receiptDate",
    "receiptId",
    "refundDate",
    "revision",
    "status",
    "submittedAt",
    "visualId",
  ]);
  expect(keys(Receipt.update.fields)).toEqual([
    "amountOre",
    "description",
    "file",
    "receiptDate",
    "refundDate",
    "revision",
    "status",
  ]);
  expect(keys(Receipt.json.fields)).toEqual([
    "amountOre",
    "currency",
    "departmentId",
    "description",
    "ownerPersonId",
    "receiptDate",
    "receiptId",
    "refundDate",
    "revision",
    "status",
    "submittedAt",
    "visualId",
  ]);
  expect(keys(Receipt.jsonCreate.fields)).toEqual(["amountOre", "description", "receiptDate"]);
  expect(keys(Receipt.jsonUpdate.fields)).toEqual(["amountOre", "description", "receiptDate"]);
});

it.effect("decodes a selected Receipt and rejects an excess persisted field", () => {
  const selected = {
    receiptId: "receipt-model-1",
    visualId: "REC-MODEL-1",
    ownerPersonId: "person-1",
    departmentId: "department-1",
    amountOre: "12345",
    currency: "NOK",
    description: "Travel",
    receiptDate: "2026-08-20",
    submittedAt: "2026-08-20T10:00:00.000Z",
    status: "Pending",
    refundDate: null,
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
