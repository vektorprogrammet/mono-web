import {
  ReceiptFileSchema,
  ReceiptImportResult,
  importLegacyReceipts,
  type ReceiptQuarantineReason,
  type ReceiptFile,
} from "@vektorprogrammet/domain/receipt";
/** Spec 0095: bounded synthetic snapshot adapter, using the Receipt importer. */
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect FileSystem.open has no O_NOFOLLOW; the snapshot reader refuses a symlink at open time
import { constants, open } from "node:fs/promises";
import { Data, Effect, FileSystem, Match, Option, Path, Predicate, Result, Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId, DepartmentId } from "@vektorprogrammet/domain/organization";

import type { ReceiptFileStore, StagedReceiptFile } from "./filesystem.js";

const Text = Schema.NonEmptyString;

const FileEntry = Schema.Struct({
  path: Text,
  sha256: Text,
  byteLength: Schema.Int,
  contentType: Text,
});

const Row = Schema.Struct({
  sourcePrimaryKey: Text,
  destinationIdentity: Text,
  sourceUser: Text,
  sourceDepartment: Text,
  visualId: Schema.NullOr(Text),
  amountDecimal: Schema.String,
  description: Schema.String,
  receiptDate: Schema.String,
  submittedAt: Schema.String,
  status: Schema.String,
  refundDate: Schema.NullOr(Schema.String),
  file: Schema.NullOr(FileEntry),
  rowDigest: Text,
});

export const ReceiptSnapshot = Schema.Struct({
  kind: Schema.Literal("synthetic-receipt-import-0095"),
  sourceRepository: Text,
  sourceRevision: Text,
  snapshotId: Text,
  sourceWatermark: Text,
  transformationRevision: Text,
  persons: Schema.Array(
    Schema.Struct({
      sourceUser: Text,
      personId: Text,
      syntheticPaymentAccount: Schema.Literal("synthetic:0095:not-a-payment-account"),
    }),
  ),
  departments: Schema.Array(Schema.Struct({ sourceDepartment: Text, departmentId: Text })),
  rows: Schema.Array(
    Schema.Struct({
      sourcePrimaryKey: Text,
      destinationIdentity: Text,
      rowDigest: Text,
      data: Schema.Json,
    }),
  ),
});

export type ReceiptSnapshot = typeof ReceiptSnapshot.Type;

export const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export const rowDigest = (row: Schema.Json): string => sha256Hex(canonicalJsonBytes(row));

export const decodeSnapshot = Schema.decodeUnknownSync(ReceiptSnapshot, {
  onExcessProperty: "error",
});

/** A snapshot file the importer refuses, named by the quarantine reason it records. */
export class ReceiptSnapshotFileRejected extends Data.TaggedError("ReceiptSnapshotFileRejected")<{
  readonly reason: Extract<
    ReceiptQuarantineReason,
    "UnsafeFilePath" | "FileDigestMismatch" | "UnsupportedFile" | "UnreadableFile"
  >;
  readonly cause?: unknown;
}> {}

/** Two entries of a snapshot identity map share a source or a target. */
export class ReceiptSnapshotIdentityMapAmbiguous extends Data.TaggedError(
  "ReceiptSnapshotIdentityMapAmbiguous",
) {}

const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;

const readable = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ReceiptSnapshotFileRejected({ reason: "UnreadableFile", cause }),
  });

// Opens without following a symlink that replaced the checked path, then reads at most one
// byte past the declared length.
const readRegularFile = (resolved: string, file: typeof FileEntry.Type) =>
  Effect.acquireUseRelease(
    readable(() => open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)),
    (handle) =>
      Effect.gen(function* () {
        const metadata = yield* readable(() => handle.stat());

        if (
          !metadata.isFile() ||
          metadata.size > MAX_SNAPSHOT_FILE_BYTES ||
          metadata.size !== file.byteLength
        )
          return yield* new ReceiptSnapshotFileRejected({ reason: "FileDigestMismatch" });
        const bounded = Buffer.alloc(file.byteLength + 1);
        let length = 0;

        while (length < bounded.byteLength) {
          const offset = length;

          const result = yield* readable(() =>
            handle.read(bounded, offset, bounded.byteLength - offset, null),
          );

          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }

        const bytes = bounded.subarray(0, length);

        if (length !== file.byteLength || digest(bytes) !== file.sha256)
          return yield* new ReceiptSnapshotFileRejected({ reason: "FileDigestMismatch" });

        return bytes;
      }),
    (handle) => readable(() => handle.close()),
  );

