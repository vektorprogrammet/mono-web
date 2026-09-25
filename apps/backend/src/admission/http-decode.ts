/** Admission request decoding: query strings, JSON bodies, and admission period merge patches. */
import { AdmissionPeriodMergePatch } from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Schema } from "effect";
import { semanticProblems } from "../http-api/problem.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { HttpSemanticFailure } from "../http-semantics.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";

/** No admission operation takes query parameters, so any query string is malformed. */
export const rejectQueryString = (request: Request) =>
  new URL(request.url).search === "" ? Effect.void : Effect.fail(Problem.make("request.malformed"));

/**
 * Reads one JSON body in the operation's media type. Another media type is 415, and a
 * body that is not bounded, well-formed JSON keeps the reader's 400 or 413 problem.
 */
const readJsonBody = (request: Request, mediaType: RegExp, maxBodyBytes: number) =>
  mediaType.test(request.headers.get("content-type") ?? "")
    ? semanticProblems(readBoundedJson(request, maxBodyBytes), [
        "request.malformed",
        "request.too-large",
        "internal.error",
      ])
    : Effect.fail(Problem.make("media-type.unsupported"));

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, maxBodyBytes);

    return yield* Schema.decodeUnknownEffect(schema)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));
  });

export const decodeAdmissionPeriodPatch = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(
      request,
      /^application\/merge-patch\+json(?:\s*;|$)/iu,
      input.config.maxBodyBytes,
    );

    const patch = yield* Schema.decodeUnknownEffect(AdmissionPeriodMergePatch)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));

    if (!Object.hasOwn(patch, "startAt") && !Object.hasOwn(patch, "endAt")) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.no-change", 422));
    }

    if (patch.startAt === null || patch.endAt === null) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.field-not-deletable", 422));
    }

    return patch;
  });
