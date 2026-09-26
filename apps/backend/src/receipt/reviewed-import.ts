import { Effect, FileSystem, Path, Predicate } from "effect";
import {
  decodeReviewedReceiptSnapshot,
  importLegacyReceipts,
  isIsoDate,
  isIsoInstant,
  receiptEvidenceDigest,
  receiptOutboxRequest,
  ReceiptCohortFailure,
  ReceiptImportResult,
  ReceiptPersistenceError,
  sameReceiptFile,
  type LegacyReceiptImportInput,
  type ReceiptFile,
  type ReceiptQuarantineReason,
  type ReviewedReceiptSnapshot,
} from "@vektorprogrammet/domain/receipt";
import {
  importReviewedReceiptCohort,
  receiptImportSourceDigest,
  reconcileReceiptImport,
  type ResolvedReviewedReceipt,
} from "@vektorprogrammet/database/receipt/postgres";
import { readSnapshotFile } from "./import-snapshot.js";
import { PaymentAccountCustodyError, type PaymentAccountCipher } from "./payment-account.js";
import type { ReceiptFileStore } from "./filesystem.js";

const maxFileBytes = 10 * 1024 * 1024;

/** Binds the reviewed import to the source text of every module that transforms it. */
export const reviewedReceiptTransformationRevision = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDigest = yield* Effect.promise(() => receiptImportSourceDigest());

  const sources = yield* Effect.forEach(
    ["./reviewed-import.ts", "./payment-account.ts", "./import-snapshot.ts", "./filesystem.ts"],
    (source) =>
      path
        .fromFileUrl(new URL(source, import.meta.url))
        .pipe(Effect.flatMap((file) => fs.readFileString(file))),
  );

  return receiptEvidenceDigest([sourceDigest, ...sources]);
});

const validSourceDateTime = (value: string | null): boolean =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value) &&
  isIsoDate(value.slice(0, 10)) &&
  // The suffix checks calendar and clock syntax; it does not convert source time.
  isIsoInstant(`${value.replace(" ", "T")}Z`);

/** An invalid source account imports without a destination; any other cipher failure stops the cohort. */
const encryptAccount = (cipher: PaymentAccountCipher, account: string, receiptId: string) =>
  Effect.try({
    try: () => cipher.encrypt(account, receiptId),
    catch: (cause) =>
      cause instanceof PaymentAccountCustodyError
        ? cause
        : new ReceiptCohortFailure({ code: "AccountEncryptionFailed" }),
  }).pipe(
    Effect.catchTag("PaymentAccountCustodyError", (error) =>
      error.code === "InvalidAccount"
        ? Effect.succeed(null)
        : Effect.fail(new ReceiptCohortFailure({ code: "AccountEncryptionFailed" })),
    ),
  );

