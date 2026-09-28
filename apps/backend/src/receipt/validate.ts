/**
 * Receipt payload checks: the bounds that the multipart reader enforced, now on decoded RPC
 * payloads. A field outside its bound answers validation.failed at the root, as before.
 */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { decodeReceiptCursor, isIsoDate } from "@vektorprogrammet/domain/receipt";
import type {
  ReceiptFileMediaType,
  ReceiptFileUpload,
  ReviseReceiptRequest,
  SubmitReceiptRequest,
} from "@vektorprogrammet/rpc";
import type { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect } from "effect";
import { requestInvalid } from "../rpc/problem.js";

const SUPPORTED_CONTENT_TYPES: ReadonlyArray<ReceiptFileMediaType> = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

const isSupportedContentType = (value: string): value is ReceiptFileMediaType =>
  SUPPORTED_CONTENT_TYPES.some((contentType) => contentType === value);

/** One receipt file within its media types and byte bound, as a `File` that staging reads. */
export interface ValidatedReceiptFile {
  readonly file: File;
  readonly contentType: ReceiptFileMediaType;
}

type Invalid = Problem<"validation.failed">;

const invalid = (): Effect.Effect<never, Invalid> => Effect.fail(requestInvalid());

const validDescription = (description: string) =>
  description.length >= 1 && description.length <= 5000;

const validAmountOre = (amountOre: number) => Number.isSafeInteger(amountOre) && amountOre > 0;

/** The web `File` of uploaded bytes, which the staging store reads as it read a multipart part. */
const uploadedFile = (bytes: Uint8Array, contentType: ReceiptFileMediaType): File =>
  new File(
    [bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes)],
    "receipt",
    { type: contentType },
  );

const validateFile = (upload: ReceiptFileUpload, maxFileBytes: number) =>
  upload.bytes.byteLength <= 0 ||
  upload.bytes.byteLength > maxFileBytes ||
  !isSupportedContentType(upload.contentType)
    ? invalid()
    : Effect.succeed<ValidatedReceiptFile>({
        file: uploadedFile(upload.bytes, upload.contentType),
        contentType: upload.contentType,
      });

/** Checks a submission's fields and file against the bounds of the multipart reader. */
export const validateSubmission = (input: {
  readonly request: SubmitReceiptRequest;
  readonly maxFileBytes: number;
}) => {
  const { request } = input;

  return !validDescription(request.description) ||
    !validAmountOre(request.amountOre) ||
    !isIsoDate(request.receiptDate)
    ? invalid()
    : Effect.map(validateFile(request.file, input.maxFileBytes), (file) => ({
        description: request.description,
        amountOre: request.amountOre,
        receiptDate: request.receiptDate,
        file,
      }));
};

/** Checks a revision's present fields; a revision that changes no field fails validation. */
export const validateRevision = (input: {
  readonly request: ReviseReceiptRequest;
  readonly maxFileBytes: number;
}) =>
  Effect.gen(function* () {
    const { request } = input;

    if (
      request.description === undefined &&
      request.amountOre === undefined &&
      request.receiptDate === undefined &&
      request.file === undefined
    ) {
      return yield* invalid();
    }

    if (request.description !== undefined && !validDescription(request.description)) {
      return yield* invalid();
    }

    if (request.amountOre !== undefined && !validAmountOre(request.amountOre)) {
      return yield* invalid();
    }

    if (request.receiptDate !== undefined && !isIsoDate(request.receiptDate)) {
      return yield* invalid();
    }

    const file =
      request.file === undefined
        ? undefined
        : yield* validateFile(request.file, input.maxFileBytes);

    return {
      description: request.description,
      amountOre: request.amountOre,
      receiptDate: request.receiptDate,
      file,
    };
  });

/** The optional submission department; an empty one fails validation, as its query did. */
export const validateSubmitDepartment = (departmentId: string | undefined) =>
  Effect.gen(function* () {
    if (departmentId === undefined) return undefined;

    if (departmentId.trim().length === 0) return yield* invalid();

    return DepartmentId.make(departmentId);
  });

/**
 * A list cursor must decode before any read. The payload schema admits only cursor text, so a
 * cursor whose text decodes to no position was not issued by a list: a defect.
 */
export const requireReceiptCursor = (cursor: string | undefined) =>
  cursor === undefined ? Effect.void : decodeReceiptCursor(cursor).pipe(Effect.orDie, Effect.asVoid);
