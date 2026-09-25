/** Content HTTP representations: strict output bodies, article ETags, and conditional JSON reads. */
import {
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
} from "@vektorprogrammet/database/content";
import type { ArticleId } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import type { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, Predicate, Schema, flow } from "effect";
import {
  HttpSemanticFailure,
  deriveStrongETag,
  evaluateReadPreconditions,
  nativeProblemResponse,
  notModifiedResponse,
  parseIfNoneMatch,
  parseReadIfMatch,
} from "../http-semantics.js";
import { headerValues } from "./http-decode.js";
import { knownContentFailure } from "./http-problem.js";

export const strictOutput = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

export const articleETagEffect = (articleId: ArticleId, personId: PersonId) =>
  Effect.gen(function* () {
    const [article, authority] = yield* Effect.all([
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(personId),
    ]);

    return deriveStrongETag({
      representationKind: "ContentArticleDetailSchema",
      resourceIdentity: `content-article:${articleId}`,
      version: [
        article.articleRevision,
        article.authorProfileRevision,
        authority.map((source) => [source.kind, source.identity, source.revisions]),
      ],
    });
  });

export const conditionalJsonResponse = (
  request: Request,
  body: Schema.Json,
  etag: StrongETag,
  cacheControl: string,
) =>
  Effect.try({
    try: () => {
      const decision = evaluateReadPreconditions({
        currentETag: etag,
        ifMatch: parseReadIfMatch(headerValues(request, "if-match")),
        ifNoneMatch: parseIfNoneMatch(headerValues(request, "if-none-match")),
      });

      if (Predicate.isTagged(decision, "Failed"))
        return nativeProblemResponse(decision.code, decision.status);

      if (Predicate.isTagged(decision, "NotModified")) {
        return notModifiedResponse({ etag, cacheControl, vary: "Origin" });
      }

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "cache-control": cacheControl,
          "content-type": "application/json",
          etag,
          vary: "Origin",
        },
      });
    },
    catch: knownContentFailure,
  });
