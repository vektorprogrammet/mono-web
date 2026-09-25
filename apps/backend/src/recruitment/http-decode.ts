/** Recruitment request decoding: query strings, preconditions, invitation capabilities, and JSON bodies. */
import {
  InterviewReportQuery,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentInvitationCapabilitySchema,
} from "@vektorprogrammet/domain/recruitment";
import { Effect, Schema, flow } from "effect";
import {
  HttpSemanticFailure,
  parseJsonWithoutDuplicateMembers,
  parseRequiredIfMatch,
} from "../http-semantics.js";
import { knownRecruitmentFailure } from "./http-problem.js";

export const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  failure: {
    readonly code: "request.malformed" | "validation.failed";
    readonly status: 400 | 422;
  } = { code: "validation.failed", status: 422 },
) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure(failure.code, failure.status)),
  );

export const readRecruitmentRequestBody = (
  request: Request,
  maxBodyBytes: number,
  malformedOnly = false,
) =>
  Effect.tryPromise({
    try: async () => {
      const fail = (
        code: "request.malformed" | "media-type.unsupported" | "request.too-large",
        status: 400 | 413 | 415,
      ) => {
        throw new HttpSemanticFailure(
          malformedOnly ? "request.malformed" : code,
          malformedOnly ? 400 : status,
        );
      };

      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

      if (mediaType !== "application/json") fail("media-type.unsupported", 415);
      const declaredLength = request.headers.get("content-length");

      if (declaredLength !== null) {
        const length = Number(declaredLength);

        if (!Number.isSafeInteger(length) || length < 0) fail("request.malformed", 400);

        if (length > maxBodyBytes) fail("request.too-large", 413);
      }

      const chunks: Uint8Array[] = [];
      let byteLength = 0;

      if (request.body !== null) {
        const reader = request.body.getReader();

        try {
          while (true) {
            const chunk = await reader.read();

            if (chunk.done) break;
            byteLength += chunk.value.byteLength;

            if (byteLength > maxBodyBytes) {
              await reader.cancel().catch(() => undefined);
              fail("request.too-large", 413);
            }

            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      const bytes = new Uint8Array(byteLength);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      try {
        return parseJsonWithoutDuplicateMembers(bytes);
      } catch (cause) {
        if (malformedOnly && cause instanceof HttpSemanticFailure) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }

        throw cause;
      }
    },
    catch: knownRecruitmentFailure,
  });

export const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

export const requiredIfMatch = (request: Request) =>
  Effect.try({
    try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
    catch: knownRecruitmentFailure,
  });

/** Commands and single-resource reads accept no query string. */
export const rejectQueryString = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search.length > 0) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: knownRecruitmentFailure,
  });

/** Decodes the single `status` assignment-board query parameter. */
export const decodeBoardQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];

      if (parameters.length !== 1 || parameters[0]?.[0] !== "status") {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      return { status: parameters[0][1] };
    },
    catch: knownRecruitmentFailure,
  }).pipe(Effect.flatMap((query) => strictDecode(RecruitmentAssignmentBoardQuerySchema)(query)));

/** Decodes interview-report query parameters; each parameter may appear once. */
export const decodeInterviewReportQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const values = new URL(request.url).searchParams;

      for (const key of values.keys()) {
        if (values.getAll(key).length !== 1) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }
      }

      return Object.fromEntries(values);
    },
    catch: knownRecruitmentFailure,
  }).pipe(Effect.flatMap((query) => strictDecode(InterviewReportQuery)(query)));

export const invitationCapability = (request: Request) =>
  Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(
    request.headers.get("x-recruitment-invitation-capability"),
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new HttpSemanticFailure("resource.not-found", 404)));
