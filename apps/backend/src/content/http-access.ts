/** Request-local Content access frame and article scope facts. */
import {
  AuthorityVersion,
  DomainId,
  ResourceId,
  ResourceKind,
  type CanonicalScopeResolution,
} from "@vektorprogrammet/domain/authz";
import type { ContentArticleDetail } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { Context, type Schema } from "effect";
import type {
  AuthorizedContentActor,
  TransactionalAuthorizedContentActor,
} from "./http-context.js";

/** The original decision point owns this request-local authorization snapshot. */
export type ContentAccessFrame =
  | {
      readonly kind: "StaffRead";
      readonly operation: "content.readContentWorkspace" | "content.readArticle";
      readonly request: Request;
      readonly actor: AuthorizedContentActor;
      readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
    }
  | {
      readonly kind: "StaffCommand";
      readonly operation:
        | "content.createArticle"
        | "content.reviseArticle"
        | "content.publishArticle"
        | "content.unpublishArticle";
      readonly request: Request;
      readonly actor: TransactionalAuthorizedContentActor;
      readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
    }
  | {
      readonly kind: "Public";
      readonly operation: "content.listNews" | "content.readNewsArticle";
      readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
      readonly now: string;
    };

export const CurrentContentAccess = Context.Reference<ContentAccessFrame | undefined>(
  "@vektorprogrammet/backend/content/current-access",
  { defaultValue: () => undefined },
);

export const articleContext = (
  detail: ContentArticleDetail,
  createdByPersonId: PersonId,
  authorityVersion: string,
) => ({
  domainId: DomainId.make("content"),
  departmentId: detail.departmentIds[0] ?? null,
  resource: {
    kind: ResourceKind.make("content-article"),
    id: ResourceId.make(String(detail.articleId)),
  },
  facts: {
    state: detail.status,
    ownerPersonId: createdByPersonId,
    revisable: detail.canRevise,
    publishable: detail.canPublish,
    unpublishable: detail.status === "Published",
  },
  authorityVersion: AuthorityVersion.make(authorityVersion),
});
