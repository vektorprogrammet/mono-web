import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import {
  ContentArticleDetailSchema,
  ContentWorkspaceSchema,
} from "@vektorprogrammet/domain/content";
import { ExternalNativeApi } from "./api.js";
import { PersonSecurity, nativeOperationAnnotations } from "./common.js";
import {
  ContentArticleByIdResolver,
  ContentArticleCreateResolver,
  ContentArticlesResolver,
  ContentPublicNewsBySlugResolver,
  ContentPublicNewsResolver,
  contentAccessAnnotations,
} from "./content-effx-adapters.js";
import {
  ContentArticleParams,
  ContentDepartmentQuery,
  ContentNewsSlugParams,
  NewsVersionQuery,
  PublishedNewsArticleResponse,
  PublishedNewsListingResponse,
} from "./content.js";
import {
  ContentCreateArticleCodes,
  ContentListNewsCodes,
  ContentPublishArticleCodes,
  ContentReadArticleCodes,
  ContentReadContentWorkspaceCodes,
  ContentReadNewsArticleCodes,
  ContentReviseArticleCodes,
  ContentUnpublishArticleCodes,
  nativeProblems,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  CreatedMutationResponseHeaders,
  EntityMutationResponseHeaders,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  PrivateReadResponseHeaders,
  ProfileReadResponseHeaders,
  PublicConditionalResponseHeaders,
} from "./http-semantics.js";
import {
  ArticleMergePatch,
  CreateArticleRequest,
  PublishArticleRequest,
  PublishArticleResponse,
  UnpublishArticleRequest,
  UnpublishArticleResponse,
} from "./v2-schemas.js";

export const ContentGroup = Http.group({
  root: ExternalNativeApi,
  group: "content",
  title: "Content and news",
  description: "Native staff publication and public news operations.",
  defaults: {
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: contentAccessAnnotations,
      exposure: "External",
      concealment: Concealment.reveal,
    },
  },
});

export const ReadContentWorkspace = Operation.query({
  name: "content.readContentWorkspace",
  input: ContentDepartmentQuery,
  success: ContentWorkspaceSchema,
})
  .in(ContentGroup)
  .http.get("/api/content/articles")
  .http.contract({
    query: true,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read content workspace",
      description: "Returns article drafts visible to the current staff actor.",
    },
  })
  .http.problems({
    identifier: "ContentReadContentWorkspaceProblem",
    codes: ContentReadContentWorkspaceCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.read-workspace"),
    requirements: [],
    canonicalScopeResolver: ContentArticlesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const CreateArticle = Operation.command({
  name: "content.createArticle",
  input: CreateArticleRequest,
  success: ContentArticleDetailSchema,
})
  .in(ContentGroup)
  .http.post("/api/content/articles")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: CreateArticleRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Create article draft",
      description: "Creates or replays a native article draft command.",
    },
  })
  .http.problems({ identifier: "ContentCreateArticleProblem", codes: ContentCreateArticleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.create-article"),
    requirements: [],
    canonicalScopeResolver: ContentArticleCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadArticle = Operation.query({
  name: "content.readArticle",
  input: ContentArticleParams,
  success: ContentArticleDetailSchema,
})
  .in(ContentGroup)
  .http.get("/api/content/articles/:articleId")
  .http.contract({
    params: ContentArticleParams,
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read article detail",
      description: "Returns one staff article detail projection.",
    },
  })
  .http.problems({ identifier: "ContentReadArticleProblem", codes: ContentReadArticleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.read-article"),
    requirements: [],
    canonicalScopeResolver: ContentArticleByIdResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReviseArticle = Operation.command({
  name: "content.reviseArticle",
  input: ArticleMergePatch,
  success: ContentArticleDetailSchema,
})
  .in(ContentGroup)
  .http.patch("/api/content/articles/:articleId")
  .http.contract({
    params: ContentArticleParams,
    headers: IdempotencyIfMatchHeaders,
    payload: ArticleMergePatch,
    mediaType: "application/merge-patch+json",
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Revise article draft",
      description: "Revises a draft with optimistic revision control.",
    },
  })
  .http.problems({ identifier: "ContentReviseArticleProblem", codes: ContentReviseArticleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.revise-article"),
    requirements: [{ id: "content.revisable" }],
    canonicalScopeResolver: ContentArticleByIdResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const PublishArticle = Operation.command({
  name: "content.publishArticle",
  input: PublishArticleRequest,
  success: PublishArticleResponse,
})
  .in(ContentGroup)
  .http.post("/api/content/articles/:articleId:publish")
  .http.contract({
    params: ContentArticleParams,
    headers: IdempotencyIfMatchHeaders,
    payload: PublishArticleRequest,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Publish article",
      description: "Publishes a new immutable article version.",
    },
  })
  .http.problems({ identifier: "ContentPublishArticleProblem", codes: ContentPublishArticleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.publish-article"),
    requirements: [{ id: "content.publishable" }],
    canonicalScopeResolver: ContentArticleByIdResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const UnpublishArticle = Operation.command({
  name: "content.unpublishArticle",
  input: UnpublishArticleRequest,
  success: UnpublishArticleResponse,
})
  .in(ContentGroup)
  .http.post("/api/content/articles/:articleId:unpublish")
  .http.contract({
    params: ContentArticleParams,
    headers: IdempotencyIfMatchHeaders,
    payload: UnpublishArticleRequest,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Unpublish article",
      description: "Removes an article from the public current listing.",
    },
  })
  .http.problems({
    identifier: "ContentUnpublishArticleProblem",
    codes: ContentUnpublishArticleCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("content.publish-article"),
    requirements: [{ id: "content.unpublishable" }],
    canonicalScopeResolver: ContentArticleByIdResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ListNews = Operation.query({
  name: "content.listNews",
  input: ContentDepartmentQuery,
  success: PublishedNewsListingResponse,
})
  .in(ContentGroup)
  .http.get("/api/news")
  .http.contract({
    query: true,
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: PublicConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "List published news",
      description: "Returns the current public native news listing.",
    },
  })
  .http.problems({ identifier: "ContentListNewsProblem", codes: ContentListNewsCodes })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: ContentPublicNewsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadNewsArticle = Operation.query({
  name: "content.readNewsArticle",
  input: NewsVersionQuery,
  success: PublishedNewsArticleResponse,
})
  .in(ContentGroup)
  .http.get("/api/news/:slug")
  .http.contract({
    params: ContentNewsSlugParams,
    query: true,
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: PublicConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "Read published news article",
      description: "Returns the current or selected published version.",
    },
  })
  .http.problems({
    identifier: "ContentReadNewsArticleProblem",
    codes: ContentReadNewsArticleCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: ContentPublicNewsBySlugResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();
