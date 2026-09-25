/** Admission request decoding: query strings, JSON bodies, and admission period merge patches. */
import { AdmissionPeriodMergePatch } from "@vektorprogrammet/http-api";
import { Effect, Schema } from "effect";
import { readBoundedJson } from "../http-api/read-json.js";
import { HttpSemanticFailure } from "../http-semantics.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";

export const rejectQueryString = (request: Request) =>
  new URL(request.url).search === ""
    ? Effect.void
    : Effect.fail(new HttpSemanticFailure("validation.failed", 422));

const boundedJsonWithTag = (request: Request, maxBytes: number) =>
  readBoundedJson(request, maxBytes).pipe(
    Effect.mapError((cause) =>
      cause instanceof HttpSemanticFailure && cause.code === "request.too-large"
        ? new HttpSemanticFailure("request.too-large", 413)
        : new HttpSemanticFailure("validation.failed", 422),
    ),
  );

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
): Effect.Effect<S["Type"], HttpSemanticFailure> =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";

    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.failed", 422));
    }

    const body = yield* boundedJsonWithTag(request, maxBodyBytes);

    return yield* Schema.decodeUnknownEffect(schema)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));
  });

export const decodeAdmissionPeriodPatch = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";

    if (!/^application\/merge-patch\+json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }

    const body = yield* readBoundedJson(request, input.config.maxBodyBytes).pipe(
      Effect.mapError((cause) =>
        cause instanceof HttpSemanticFailure && cause.code === "request.too-large"
          ? new HttpSemanticFailure("request.too-large", 413)
          : new HttpSemanticFailure("request.malformed", 400),
      ),
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
