import { expect, layer } from "@effect/vitest";
import { readOwnedReceiptFile } from "@vektorprogrammet/database/receipt/postgres";
import { Effect } from "effect";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";

/**
 * `economy_receipts.file_byte_length` is a bigint whose CHECK admits 1 through 2^53 - 1 (migration
 * 0001), and `ReceiptFileSchema` admits the same range. A read that narrows it to int4 refuses every
 * file above 2^31 - 1 bytes, so the declared range is the contract.
 */
const declaredRange = [
  { receiptId: "byte-length-above-int4", bytes: 2 ** 31 },
  { receiptId: "byte-length-largest", bytes: Number.MAX_SAFE_INTEGER },
] as const;

const insertReceipt = (receiptId: string, bytes: number) =>
  Effect.gen(function* () {
    const database = yield* Database;

    yield* database`
      INSERT INTO public.economy_receipts (
        receipt_id, visual_id, owner_person_id, department_id, amount_ore,
        currency, description, receipt_date, submitted_at, status, approved_at,
        payment_account_ciphertext, file_ref, file_object_key, file_content_type,
        file_byte_length, file_sha256, revision
      ) VALUES (
        ${receiptId}, ${receiptId.toUpperCase()}, 'byte-length-owner', 'byte-length-department', 1000,
        'NOK', 'Large file', '2038-06-10', '2038-06-10T12:00:00.000Z', 'Pending', NULL,
        'ciphertext', ${`${receiptId}-file`}, ${`${receiptId}-object`}, 'application/pdf',
        ${bytes}, ${"a".repeat(64)}, 0
      )
    `;
  });

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "owned Receipt file metadata over the declared byte range",
  (it) => {
    it.effect.each(declaredRange)("reads $bytes bytes", ({ receiptId, bytes }) =>
      Effect.gen(function* () {
        yield* insertReceipt(receiptId, bytes);

        const read = yield* readOwnedReceiptFile(receiptId, "byte-length-owner");

        expect(read?.file.byteLength).toBe(bytes);
      }),
    );
  },
);
