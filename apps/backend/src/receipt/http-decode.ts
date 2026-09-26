/** Receipt request decoding: query strings, list cursors, multipart, and JSON bodies. */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  ReceiptDecodeError,
  decodeReceiptCursor,
  isIsoDate,
  type ReceiptStatus,
} from "@vektorprogrammet/domain/receipt";
import {
  RecordReceiptSettlementRequest,
  readBoundedReceiptForm,
  receiptTransferMaxBytes,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Predicate } from "effect";
import { decodeRequest, readJsonBody, requestInvalid } from "../http-api/problem.js";

const SUPPORTED_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

type MultipartFields = ReadonlyMap<string, Array<string | File>>;

const isReceiptStatus = (value: string): value is ReceiptStatus => {
  switch (value) {
    case "Pending":
    case "Approved":
    case "Rejected":
    case "Withdrawn":
      return true;
    default:
      return false;
  }
};

const isSupportedContentType = (value: string): value is SupportedContentType =>
  SUPPORTED_CONTENT_TYPES.some((contentType) => contentType === value);

/** Decodes `status` and `cursor`; a present cursor must decode before any read. */
export const decodeReceiptListQuery = (request: Request, allowStatus = true) =>
  Effect.gen(function* () {
    const search = new URL(request.url).searchParams;

    if (
      [...search.keys()].some((key) => key !== "cursor" && !(allowStatus && key === "status")) ||
      search.getAll("status").length > 1 ||
      search.getAll("cursor").length > 1
    ) {
      return yield* Effect.fail(Problem.make("request.malformed"));
    }

    const status = search.get("status") ?? undefined;

    if (status !== undefined && !isReceiptStatus(status)) {
      return yield* Effect.fail(Problem.make("request.malformed"));
    }

    const cursor = search.get("cursor") ?? undefined;

    if (cursor !== undefined) {
      yield* decodeReceiptCursor(cursor).pipe(
        Effect.mapError(() => Problem.make("request.malformed")),
      );
    }

    return { status, cursor };
  });

/** Decodes the optional single `departmentId` submit query parameter. */
export const decodeSubmitQuery = (request: Request) =>
  Effect.gen(function* () {
    const entries = [...new URL(request.url).searchParams.entries()];

    if (
      entries.some(([name]) => name !== "departmentId") ||
      entries.filter(([name]) => name === "departmentId").length > 1
    ) {
      return yield* Effect.fail(Problem.make("request.malformed"));
    }

    const value = entries[0]?.[1];

    if (value === undefined) return undefined;

    if (value.trim().length === 0) return yield* Effect.fail(requestInvalid());

    return DepartmentId.make(value);
  });

/**
 * Runs throwing field checks: a ReceiptDecodeError fails the request's
 * validation, anything else is a defect.
 */
const validated = <A>(decode: () => A): Effect.Effect<A, Problem<"validation.failed">> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decode());
    } catch (cause) {
      return cause instanceof ReceiptDecodeError
        ? Effect.fail(requestInvalid())
        : Effect.die(cause);
    }
  });

const parseSafeAmountOre = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new ReceiptDecodeError({ message: "invalid amountOre" });
  const amountOre = Number(value);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptDecodeError({ message: "invalid amountOre" });
  }

  return amountOre;
};

const readSingleField = (fields: MultipartFields, name: string): string => {
  const values = fields.get(name);

  if (values === undefined || values.length !== 1 || !Predicate.isString(values[0])) {
    throw new ReceiptDecodeError({ message: `invalid ${name}` });
  }

  return values[0];
};

const decodeMultipartFields = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
      return yield* Effect.fail(requestInvalid());
    }

    const contentLength = request.headers.get("content-length");

    if (contentLength === null || !/^\d+$/.test(contentLength)) {
      return yield* Effect.fail(requestInvalid());
    }

    const bodyLength = Number(contentLength);

    if (
      !Number.isSafeInteger(bodyLength) ||
      bodyLength <= 0 ||
      bodyLength > receiptTransferMaxBytes(maxFileBytes)
    ) {
      return yield* Effect.fail(requestInvalid());
    }

    const form = yield* Effect.tryPromise({
      try: () => readBoundedReceiptForm(request, maxFileBytes),
      catch: requestInvalid,
    });

    const fields = new Map<string, Array<string | File>>();

    for (const [name, value] of form.entries()) {
      const values = fields.get(name);

      if (values === undefined) fields.set(name, [value]);
      else values.push(value);
    }

    return fields;
  });

