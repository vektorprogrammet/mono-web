/** Spec 0095: bounded synthetic snapshot adapter, using the Receipt importer. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import { canonicalJson } from "../../../../packages/domain/src/tutor/evidence.js";
import { PersonId, DepartmentId } from "../../../../packages/domain/src/organization/schema.js";
import {
  importLegacyReceipts,
  type ReceiptQuarantineReason,
  type ReceiptImportResult,
} from "../../../../packages/domain/src/receipt/import.js";
import type { ReceiptFile } from "../../../../packages/domain/src/receipt/schema.js";
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
  persons: Schema.Array(Schema.Struct({ sourceUser: Text, personId: Text })),
  departments: Schema.Array(Schema.Struct({ sourceDepartment: Text, departmentId: Text })),
  rows: Schema.Array(Row),
});
export type ReceiptSnapshot = typeof ReceiptSnapshot.Type;
export const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
export const rowDigest = (row: Omit<typeof Row.Type, "rowDigest">): string =>
  digest(canonicalJson(row));
export const decodeSnapshot = (input: unknown): ReceiptSnapshot =>
  Schema.decodeUnknownSync(ReceiptSnapshot)(input, { onExcessProperty: "error" });

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
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024 || metadata.size !== file.byteLength)
    throw new Error("FileDigestMismatch");
  const bytes = await readFile(path);
  if (
    bytes.byteLength > 10 * 1024 * 1024 ||
    bytes.byteLength !== file.byteLength ||
    digest(bytes) !== file.sha256
  )
    throw new Error("FileDigestMismatch");
  const signature = Buffer.from(bytes.subarray(0, 8));
  const valid =
    file.contentType === "application/pdf"
      ? signature.subarray(0, 5).toString() === "%PDF-"
      : file.contentType === "image/png"
        ? signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : file.contentType === "image/jpeg"
          ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
          : false;
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
  for (const [index, row] of snapshot.rows.entries()) {
    const { rowDigest: expectedDigest, ...source } = row;
    let file: ReceiptFile | null = null;
    if (rowDigest(source) !== expectedDigest) failures.set(index, "SourceDigestMismatch");
    else if (row.file !== null) {
      try {
        const bytes = await readSnapshotFile(root, row.file);
        const result = await files.stageBytes(
          new File([bytes], "synthetic", { type: row.file.contentType }),
          `${snapshot.snapshotId}:${row.sourcePrimaryKey}:${index}`,
          row.file.contentType as ReceiptFile["contentType"],
          10 * 1024 * 1024,
        );
        file = result.file;
        if (result.created) staged.push(file);
      } catch (error) {
        failures.set(
          index,
          error instanceof Error &&
            ["UnsafeFilePath", "FileDigestMismatch", "UnsupportedFile"].includes(error.message)
            ? (error.message as ReceiptQuarantineReason)
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
        paymentAccountCiphertext: "synthetic:0095:not-a-payment-account",
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
  const results = importLegacyReceipts(inputs).map((result, index): ReceiptImportResult => {
    const failure = failures.get(index);
    return failure === undefined
      ? result
      : {
          ...result,
          _tag: "QuarantinedReceiptImport",
          reconciliation: "NotApplicable",
          reasons: [...(result._tag === "QuarantinedReceiptImport" ? result.reasons : []), failure],
        };
  });
  return {
    results,
    staged,
    fileFailures: [...failures].map(([occurrence, reason]) => ({ occurrence, reason })),
  };
};
