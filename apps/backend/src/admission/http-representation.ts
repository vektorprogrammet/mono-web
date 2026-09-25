/** Admission HTTP representations: conditional JSON responses and public cache lifetimes. */
import { Effect, Predicate } from "effect";
import {
  type ETagVersionSource,
  deriveStrongETag,
  evaluateReadPreconditions,
  nativeProblemResponse,
  notModifiedResponse,
  parseIfNoneMatch,
  parseReadIfMatch,
} from "../http-semantics.js";
import { knownAdmissionFailure } from "./http-problem.js";

export const conditionalJsonResponse = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly representationKind: string;
  readonly version: ETagVersionSource;
  readonly cacheControl: string;
}) =>
  Effect.try({
    try: () => {
      const etag = deriveStrongETag({
        representationKind: input.representationKind,
        resourceIdentity: "collection",
        version: input.version,
      });

      const decision = evaluateReadPreconditions({
        currentETag: etag,
        ifMatch: parseReadIfMatch(
          input.request.headers.get("if-match") === null
            ? []
            : [input.request.headers.get("if-match")!],
        ),
        ifNoneMatch: parseIfNoneMatch(
          input.request.headers.get("if-none-match") === null
            ? []
            : [input.request.headers.get("if-none-match")!],
        ),
      });

      if (Predicate.isTagged(decision, "Failed")) {
        return nativeProblemResponse(decision.code, decision.status);
      }

      if (Predicate.isTagged(decision, "NotModified")) {
        return notModifiedResponse({
          etag,
          cacheControl: input.cacheControl,
          vary: "Origin",
        });
      }

      return new Response(JSON.stringify(input.body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": input.cacheControl,
          etag,
          vary: "Origin",
        },
      });
    },
    catch: knownAdmissionFailure,
  });

export const dynamicAdmissionCache = (now: string, boundaries: ReadonlyArray<string>): string => {
  const nowMillis = Date.parse(now);

  const next = boundaries
    .values()
    .map(Date.parse)
    .filter((boundary) => Number.isFinite(boundary) && boundary >= nowMillis)
    .toArray()
    .sort((left, right) => left - right)[0];

  const ttl =
    next === undefined ? 30 : Math.max(0, Math.min(30, Math.floor((next - nowMillis) / 1_000)));

  return `public, max-age=${ttl}, s-maxage=${ttl}, must-revalidate`;
};
