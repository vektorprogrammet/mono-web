/** Content request decoding: strict schemas, query strings, preconditions, and JSON bodies. */
import { ContentWorkspaceQuerySchema } from "@vektorprogrammet/domain/content";
import { Effect, Schema, flow } from "effect";
import { readBoundedJson } from "../http-api/read-json.js";
import { HttpSemanticFailure, parseRequiredIfMatch } from "../http-semantics.js";
import { knownContentFailure } from "./http-problem.js";

export const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );

/** The one media type, with optional parameters, each content body accepts. */
const bodyMediaTypes = {
  "application/json": /^application\/json(?:\s*;|$)/iu,
  "application/merge-patch+json": /^application\/merge-patch\+json(?:\s*;|$)/iu,
};

export const readContentRequestBody = (
  request: Request,
  expectedMediaType: "application/json" | "application/merge-patch+json",
  maxBodyBytes: number,
) =>
  bodyMediaTypes[expectedMediaType].test(request.headers.get("content-type") ?? "")
    ? readBoundedJson(request, maxBodyBytes)
    : Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));

export const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

export const requiredIfMatch = (request: Request) =>
  Effect.try({
    try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
    catch: knownContentFailure,
  });

/** Commands and single-resource reads accept no query string. */
export const rejectQueryString = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search.length > 0) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: knownContentFailure,
  });

export const departmentFromQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];

      if (parameters.some(([key]) => key !== "department")) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      const values = parameters
        .values()
        .filter(([key]) => key === "department")
        .map(([, value]) => value)
        .toArray();

      if (values.length > 1) throw new HttpSemanticFailure("request.malformed", 400);

      return values.length === 0 ? {} : { departmentId: values[0] };
    },
    catch: knownContentFailure,
  }).pipe(Effect.flatMap((query) => strictDecode(ContentWorkspaceQuerySchema)(query)));

export const versionFromQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];

      if (parameters.some(([key]) => key !== "version")) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      const values = parameters
        .values()
        .filter(([key]) => key === "version")
        .map(([, value]) => value)
        .toArray();

      if (values.length > 1) throw new HttpSemanticFailure("request.malformed", 400);

      if (values.length === 0) return undefined;
      const version = Number(values[0]);

      if (!Number.isSafeInteger(version) || version < 1) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      return version;
    },
    catch: knownContentFailure,
  });