export const readSnapshotFile = (root: string, file: typeof FileEntry.Type) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (path.isAbsolute(file.path) || file.path.split(/[\\/]/u).some((part) => part === ".."))
      return yield* new ReceiptSnapshotFileRejected({ reason: "UnsafeFilePath" });
    const boundary = yield* fs.realPath(root);
    const resolved = yield* fs.realPath(path.resolve(boundary, file.path));
    const within = path.relative(boundary, resolved);

    if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
      return yield* new ReceiptSnapshotFileRejected({ reason: "UnsafeFilePath" });
    const bytes = yield* readRegularFile(resolved, file);
    const signature = Buffer.from(bytes.subarray(0, 8));

    const valid = Match.value(file.contentType).pipe(
      Match.when("application/pdf", () => signature.subarray(0, 5).toString() === "%PDF-"),
      Match.when("image/png", () =>
        signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      ),
      Match.when(
        "image/jpeg",
        () => signature[0] === 255 && signature[1] === 216 && signature[2] === 255,
      ),
      Match.orElse(() => false),
    );

    if (!valid) return yield* new ReceiptSnapshotFileRejected({ reason: "UnsupportedFile" });

    return bytes;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ReceiptSnapshotFileRejected({ reason: "UnreadableFile", cause })),
    ),
  );

const uniqueIdentityMap = (entries: ReadonlyArray<readonly [string, string]>) => {
  const map = new Map<string, string>();

  for (const [source, target] of entries) {
    if (map.has(source) || [...map.values()].includes(target))
      return Effect.fail(new ReceiptSnapshotIdentityMapAmbiguous());
    map.set(source, target);
  }

  return Effect.succeed(map);
};

const reservedOccurrenceKeys = ["sourcePrimaryKey", "destinationIdentity", "rowDigest"];

/** A row whose data carries occurrence metadata, or does not decode exactly, is invalid. */
const decodeRow = (entry: ReceiptSnapshot["rows"][number]) =>
  Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(entry.data).pipe(
    Option.filter((data) => !reservedOccurrenceKeys.some((key) => Object.hasOwn(data, key))),
    Option.flatMap((data) =>
      Schema.decodeUnknownOption(Row)(
        {
          ...data,
          sourcePrimaryKey: entry.sourcePrimaryKey,
          destinationIdentity: entry.destinationIdentity,
          rowDigest: entry.rowDigest,
        },
        { onExcessProperty: "error" },
      ),
    ),
  );

/** Stages one row's file; a failure is the quarantine reason the row records. */
const stageSnapshotFile = (
  root: string,
  file: typeof FileEntry.Type,
  commandId: string,
  files: ReceiptFileStore,
): Effect.Effect<
  StagedReceiptFile,
  ReceiptSnapshotFileRejected["reason"],
  FileSystem.FileSystem | Path.Path
> =>
  readSnapshotFile(root, file).pipe(
    Effect.flatMap((bytes) =>
      Schema.decodeUnknownEffect(ReceiptFileSchema.fields.contentType)(file.contentType).pipe(
        Effect.flatMap((contentType) =>
          files.stageBytes(
            new File([bytes], "synthetic", { type: file.contentType }),
            commandId,
            contentType,
            MAX_SNAPSHOT_FILE_BYTES,
          ),
        ),
      ),
    ),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "ReceiptSnapshotFileRejected") ? error.reason : "UnreadableFile",
    ),
  );

