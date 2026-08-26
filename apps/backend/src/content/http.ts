import {
  ArticleId,
  Content,
  ContentManagement,
  ContentWorkspaceQuerySchema,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  ReviseArticleDraftInputSchema,
  UnpublishArticleInputSchema,
  type ContentWorkspaceQuery,
} from "@vektorprogrammet/domain/content";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import type { BackendRun } from "../router.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

export interface ContentApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
}

class ContentHttpDecodeError extends Error {
  readonly _tag = "ContentDecodeError";
  readonly status = 422;
}

const jsonResponse = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });

const noStore = { "cache-control": "no-store" };

const reportServerFailure = (tag: string, cause: unknown): void => {
  const operation =
    typeof cause === "object" &&
    cause !== null &&
    "operation" in cause &&
    typeof cause.operation === "string"
      ? cause.operation
      : "content request";
  const message =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : String(cause);
  process.stderr.write(`${tag} in ${operation}: ${message}\n`);
};

const errorResponse = (cause: unknown, extraHeaders: Record<string, string> = {}): Response => {
  if (cause instanceof ContentHttpDecodeError) {
    return jsonResponse({ error: { tag: cause._tag } }, cause.status, extraHeaders);
  }
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "ContentPersistenceError";
  switch (tag) {
    case "UnauthenticatedActor":
      return jsonResponse({ error: { tag } }, 401, extraHeaders);
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return jsonResponse({ error: { tag } }, 403, extraHeaders);
    case "ArticleNotFound":
      return jsonResponse({ error: { tag } }, 404, extraHeaders);
    case "CommandConflict":
    case "SlugConflict":
      return jsonResponse({ error: { tag } }, 409);
    case "ContentDecodeError":
    case "DepartmentNotFound":
      return jsonResponse({ error: { tag } }, 422);
    case "ContentIntegrityError":
    case "ContentPersistenceError":
      reportServerFailure(tag, cause);
      return jsonResponse({ error: { tag } }, 503);
    default:
      reportServerFailure("ContentPersistenceError", cause);
      return jsonResponse({ error: { tag: "ContentPersistenceError" } }, 503);
  }
};

const strictDecode = <A>(schema: Schema.ConstraintDecoder<A, never>, input: unknown): A => {
  try {
    return Schema.decodeUnknownSync(schema as never)(input, {
      onExcessProperty: "error",
    }) as A;
  } catch {
    throw new ContentHttpDecodeError("request input did not match the content schema");
  }
};

const decodeJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new ContentHttpDecodeError("request body is not valid JSON");
  }
};

const departmentFromQuery = (request: Request): ContentWorkspaceQuery => {
  const parameters = [...new URL(request.url).searchParams];
  if (parameters.some(([key]) => key !== "department")) {
    throw new ContentHttpDecodeError("unexpected content query parameter");
  }
  const values = parameters.filter(([key]) => key === "department").map(([, value]) => value);
  if (values.length > 1) throw new ContentHttpDecodeError("duplicate department parameter");
  const emptyQuery: ContentWorkspaceQuery = {};
  if (values.length === 0) return emptyQuery;
  return strictDecode(ContentWorkspaceQuerySchema, { department: values[0] });
};

const decodeCreateBody = async (
  request: Request,
): Promise<typeof CreateArticleDraftInputSchema.Type> => {
  const body = await decodeJsonBody(request);
  return strictDecode(CreateArticleDraftInputSchema, body);
};

const decodePublishBody = async (
  request: Request,
): Promise<typeof PublishArticleInputSchema.Type> =>
  strictDecode(PublishArticleInputSchema, await decodeJsonBody(request));

const decodeUnpublishBody = async (
  request: Request,
): Promise<typeof UnpublishArticleInputSchema.Type> =>
  strictDecode(UnpublishArticleInputSchema, await decodeJsonBody(request));

const articleIdFromPath = (pathname: string, pattern: RegExp): ArticleId => {
  const match = pattern.exec(pathname);
  if (match === null || match[1] === undefined) {
    throw new ContentHttpDecodeError("article path parameter missing");
  }
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ContentHttpDecodeError("article path parameter must be a positive integer");
  }
  return ArticleId.make(parsed);
};

const slugFromPath = (pathname: string): string => {
  const match = /^\/api\/news\/([^/]+)$/.exec(pathname);
  if (match === null || match[1] === undefined) {
    throw new ContentHttpDecodeError("slug path parameter missing");
  }
  return decodeURIComponent(match[1]);
};

const versionFromQuery = (request: Request): number | undefined => {
  const parameters = [...new URL(request.url).searchParams];
  if (parameters.some(([key]) => key !== "version")) {
    throw new ContentHttpDecodeError("unexpected news detail query parameter");
  }
  const values = parameters.filter(([key]) => key === "version").map(([, value]) => value);
  if (values.length > 1) throw new ContentHttpDecodeError("duplicate version parameter");
  if (values.length === 0) return undefined;
  const version = Number(values[0]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new ContentHttpDecodeError("version must be a positive integer");
  }
  return version;
};