const requireMultipartFields = (
  fields: MultipartFields,
  required: Readonly<Record<string, true>>,
  optional: Readonly<Record<string, true>> = {},
): void => {
  for (const name of fields.keys()) {
    if (required[name] !== true && optional[name] !== true) {
      throw new ReceiptDecodeError({ message: "unexpected multipart field" });
    }
  }

  const requiredNames = Object.keys(required);

  if (
    fields.size < requiredNames.length ||
    fields.size > requiredNames.length + Object.keys(optional).length
  ) {
    throw new ReceiptDecodeError({ message: "invalid multipart fields" });
  }

  for (const name of requiredNames) {
    if (!fields.has(name)) throw new ReceiptDecodeError({ message: "missing multipart field" });
  }
};

interface DecodedReceiptFile {
  readonly file?: File;
  readonly contentType?: SupportedContentType;
}

const decodeReceiptFile = (
  fields: MultipartFields,
  maxFileBytes: number,
  required: boolean,
): DecodedReceiptFile => {
  const fileValues = fields.get("file");

  if (fileValues === undefined) {
    if (required) throw new ReceiptDecodeError({ message: "receipt file is required" });

    return {};
  }

  if (fileValues.length !== 1 || !(fileValues[0] instanceof File)) {
    throw new ReceiptDecodeError({ message: "invalid receipt file" });
  }

  const file = fileValues[0];

  if (file.size <= 0 || file.size > maxFileBytes || !isSupportedContentType(file.type)) {
    throw new ReceiptDecodeError({ message: "unsupported receipt file" });
  }

  return { file, contentType: file.type };
};

export const decodeSubmitMultipart = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const fields = yield* decodeMultipartFields(request, maxFileBytes);

    return yield* validated(() => {
      requireMultipartFields(fields, {
        description: true,
        amountOre: true,
        receiptDate: true,
        file: true,
      });
      const description = readSingleField(fields, "description");
      const amountOre = parseSafeAmountOre(readSingleField(fields, "amountOre"));
      const receiptDate = readSingleField(fields, "receiptDate");

      if (description.length < 1 || description.length > 5000) {
        throw new ReceiptDecodeError({ message: "invalid receipt description" });
      }

      if (!isIsoDate(receiptDate)) {
        throw new ReceiptDecodeError({ message: "invalid receipt date" });
      }

      const decodedFile = decodeReceiptFile(fields, maxFileBytes, true);

      if (decodedFile.file === undefined || decodedFile.contentType === undefined) {
        throw new ReceiptDecodeError({ message: "receipt file is required" });
      }

      return {
        description,
        amountOre,
        receiptDate,
        file: decodedFile.file,
        contentType: decodedFile.contentType,
      };
    });
  });

export const decodeReviseMultipart = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const fields = yield* decodeMultipartFields(request, maxFileBytes);

    return yield* validated(() => {
      requireMultipartFields(
        fields,
        {},
        {
          description: true,
          amountOre: true,
          receiptDate: true,
          file: true,
        },
      );

      if (fields.size === 0) {
        throw new ReceiptDecodeError({
          message: "receipt revision must change at least one field",
        });
      }

      const description = fields.has("description")
        ? readSingleField(fields, "description")
        : undefined;

      if (description !== undefined && (description.length < 1 || description.length > 5000)) {
        throw new ReceiptDecodeError({ message: "invalid receipt description" });
      }

      const amountOre = fields.has("amountOre")
        ? parseSafeAmountOre(readSingleField(fields, "amountOre"))
        : undefined;

      const receiptDate = fields.has("receiptDate")
        ? readSingleField(fields, "receiptDate")
        : undefined;

      if (receiptDate !== undefined && !isIsoDate(receiptDate)) {
        throw new ReceiptDecodeError({ message: "invalid receipt date" });
      }

      const decodedFile = decodeReceiptFile(fields, maxFileBytes, false);

      const parsedFields: DecodedReceiptFile & {
        description?: string;
        amountOre?: number;
        receiptDate?: string;
      } = { ...decodedFile };

      if (description !== undefined) parsedFields.description = description;

      if (amountOre !== undefined) parsedFields.amountOre = amountOre;

      if (receiptDate !== undefined) parsedFields.receiptDate = receiptDate;

      return parsedFields;
    });
  });

/**
 * One bounded `application/json` object; media type parameters and
 * surrounding space are accepted.
 */
const decodeJsonObject = (request: Request) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(request, /^\s*application\/json\s*(?:;|$)/iu, 65_536);

    if (body === null || !Predicate.isObjectOrArray(body) || Array.isArray(body)) {
      return yield* Effect.fail(requestInvalid());
    }

    return body;
  });

export const decodeExactEmptyJson = (request: Request) =>
  decodeJsonObject(request).pipe(
    Effect.flatMap((body) =>
      Object.keys(body).length === 0 ? Effect.succeed({}) : Effect.fail(requestInvalid()),
    ),
  );

export const decodeSettlementRequest = (request: Request) =>
  decodeJsonObject(request).pipe(Effect.flatMap(decodeRequest(RecordReceiptSettlementRequest)));
