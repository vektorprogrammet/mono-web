import { Context, Effect } from "effect";
import type {
  ContentIntegrityError,
  ContentDecodeError,
  ContentArticleNotFound,
} from "./errors.js";
import type {
  PublishedNewsArticle,
  PublishedNewsListing,
} from "./schema.js";

export interface ContentShape {
  readonly readNewsListing: () => Effect.Effect<
    PublishedNewsListing,
    ContentDecodeError | ContentIntegrityError
  >;
  readonly readPublishedArticle: (slug: string) => Effect.Effect<
    PublishedNewsArticle,
    ContentDecodeError | ContentIntegrityError | ContentArticleNotFound
  >;
}

export class Content extends Context.Service<Content, ContentShape>()(
  "@vektorprogrammet/domain/Content",
) {}
