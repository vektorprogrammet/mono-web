/** Admission request decoding: JSON bodies and admission period merge patches. */
import { AdmissionPeriodMergePatch } from "@vektorprogrammet/http-api";
import {
  makeNativeValidationError,
  type NativeValidationError,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Match, Predicate, Schema, type SchemaIssue } from "effect";
import { readJsonBody, semanticProblem } from "../http-api/problem.js";
import { interpretAdmissionPeriodMergePatchSource } from "../http-semantics.js";

const pointerOf = (path: ReadonlyArray<PropertyKey>) =>
  path.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** Every member a schema rejected, named by its RFC 6901 pointer and never by its value. */
const rejectedMembers = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
): ReadonlyArray<NativeValidationError> =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (nested) => rejectedMembers(nested.issue, [...path, ...nested.path])),
    Match.tag("Filter", "Encoding", (nested) => rejectedMembers(nested.issue, path)),
    Match.tag("Composite", (nested) =>
      nested.issues.flatMap((member) => rejectedMembers(member, path)),
    ),
    Match.tag("MissingKey", () => [makeNativeValidationError(pointerOf(path), "missing")]),
    Match.tag("UnexpectedKey", () => [makeNativeValidationError(pointerOf(path), "unknown")]),
    Match.orElse(() => [makeNativeValidationError(pointerOf(path), "invalid")]),
  );

/**
 * Decodes one body exactly; a rejection names each rejected member once.
 *
 * @construct http-problem
 */
const decodeBody = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  body: Schema.Json,
) =>
  Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError((error) => {
      const members = new Map(
        rejectedMembers(error.issue).map((member) => [`${member.code} ${member.pointer}`, member]),
      );

      return Problem.validation("validation.failed", [...members.values()]);
    }),
  );

/**
 * Reads and decodes one bounded JSON body.
 *
 * @construct http-problem
 */
export const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, maxBodyBytes);

    return yield* decodeBody(schema, body);
  });

/**
 * Reads and decodes one bounded admission period merge patch.
 *
 * @construct http-problem
 */
export const decodeAdmissionPeriodPatch = (request: Request, maxBodyBytes: number) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(
      request,
      /^application\/merge-patch\+json(?:\s*;|$)/iu,
      maxBodyBytes,
    );

    // Unknown, absent, and deleted members are judged before the values are decoded.
    const interpretation = yield* semanticProblem(
      () => interpretAdmissionPeriodMergePatchSource(body),
      ["request.malformed"],
    );

    if (Predicate.isTagged(interpretation, "Rejected")) {
      return yield* Problem.validation(interpretation.code, interpretation.errors);
    }

    return yield* decodeBody(AdmissionPeriodMergePatch, body);
  });