export const runReviewedReceiptImport = (
  input: ReviewedReceiptSnapshot,
  accounts: ReadonlyMap<string, string | null>,
  archiveRoot: string,
  files: ReceiptFileStore,
  cipher: PaymentAccountCipher,
) =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.try({
      try: () => decodeReviewedReceiptSnapshot(input),
      catch: () => new ReceiptCohortFailure({ code: "InvalidReview" }),
    });

    for (const row of snapshot.rows) {
      const account = row.sourceUserId === null ? null : (accounts.get(row.sourceUserId) ?? null);
      const commitment = account === null ? null : cipher.commitment(account);

      if (commitment !== row.accountCommitment)
        return yield* new ReceiptCohortFailure({ code: "AccountEvidenceConflict" });
    }

    // The cohort transaction runs `prepare` without requirements; it reads the archive through
    // the platform services of this program.
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const staged = new Map<string, ReceiptFile>();

    const stage = (
      entry: Extract<(typeof snapshot.review.entries)[number], { readonly _tag: "Import" }>,
      receiptId: string,
    ) =>
      readSnapshotFile(archiveRoot, entry.file).pipe(
        Effect.flatMap((bytes) =>
          files.stageBytes(
            new File([bytes], "receipt", { type: entry.file.contentType }),
            receiptId,
            entry.file.contentType,
            maxFileBytes,
          ),
        ),
        Effect.map((result) => {
          if (result.created) staged.set(result.file.fileRef, result.file);

          return result.file;
        }),
      );

    const prepare = (rows: readonly ResolvedReviewedReceipt[]) =>
      Effect.gen(function* () {
        const inputs: LegacyReceiptImportInput[] = [];
        const failures = new Map<string, ReceiptQuarantineReason[]>();

        for (const resolved of rows) {
          const { row, entry, receiptId, provenance } = resolved;
          const reasons: ReceiptQuarantineReason[] = [];

          const account =
            row.sourceUserId === null ? null : (accounts.get(row.sourceUserId) ?? null);

          const ciphertext =
            account === null ? null : yield* encryptAccount(cipher, account, receiptId);

          if (!validSourceDateTime(row.receiptDate)) reasons.push("InvalidReceiptDate");

          if (!validSourceDateTime(row.submittedAt)) reasons.push("InvalidSubmittedAt");

          const file = yield* stage(entry, receiptId).pipe(
            Effect.catchTag("ReceiptSnapshotFileRejected", (rejected) => {
              reasons.push(rejected.reason);

              return Effect.succeed(null);
            }),
          );

          failures.set(row.sourcePrimaryKey, reasons);
          inputs.push({
            receiptId,
            provenance,
            row: {
              sourcePrimaryKey: row.sourcePrimaryKey,
              ownerPersonId: resolved.ownerPersonId,
              departmentId: resolved.departmentId,
              visualId: row.visualId,
              amountDecimal: row.amountDecimal,
              description: row.description,
              receiptDate: entry.receiptDate,
              submittedAt: entry.submittedAt,
              status: row.status,
              refundDate: entry.approvedAt,
              paymentAccountCiphertext: ciphertext,
              file,
            },
          });
        }

        return importLegacyReceipts(inputs).map((result) => {
          const reasons = failures.get(result.sourcePrimaryKey)!;

          if (reasons.length === 0) return result;

          return ReceiptImportResult.QuarantinedReceiptImport({
            sourcePrimaryKey: result.sourcePrimaryKey,
            sourceOccurrence: result.sourceOccurrence,
            targetSemanticIdentity: result.targetSemanticIdentity,
            provenance: result.provenance,
            reconciliation: "NotApplicable",
            reasons: [
              ...new Set([
                ...reasons,
                ...(Predicate.isTagged(result, "QuarantinedReceiptImport") ? result.reasons : []),
              ]),
            ],
          });
        });
      }).pipe(
        Effect.catchTags({
          ReceiptDecodeError: () =>
            Effect.fail(new ReceiptCohortFailure({ code: "ReceiptPreparationFailed" })),
          ReceiptFileStoreError: () =>
            Effect.fail(new ReceiptCohortFailure({ code: "ReceiptPreparationFailed" })),
        }),
        Effect.provideContext(platform),
      );

    const imported = yield* Effect.result(importReviewedReceiptCohort(snapshot, prepare));

    const retained = new Set(
      Predicate.isTagged(imported, "Success")
        ? imported.success.acceptedResults.map((result) => result.receipt.file.fileRef)
        : [],
    );

    const cleanup = yield* Effect.result(
      Effect.forEach(
        [...staged.values()].filter((file) => !retained.has(file.fileRef)),
        (file) => files.cleanupStage(file),
        { discard: true },
      ).pipe(Effect.mapError(() => new ReceiptCohortFailure({ code: "StagingCleanupFailed" }))),
    );

    if (Predicate.isTagged(imported, "Failure")) {
      if (Predicate.isTagged(cleanup, "Failure"))
        return yield* new ReceiptCohortFailure({
          code: `${imported.failure.code}:StagingCleanupFailed`,
        });

      return yield* imported.failure;
    }

    if (Predicate.isTagged(cleanup, "Failure")) return yield* cleanup.failure;

    const report = imported.success;

    const entries = new Map(
      snapshot.review.entries.map((entry) => [entry.sourcePrimaryKey, entry]),
    );

    let reconciled = 0;

    for (const result of report.acceptedResults) {
      const entry = entries.get(result.sourcePrimaryKey);

      if (entry?._tag !== "Import")
        return yield* new ReceiptCohortFailure({ code: "AcceptedReviewMissing" });
      const original = result.receipt;

      // Every custody failure, including a restaged file with another identity, leaves the
      // receipt pending.
      const custody = yield* Effect.result(
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => cipher.decrypt(original.paymentAccountCiphertext, original.receiptId),
            catch: () => new ReceiptCohortFailure({ code: "FileCustodyPending" }),
          });
          const committed = yield* Effect.result(files.readCommitted(original.file, maxFileBytes));

          if (Predicate.isTagged(committed, "Success")) return;

          const stagedFile =
            staged.get(original.file.fileRef) ?? (yield* stage(entry, original.receiptId));

          if (!sameReceiptFile(stagedFile, original.file))
            return yield* new ReceiptCohortFailure({ code: "FileCustodyPending" });
        }).pipe(Effect.mapError(() => new ReceiptCohortFailure({ code: "FileCustodyPending" }))),
      );

      if (Predicate.isTagged(custody, "Success")) {
        yield* Effect.result(
          files.service.apply(
            receiptOutboxRequest(
              `reviewed-receipt:${original.receiptId}`,
              original.receiptId,
              "PromoteReceiptFile",
              original.file,
            ),
          ),
        );
      }

      const observed = yield* reconcileReceiptImport(result, (receipt) =>
        Predicate.isTagged(custody, "Failure")
          ? Effect.succeed(false)
          : files.readCommitted(receipt.file, maxFileBytes).pipe(
              Effect.as(true),
              Effect.mapError(
                () =>
                  new ReceiptPersistenceError({
                    operation: "observe reviewed receipt bytes",
                    message: "Private bytes unavailable",
                  }),
              ),
            ),
      ).pipe(Effect.mapError(() => new ReceiptCohortFailure({ code: "ReceiptObservationFailed" })));

      if (observed) reconciled += 1;
    }

    const pending = report.accepted - reconciled;

    return { ...report, reconciled, pending, complete: pending === 0 };
  });
