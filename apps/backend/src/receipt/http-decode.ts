/** Receipt request decoding: query strings, list cursors, preconditions, multipart, and JSON bodies. */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  ReceiptDecodeError,
  decodeReceiptCursor,
  isIsoDate,
  type ReceiptStatus,
} from "@vektorprogrammet/domain/receipt";
import { RecordReceiptSettlementRequest, readBoundedReceiptForm } from "@vektorprogrammet/http-api";
import { Effect, Predicate, Schema } from "effect";
import { readBoundedJson } from "../http-api/read-json.js";
import { HttpSemanticFailure, parseRequiredIfMatch } from "../http-semantics.js";
import { knownReceiptFailure } from "./http-problem.js";

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

export const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

export const requiredIfMatch = (request: Request) =>
  Effect.try({
    try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
    catch: knownReceiptFailure,
  });

/** Commands and single-resource reads accept no query string. */
export const rejectQueryString = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search.length > 0) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: knownReceiptFailure,
  });

/** Decodes `status` and `cursor`; a present cursor must decode before any read. */
export const decodeReceiptListQuery = (request: Request, allowStatus = true) =>
  Effect.gen(function* () {
    const query = yield* Effect.try({
      try: () => {
        const search = new URL(request.url).searchParams;

        if (
          [...search.keys()].some(
            (key) => key !== "cursor" && !(allowStatus && key === "status"),
          ) ||
          search.getAll("status").length > 1 ||
          search.getAll("cursor").length > 1
        ) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }

        const status = search.get("status") ?? undefined;

        if (status !== undefined && !isReceiptStatus(status))
          throw new HttpSemanticFailure("request.malformed", 400);

        return { status, cursor: search.get("cursor") ?? undefined };
      },
      catch: () => new HttpSemanticFailure("request.malformed", 400),
    });

    if (query.cursor !== undefined) yield* decodeReceiptCursor(query.cursor);

    return query;
  });

/** Decodes the optional single `departmentId` submit query parameter. */
export const decodeSubmitQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const entries = [...new URL(request.url).searchParams.entries()];

      if (
        entries.some(([name]) => name !== "departmentId") ||
        entries.filter(([name]) => name === "departmentId").length > 1
      ) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      const value = entries[0]?.[1];

      if (value === undefined) return undefined;

      if (value.trim().length === 0) {
        throw new ReceiptDecodeError({ message: "invalid departmentId" });
      }

      return DepartmentId.make(value);
    },
    catch: knownReceiptFailure,
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
  Effect.tryPromise({
    try: async () => {
      const contentType = request.headers.get("content-type") ?? "";

      if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
        throw new ReceiptDecodeError({ message: "multipart form required" });
      }

      const contentLength = request.headers.get("content-length");

      if (contentLength === null || !/^\d+$/.test(contentLength)) {
        throw new ReceiptDecodeError({ message: "valid body length required" });
      }

      const bodyLength = Number(contentLength);

      if (
        !Number.isSafeInteger(bodyLength) ||
        bodyLength <= 0 ||
        bodyLength > maxFileBytes + 131_072
      ) {
        throw new ReceiptDecodeError({ message: "multipart body exceeds configured limit" });
      }

      let form: FormData;

      try {
        form = await readBoundedReceiptForm(request, maxFileBytes);
      } catch {
        throw new ReceiptDecodeError({ message: "invalid multipart body" });
      }

      const fields = new Map<string, Array<string | File>>();

      for (const [name, value] of form.entries()) {
        const values = fields.get(name);

        if (values === undefined) fields.set(name, [value]);
        else values.push(value);
      }

      return fields;
    },
    catch: knownReceiptFailure,
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

    return yield* Effect.try({
      try: () => {
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
      },
      catch: knownReceiptFailure,
    });
  });

export const decodeReviseMultipart = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const fields = yield* decodeMultipartFields(request, maxFileBytes);

    return yield* Effect.try({
      try: () => {
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
      },
      catch: knownReceiptFailure,
    });
  });

const decodeJsonObject = (request: Request) => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") {
    return Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
  }

  return readBoundedJson(request, 65_536).pipe(
    Effect.flatMap((body) =>
      body === null || !(body === null || Predicate.isObjectOrArray(body)) || Array.isArray(body)
        ? Effect.fail(new ReceiptDecodeError({ message: "request body must be an object" }))
        : Effect.succeed(body),
    ),
  );
};

export const decodeExactEmptyJson = (request: Request) =>
  decodeJsonObject(request).pipe(
    Effect.flatMap((body) =>
      Object.keys(body).length === 0
        ? Effect.succeed({})
        : Effect.fail(
            new ReceiptDecodeError({ message: "request body must be the exact empty object" }),
          ),
    ),
  );

export const decodeSettlementRequest = (request: Request) =>
  decodeJsonObject(request).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(RecordReceiptSettlementRequest)(body, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          () => new ReceiptDecodeError({ message: "invalid settlement evidence request" }),
        ),
      ),
    ),
  );
