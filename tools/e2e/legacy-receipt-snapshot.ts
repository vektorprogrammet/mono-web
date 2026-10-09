import { canonicalJsonValue } from "@vektorprogrammet/domain/shared-kernel";
import {
  decodeReviewedReceiptSnapshot,
  ReceiptReview,
  receiptEvidenceDigest,
  type ReceiptSourceRow,
} from "@vektorprogrammet/domain/receipt";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import type { PaymentAccountCipher } from "@vektorprogrammet/backend/receipt/payment-account";
import { reviewedReceiptTransformationRevision } from "@vektorprogrammet/backend/receipt/reviewed-import";
import { buildLegacyReferences } from "./legacy-cutover-references";
import type { LegacySourceSnapshot } from "./legacy-source-snapshot";

/** The Person/reference revision never contains credentials or financial source rows. */
export const legacyReceiptBaseSourceRevision = (source: LegacySourceSnapshot): string => {
  const {
    credentials: _credentials,
    receipts: _receipts,
    paymentAccounts: _paymentAccounts,
    ...baseSource
  } = source;

  return receiptEvidenceDigest(canonicalJsonValue(baseSource));
};

/** Private in-memory input to custody only; never serialize this map. */
export const legacyReceiptAccounts = (
  source: LegacySourceSnapshot,
): ReadonlyMap<string, string | null> => {
  if (source.receipts === undefined || source.paymentAccounts === undefined)
    throw new Error("Explicit receipt source selection is required");

  const accounts = new Map<string, string | null>();

  for (const row of source.paymentAccounts) {
    const sourceUserId = `legacy-user:${String(row.id)}`;

    if (accounts.has(sourceUserId)) throw new Error("Receipt account source is ambiguous");
    accounts.set(sourceUserId, row.accountNumber);
  }

  return accounts;
};

/** Keep raw dates, decimal text, nulls and unsupported statuses for occurrence disposition. */
export const legacyReceiptRows = Effect.fn("legacyReceiptRows")(function* (
  source: LegacySourceSnapshot,
  cipher: PaymentAccountCipher,
) {
  const accounts = legacyReceiptAccounts(source);

  return yield* Effect.forEach(source.receipts!, (row) =>
    Effect.gen(function* () {
      const sourceUserId = row.userId === null ? null : `legacy-user:${String(row.userId)}`;
      const account = sourceUserId === null ? null : (accounts.get(sourceUserId) ?? null);

      return {
        sourcePrimaryKey: String(row.id),
        sourceUserId,
        visualId: row.visualId,
        amountDecimal: row.amountDecimal,
        description: row.description,
        receiptDate: row.receiptDate,
        submittedAt: row.submittedAt,
        status: row.status,
        refundDate: row.refundDate,
        picturePath: row.picturePath,
        accountCommitment: account === null ? null : yield* cipher.commitment(account),
      } satisfies ReceiptSourceRow;
    }),
  );
});

export class LegacyReceiptSnapshotMismatch extends Data.TaggedError(
  "LegacyReceiptSnapshotMismatch",
)<{}> {
  override get message(): string {
    return "Receipt review does not match the selected source";
  }
}

/** Accepted Person and reference provenance is checked again by the transactional import boundary. */
export const buildLegacyReceiptSnapshot = Effect.fn("buildLegacyReceiptSnapshot")(function* (
  source: LegacySourceSnapshot,
  reviewInput: ReceiptReview,
  cipher: PaymentAccountCipher,
) {
  const review = yield* Schema.decodeEffect(ReceiptReview)(reviewInput, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new LegacyReceiptSnapshotMismatch()));

  if (
    review.sourceRepository !== "vektorprogrammet/vektorprogrammet" ||
    review.sourceRevision !== legacyReceiptBaseSourceRevision(source) ||
    review.referenceDigest !== buildLegacyReferences(source).referenceDigest
  )
    return yield* new LegacyReceiptSnapshotMismatch();

  const rows = yield* legacyReceiptRows(source, cipher).pipe(
    Effect.mapError(() => new LegacyReceiptSnapshotMismatch()),
  );

  return yield* Effect.fromResult(decodeReviewedReceiptSnapshot({ review, rows })).pipe(
    Effect.mapError(() => new LegacyReceiptSnapshotMismatch()),
  );
});

/** Bind every executable transformation, including the reader and operator boundary. */
export const legacyReceiptTransformationRevision = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reviewed = yield* reviewedReceiptTransformationRevision;

  const sources = yield* Effect.forEach(
    [
      import.meta.url,
      new URL("./legacy-source-snapshot.ts", import.meta.url),
      new URL("./legacy-cutover-references.ts", import.meta.url),
      new URL("./legacy-database-transport.ts", import.meta.url),
      new URL("./run-legacy-receipt-import.ts", import.meta.url),
      import.meta.resolve("@vektorprogrammet/database/cohort-cli"),
    ],
    (url) => path.fromFileUrl(new URL(url)).pipe(Effect.flatMap((file) => fs.readFileString(file))),
  );

  return receiptEvidenceDigest([reviewed, ...sources]);
});