/** No persistence here: every occurrence is transformed before collision checks. */
export const prepareReceiptSnapshot = (
  snapshot: ReceiptSnapshot,
  root: string,
  files: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    const persons = yield* uniqueIdentityMap(
      snapshot.persons.map((p) => [p.sourceUser, p.personId] as const),
    );

    const departments = yield* uniqueIdentityMap(
      snapshot.departments.map((p) => [p.sourceDepartment, p.departmentId] as const),
    );

    const staged: ReceiptFile[] = [];
    const failures = new Map<number, ReceiptQuarantineReason>();
    const inputs = [];
    const decoded: Array<{ index: number; row: typeof Row.Type }> = [];
    const occurrences = new Map<string, number>();
    const occurrenceIndices: number[] = [];
    const sourceCounts = new Map<string, number>();
    const destinationCounts = new Map<string, number>();
    const resultByIndex = new Map<number, ReceiptImportResult>();

    const provenanceFor = (entry: (typeof snapshot.rows)[number]) => ({
      sourceRepository: snapshot.sourceRepository,
      sourceRevision: snapshot.sourceRevision,
      snapshotId: snapshot.snapshotId,
      sourceWatermark: snapshot.sourceWatermark,
      transformationRevision: snapshot.transformationRevision,
      sourceDigest: entry.rowDigest,
      destinationIdentity: entry.destinationIdentity,
    });

    for (const [index, entry] of snapshot.rows.entries()) {
      const occurrence = occurrences.get(entry.sourcePrimaryKey) ?? 0;
      occurrenceIndices.push(occurrence);
      occurrences.set(entry.sourcePrimaryKey, occurrence + 1);

      sourceCounts.set(entry.sourcePrimaryKey, (sourceCounts.get(entry.sourcePrimaryKey) ?? 0) + 1);

      destinationCounts.set(
        entry.destinationIdentity,
        (destinationCounts.get(entry.destinationIdentity) ?? 0) + 1,
      );

      const row = decodeRow(entry);

      if (Option.isSome(row)) decoded.push({ index, row: row.value });
      else {
        resultByIndex.set(
          index,
          ReceiptImportResult.QuarantinedReceiptImport({
            sourcePrimaryKey: entry.sourcePrimaryKey,
            sourceOccurrence: occurrence,
            targetSemanticIdentity: entry.destinationIdentity,
            reasons: ["InvalidSourceRow"],
            provenance: provenanceFor(entry),
            reconciliation: "NotApplicable",
          }),
        );
      }
    }

    for (const { index, row } of decoded) {
      const { rowDigest: expectedDigest, ...source } = row;
      let file: ReceiptFile | null = null;

      if (rowDigest(source) !== expectedDigest) failures.set(index, "SourceDigestMismatch");
      else if (row.file !== null) {
        const result = yield* Effect.result(
          stageSnapshotFile(
            root,
            row.file,
            `${snapshot.snapshotId}:${row.sourcePrimaryKey}:${index}`,
            files,
          ),
        );

        if (Result.isSuccess(result)) {
          file = result.success.file;

          if (result.success.created) staged.push(file);
        } else failures.set(index, result.failure);
      }

      inputs.push({
        receiptId: row.destinationIdentity,
        row: {
          sourcePrimaryKey: row.sourcePrimaryKey,
          ownerPersonId: persons.has(row.sourceUser)
            ? PersonId.make(persons.get(row.sourceUser)!)
            : null,
          departmentId: departments.has(row.sourceDepartment)
            ? DepartmentId.make(departments.get(row.sourceDepartment)!)
            : null,
          visualId: row.visualId,
          amountDecimal: row.amountDecimal,
          description: row.description,
          receiptDate: row.receiptDate,
          submittedAt: row.submittedAt,
          status: row.status,
          refundDate: row.refundDate,
          paymentAccountCiphertext:
            snapshot.persons.find((person) => person.sourceUser === row.sourceUser)
              ?.syntheticPaymentAccount ?? null,
          file,
        },
        provenance: {
          sourceRepository: snapshot.sourceRepository,
          sourceRevision: snapshot.sourceRevision,
          snapshotId: snapshot.snapshotId,
          sourceWatermark: snapshot.sourceWatermark,
          transformationRevision: snapshot.transformationRevision,
          sourceDigest: expectedDigest,
          destinationIdentity: row.destinationIdentity,
        },
      });
    }

    importLegacyReceipts(inputs).forEach((result, localIndex) => {
      const index = decoded[localIndex]!.index;
      const failure = failures.get(index);
      resultByIndex.set(
        index,
        failure === undefined
          ? result
          : ReceiptImportResult.QuarantinedReceiptImport({
              sourcePrimaryKey: result.sourcePrimaryKey,
              sourceOccurrence: result.sourceOccurrence,
              targetSemanticIdentity: result.targetSemanticIdentity,
              provenance: result.provenance,
              reconciliation: "NotApplicable",
              reasons: [
                ...(Predicate.isTagged(result, "QuarantinedReceiptImport") ? result.reasons : []),
                failure,
              ],
            }),
      );
    });

    const results = snapshot.rows.map((entry, index): ReceiptImportResult => {
      const result = resultByIndex.get(index)!;
      const collisions: ReceiptQuarantineReason[] = [];

      if (sourceCounts.get(entry.sourcePrimaryKey)! > 1) collisions.push("SourceIdentityCollision");

      if (destinationCounts.get(entry.destinationIdentity)! > 1)
        collisions.push("DestinationIdentityCollision");

      if (collisions.length === 0)
        return { ...result, sourceOccurrence: occurrenceIndices[index]! };

      return ReceiptImportResult.QuarantinedReceiptImport({
        sourcePrimaryKey: result.sourcePrimaryKey,
        sourceOccurrence: occurrenceIndices[index]!,
        targetSemanticIdentity: result.targetSemanticIdentity,
        provenance: result.provenance,
        reconciliation: "NotApplicable",
        reasons: [
          ...new Set([
            ...(Predicate.isTagged(result, "QuarantinedReceiptImport") ? result.reasons : []),
            ...collisions,
          ]),
        ],
      });
    });

    return {
      results,
      staged,
      fileFailures: [...failures].map(([occurrence, reason]) => ({ occurrence, reason })),
    };
  });
