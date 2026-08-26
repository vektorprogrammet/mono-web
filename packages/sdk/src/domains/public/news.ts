import { Effect } from "effect";
import type { InternalSdkError } from "../../errors.js";
import { ContentDecodeError } from "../../errors.js";
import {
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  type PublicNewsListInput,
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "../../schemas/content.js";
import type { Transport } from "../../transport.js";

const strictContent = {
  strict: true,
  decodeError: () => new ContentDecodeError(),
  errorFamily: "content",
} as const;

export interface PublicNewsDomain {
  /** One complete listing read; sticky-first ordering is server-owned. */
  readonly list: (
    input?: PublicNewsListInput,
  ) => Effect.Effect<PublishedNewsListing, InternalSdkError>;
  /** One detail read; an unknown or withdrawn slug/version surfaces NotFound. */
  readonly read: (
    slug: string,
    input?: { readonly version?: number },
  ) => Effect.Effect<PublishedNewsArticle, InternalSdkError>;
}

export const createPublicNewsDomain = (transport: Transport): PublicNewsDomain => ({
  list: (input = {}) =>
    transport.get(
      "/api/news",
      PublishedNewsListingSchema,
      input.department === undefined ? undefined : { department: input.department },
      strictContent,
    ),
  read: (slug, input = {}) =>
    transport.get(
      `/api/news/${encodeURIComponent(slug)}`,
      PublishedNewsArticleSchema,
      input.version === undefined ? undefined : { version: input.version },
      strictContent,
    ),
});
