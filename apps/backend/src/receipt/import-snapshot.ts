import {
  ReceiptFileSchema,
  ReceiptImportResult,
  importLegacyReceipts,
  type ReceiptQuarantineReason,
  type ReceiptFile,
} from "@vektorprogrammet/domain/receipt";
/** Spec 0095: bounded synthetic snapshot adapter, using the Receipt importer. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Match, Predicate, Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId, DepartmentId } from "@vektorprogrammet/domain/organization";

import type { ReceiptFileStore } from "./filesystem.js";

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

export const readSnapshotFile = async (
  root: string,
  file: typeof FileEntry.Type,
): Promise<Uint8Array> => {
  if (isAbsolute(file.path) || file.path.split(/[\\/]/u).some((part) => part === ".."))
    throw new Error("UnsafeFilePath");
  const boundary = await realpath(root);
  const path = await realpath(resolve(boundary, file.path));
  const within = relative(boundary, path);

  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("UnsafeFilePath");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;

  try {
    const metadata = await handle.stat();

    if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024 || metadata.size !== file.byteLength)
      throw new Error("FileDigestMismatch");
    const bounded = Buffer.alloc(file.byteLength + 1);
    let length = 0;

    while (length < bounded.byteLength) {
      const result = await handle.read(bounded, length, bounded.byteLength - length, null);

      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }

    bytes = bounded.subarray(0, length);

    if (length !== file.byteLength || digest(bytes) !== file.sha256)
      throw new Error("FileDigestMismatch");
  } finally {
    await handle.close();
  }

  const signature = Buffer.from(bytes.subarray(0, 8));

  const valid = Match.value(file.contentType).pipe(
    Match.when("application/pdf", () => signature.subarray(0, 5).toString() === "%PDF-"),
    Match.when("image/png", () => signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))),
    Match.when(
      "image/jpeg",
      () => signature[0] === 255 && signature[1] === 216 && signature[2] === 255,
    ),
    Match.orElse(() => false),
  );

  if (!valid) throw new Error("UnsupportedFile");

  return bytes;
};

/** No persistence here: every occurrence is transformed before collision checks. */
export const prepareReceiptSnapshot = async (
  snapshot: ReceiptSnapshot,
  root: string,
  files: ReceiptFileStore,
) => {
  const unique = (entries: ReadonlyArray<readonly [string, string]>) => {
    const map = new Map<string, string>();

    for (const [source, target] of entries) {
      if (map.has(source) || [...map.values()].includes(target))
        throw new Error("AmbiguousIdentityMap");
      map.set(source, target);
    }

    return map;
  };

  const persons = unique(snapshot.persons.map((p) => [p.sourceUser, p.personId] as const));

  const departments = unique(
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

    try {
      const data = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        entry.data,
      );

      if (
        ["sourcePrimaryKey", "destinationIdentity", "rowDigest"].some((key) =>
          Object.hasOwn(data, key),
        )
      )
        throw new Error("reserved occurrence metadata in row data");
      decoded.push({
        index,
        row: Schema.decodeUnknownSync(Row)(
          {
            ...data,
            sourcePrimaryKey: entry.sourcePrimaryKey,
            destinationIdentity: entry.destinationIdentity,
            rowDigest: entry.rowDigest,
          },
          { onExcessProperty: "error" },
        ),
      });
    } catch {
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
      try {
        const bytes = await readSnapshotFile(root, row.file);

        const result = await files.stageBytes(
          new File([bytes], "synthetic", { type: row.file.contentType }),
          `${snapshot.snapshotId}:${row.sourcePrimaryKey}:${index}`,
          Schema.decodeUnknownSync(ReceiptFileSchema.fields.contentType)(row.file.contentType),
          10 * 1024 * 1024,
        );

        file = result.file;

        if (result.created) staged.push(file);
      } catch (error) {
        failures.set(
          index,
          error instanceof Error
            ? Match.value(error.message).pipe(
                Match.when("UnsafeFilePath", () => "UnsafeFilePath" as const),
                Match.when("FileDigestMismatch", () => "FileDigestMismatch" as const),
                Match.when("UnsupportedFile", () => "UnsupportedFile" as const),
                Match.orElse(() => "UnreadableFile" as const),
              )
            : "UnreadableFile",
        );
      }
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

    if (collisions.length === 0) return { ...result, sourceOccurrence: occurrenceIndices[index]! };

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
};
