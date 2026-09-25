/** Content HTTP representations: the article entity tag. */
import {
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
} from "@vektorprogrammet/database/content";
import type { ArticleId } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import { deriveStrongETag } from "../http-semantics.js";

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
