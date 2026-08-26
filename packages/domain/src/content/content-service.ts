import { Context, Effect } from "effect";
import type { ContentDecodeError, ContentIntegrityError } from "./errors.js";
import type { PublishedNewsArticle, PublishedNewsListing } from "./schema.js";

/** Typed not-found carries no draft-existence information (law 5). */
export interface ArticleNotFound {
  readonly _tag: "ArticleNotFound";
}

export interface ContentShape {
  /**
   * One complete listing snapshot, sticky-first then publishedAt DESC then
   * slug DESC; pagination is a pure caller-side slice (law 10).
   */
  readonly readNewsListing: () => Effect.Effect<
    PublishedNewsListing,
    ContentDecodeError | ContentIntegrityError
  >;
  /**
   * Resolves one currently-published article by canonical slug with its
   * descending previous-version references.
   */
  readonly readPublishedArticle: (
    slug: string,
    versionNumber?: number,
  ) => Effect.Effect<
    PublishedNewsArticle,
    ContentDecodeError | ContentIntegrityError | ArticleNotFound
  >;
}

export class Content extends Context.Service<Content, ContentShape>()(
  "@vektorprogrammet/domain/Content",
) {}
