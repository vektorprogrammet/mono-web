import { describe, expect, it } from "@effect/vitest";
import { ReceiptId } from "./schema.js";
import { Effect, Encoding } from "effect";
import { decodeReceiptCursor, encodeReceiptCursor, receiptPage } from "./pagination.js";

describe("receipt continuation", () => {
  it.effect(
    "preserves the microsecond sort position and derives continuation from the last returned row",
    () =>
      Effect.gen(function* () {
        const rows = Array.from({ length: 51 }, (_, index) => ({
          receiptId: ReceiptId.make(
            index === 49
              ? `receipt-${"x".repeat(2048)}`
              : `receipt-${String(index).padStart(3, "0")}`,
          ),
          timestamp: "2038-06-13T12:00:00.123456Z",
        }));

        const page = receiptPage(rows, (row) => row);
        expect(page.items.map((row) => row.receiptId)).toEqual(
          rows.slice(0, 50).map((row) => row.receiptId),
        );
        expect(yield* decodeReceiptCursor(page.nextCursor!)).toEqual(rows[49]);
      }),
  );

  it.effect("rejects malformed and calendar-normalized cursor input", () =>
    Effect.gen(function* () {
      const invalid = [
        "not base64!",
        Encoding.encodeBase64(
          JSON.stringify(["receipt-v2", "2038-06-13T12:00:00.123456Z", "receipt-1"]),
        ),
        Encoding.encodeBase64(
          JSON.stringify(["receipt-v1", "2038-02-31T12:00:00.123456Z", "receipt-1"]),
        ),
        Encoding.encodeBase64(JSON.stringify(["receipt-v1", "2038-06-13T12:00:00.123456Z", ""])),
      ];

      for (const cursor of invalid)
        expect((yield* Effect.flip(decodeReceiptCursor(cursor)))._tag).toBe("ReceiptDecodeError");

      const valid = {
        timestamp: "2038-06-13T12:00:00.000001Z",
        receiptId: ReceiptId.make(`receipt-æ-${"x".repeat(2048)}`),
      };

      expect(yield* decodeReceiptCursor(encodeReceiptCursor(valid))).toEqual(valid);
    }),
  );
});