const decodeReviseBody = async (
  request: Request,
): Promise<typeof ReviseArticleDraftInputSchema.Type> => {
  const body = await decodeJsonBody(request);
  return strictDecode(ReviseArticleDraftInputSchema, body);
};

const contextOf = (actor: ContentRequestActor) => ({
  personId: actor.personId,
  authorizationInstant: actor.authorizationInstant,
});

/**
 * Native ContentManagement adapter (spec 0062 §HTTP boundaries). It owns
 * transport only: strict decoding, one actor resolution per request, journey
 * invocation through `run` exactly like the schools adapter. No SQL, no Layer
 * construction.
 */
export const makeContentManagementApiHttp = (
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): ContentApiHttp => ({
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === "/api/admin/content/workspace") {
        const query = departmentFromQuery(request);
        const actor = await resolveActor(request);
        const workspace = await run(
          Effect.gen(function* () {
            const content = yield* ContentManagement;
            return yield* content.readWorkspace(contextOf(actor), query);
          }),
        );
        return jsonResponse(workspace);
      }
      if (request.method === "POST" && pathname === "/api/admin/content/drafts") {
        const command = await decodeCreateBody(request);
        const actor = await resolveActor(request);
        const observation = await run(
          Effect.gen(function* () {
            const content = yield* ContentManagement;
            return yield* content.createDraft(command, contextOf(actor));
          }),
        );
        return jsonResponse(observation, 201, noStore);
      }
      const reviseMatch = /^\/api\/admin\/content\/articles\/(\d+)$/.exec(pathname);
      if (request.method === "PUT" && reviseMatch !== null) {
        const articleId = articleIdFromPath(pathname, /^\/api\/admin\/content\/articles\/(\d+)$/);
        const command = await decodeReviseBody(request);
        if (command.articleId !== articleId) {
          throw new ContentHttpDecodeError("article body and path identifiers must match");
        }
        const actor = await resolveActor(request);
        const observation = await run(
          Effect.gen(function* () {
            const content = yield* ContentManagement;
            return yield* content.reviseDraft(command, contextOf(actor));
          }),
        );
        return jsonResponse(observation, 200, noStore);
      }
      const publishMatch = /^\/api\/admin\/content\/articles\/(\d+)\/publish$/.exec(pathname);
      if (request.method === "POST" && publishMatch !== null) {
        const articleId = articleIdFromPath(
          pathname,
          /^\/api\/admin\/content\/articles\/(\d+)\/publish$/,
        );
        const command = await decodePublishBody(request);
        if (command.articleId !== articleId) {
          throw new ContentHttpDecodeError("article body and path identifiers must match");
        }
        const actor = await resolveActor(request);
        const observation = await run(
          Effect.gen(function* () {
            const content = yield* ContentManagement;
            return yield* content.publish(command, contextOf(actor));
          }),
        );
        return jsonResponse(observation, 200, noStore);
      }
      const unpublishMatch = /^\/api\/admin\/content\/articles\/(\d+)\/unpublish$/.exec(pathname);
      if (request.method === "POST" && unpublishMatch !== null) {
        const articleId = articleIdFromPath(
          pathname,
          /^\/api\/admin\/content\/articles\/(\d+)\/unpublish$/,
        );
        const command = await decodeUnpublishBody(request);
        if (command.articleId !== articleId) {
          throw new ContentHttpDecodeError("article body and path identifiers must match");
        }
        const actor = await resolveActor(request);
        const observation = await run(
          Effect.gen(function* () {
            const content = yield* ContentManagement;
            return yield* content.unpublish(command, contextOf(actor));
          }),
        );
        return jsonResponse(observation, 200, noStore);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

/** Public news adapter: unauthenticated reads with no-store semantics. */
export const makePublicNewsApiHttp = (run: BackendRun): ContentApiHttp => ({
  fetch: async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/news") {
        departmentFromQuery(request);
        const listing = await run(
          Effect.gen(function* () {
            const content = yield* Content;
            return yield* content.readNewsListing();
          }),
        );
        return jsonResponse(listing, 200, noStore);
      }
      const detailMatch = /^\/api\/news\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch !== null) {
        const slug = slugFromPath(url.pathname);
        try {
          const versionNumber = versionFromQuery(request);
          const article = await run(
            Effect.gen(function* () {
              const content = yield* Content;
              return yield* content.readPublishedArticle(slug, versionNumber);
            }),
          );
          return jsonResponse(article, 200, noStore);
        } catch (cause) {
          return errorResponse(cause, noStore);
        }
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404, noStore);
    } catch (cause) {
      return errorResponse(cause, noStore);
    }
  },
});
