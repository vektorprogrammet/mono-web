import { readFile } from "node:fs/promises";
import { Effect, Predicate } from "effect";
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

export const reviewedReceiptTransformationRevision = async (): Promise<string> =>
  receiptEvidenceDigest([
    await receiptImportSourceDigest(),
    ...(await Promise.all(
      [
        "./reviewed-import.ts",
        "./payment-account.ts",
        "./import-snapshot.ts",
        "./filesystem.ts",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    )),
  ]);

const validSourceDateTime = (value: string | null): boolean =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value) &&
  isIsoDate(value.slice(0, 10)) &&
  // The suffix checks calendar and clock syntax; it does not convert source time.
  isIsoInstant(`${value.replace(" ", "T")}Z`);

const readFailure = (cause: Error): ReceiptQuarantineReason => {
  if (cause.message === "UnsafeFilePath") return "UnsafeFilePath";

  if (cause.message === "UnsupportedFile") return "UnsupportedFile";

  if (cause.message === "FileDigestMismatch") return "FileDigestMismatch";

  return "UnreadableFile";
};

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

    const staged = new Map<string, ReceiptFile>();

    const stage = async (
      entry: Extract<(typeof snapshot.review.entries)[number], { readonly _tag: "Import" }>,
      receiptId: string,
    ) => {
      const bytes = await readSnapshotFile(archiveRoot, entry.file);

      const result = await files.stageBytes(
        new File([bytes], "receipt", { type: entry.file.contentType }),
        receiptId,
        entry.file.contentType,
        maxFileBytes,
      );

      if (result.created) staged.set(result.file.fileRef, result.file);

      return result.file;
    };

    const prepare = (rows: readonly ResolvedReviewedReceipt[]) =>
      Effect.tryPromise({
        try: async () => {
          const inputs: LegacyReceiptImportInput[] = [];
          const failures = new Map<string, ReceiptQuarantineReason[]>();

          for (const resolved of rows) {
            const { row, entry, receiptId, provenance } = resolved;
            const reasons: ReceiptQuarantineReason[] = [];
            let ciphertext: string | null = null;
            const account =
              row.sourceUserId === null ? null : (accounts.get(row.sourceUserId) ?? null);

            if (account !== null) {
              try {
                ciphertext = cipher.encrypt(account, receiptId);
              } catch (cause) {
                if (
                  !(cause instanceof PaymentAccountCustodyError) ||
                  cause.code !== "InvalidAccount"
                )
                  throw new ReceiptCohortFailure({ code: "AccountEncryptionFailed" });
              }
            }

            if (!validSourceDateTime(row.receiptDate)) reasons.push("InvalidReceiptDate");

            if (!validSourceDateTime(row.submittedAt)) reasons.push("InvalidSubmittedAt");

            let file: ReceiptFile | null = null;
            let bytes: Uint8Array | undefined;

            try {
              bytes = await readSnapshotFile(archiveRoot, entry.file);
            } catch (cause) {
              reasons.push(cause instanceof Error ? readFailure(cause) : "UnreadableFile");
            }

            if (bytes !== undefined) {
              const result = await files.stageBytes(
                new File([bytes], "receipt", { type: entry.file.contentType }),
                receiptId,
                entry.file.contentType,
                maxFileBytes,
              );

              file = result.file;

              if (result.created) staged.set(file.fileRef, file);
            }

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
        },
        catch: (cause) =>
          cause instanceof ReceiptCohortFailure
            ? cause
            : new ReceiptCohortFailure({ code: "ReceiptPreparationFailed" }),
      });

    const imported = yield* Effect.result(importReviewedReceiptCohort(snapshot, prepare));

    const retained = new Set(
      Predicate.isTagged(imported, "Success")
        ? imported.success.acceptedResults.map((result) => result.receipt.file.fileRef)
        : [],
    );

    const cleanup = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          for (const file of staged.values()) {
            if (!retained.has(file.fileRef)) await files.cleanupStage(file);
          }
        },
        catch: () => new ReceiptCohortFailure({ code: "StagingCleanupFailed" }),
      }),
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

      const custody = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            cipher.decrypt(original.paymentAccountCiphertext, original.receiptId);

            try {
              await files.readCommitted(original.file, maxFileBytes);

              return;
            } catch {
              const stagedFile =
                staged.get(original.file.fileRef) ?? (await stage(entry, original.receiptId));

              if (!sameReceiptFile(stagedFile, original.file))
                throw new ReceiptCohortFailure({ code: "FileIdentityConflict" });
            }
          },
          catch: () => new ReceiptCohortFailure({ code: "FileCustodyPending" }),
        }),
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
          : Effect.tryPromise({
              try: async () => {
                await files.readCommitted(receipt.file, maxFileBytes);

                return true;
              },
              catch: () =>
                new ReceiptPersistenceError({
                  operation: "observe reviewed receipt bytes",
                  message: "Private bytes unavailable",
                }),
            }),
      ).pipe(Effect.mapError(() => new ReceiptCohortFailure({ code: "ReceiptObservationFailed" })));

      if (observed) reconciled += 1;
    }

    const pending = report.accepted - reconciled;

    return { ...report, reconciled, pending, complete: pending === 0 };
  });
