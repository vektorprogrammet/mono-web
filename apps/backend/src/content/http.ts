import {
  ArticleSlug,
  ContentCommandId,
  ContentWorkspaceQuerySchema,
  CreateArticleDraftInputSchema,
  ReviseArticleDraftInputSchema,
  type ContentWorkspaceQuery,
} from "@vektorprogrammet/domain/content";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

export interface ContentApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** Strict decode of one command body; unknown properties fail with 422. */
const decodeCreateBody = async (
  request: Request,
): Promise<typeof CreateArticleDraftInputSchema.Type> => {
  const body = await decodeJsonBody(request);
  return decodeStrict(CreateArticleDraftInputSchema, body);
};

const decodeReviseBody = async (
  request: Request,
): Promise<typeof ReviseArticleDraftInputSchema.Type> => {
  const body = await decodeJsonBody(request);
  return decodeStrict(ReviseArticleDraftInputSchema, body);
};

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

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof ContentHttpDecodeError) {
    return jsonResponse({ error: { tag: cause._tag } }, cause.status);
  }
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "ContentPersistenceError";
  switch (tag) {
    case "UnauthenticatedActor":
      return jsonResponse({ error: { tag } }, 401);
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return jsonResponse({ error: { tag } }, 403);
    case "ArticleNotFound":
      return jsonResponse({ error: { tag } }, 404, noStore);
    case "CommandConflict":
    case "SlugConflict":
      return jsonResponse({ error: { tag } }, 409);
    case "ContentDecodeError":
    case "DepartmentNotFound":
      return jsonResponse({ error: { tag } }, 422);
    case "ContentIntegrityError":
    case "ContentPersistenceError":
      return jsonResponse({ error: { tag } }, 503);
    default:
      return jsonResponse({ error: { tag: "ContentPersistenceError" } }, 503);
  }
};

const decodeStrict = <A>(schema: Schema.ConstraintDecoder<A, never>, input: unknown): A =>
  Schema.decodeUnknownSync(schema as never)(input, { onExcessProperty: "error" }) as A;

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
  return Schema.decodeUnknownSync(ContentWorkspaceQuerySchema)(
    { department: values[0] },
    { onExcessProperty: "error" },
  );
};

const ContentCommandBodySchema = Schema.Struct({ commandId: ContentCommandId });

const commandIdFromBody = async (request: Request): Promise<ContentCommandId> => {
  const body = await decodeJsonBody(request);
  const decoded = await decodeStrict(ContentCommandBodySchema, body);
  return decoded.commandId;
};

const articleIdFromPath = (pathname: string, pattern: RegExp): number => {
  const match = pattern.exec(pathname);
  if (match === null || match[1] === undefined) {
    throw new ContentHttpDecodeError("article path parameter missing");
  }
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ContentHttpDecodeError("article path parameter must be a positive integer");
  }
  return parsed;
};

const slugFromPath = (pathname: string): string => {
  const match = /^\/api\/news\/([^/]+)$/.exec(pathname);
  if (match === null || match[1] === undefined) {
    throw new ContentHttpDecodeError("slug path parameter missing");
  }
  return decodeURIComponent(match[1]);
};

const contextOf = (actor: ContentRequestActor) => ({
  personId: actor.personId,
  authorizationInstant: actor.authorizationInstant,
});

/**
 * Native ContentManagement adapter (spec 0062 §HTTP boundaries). It owns
 * transport only: strict decoding, one actor resolution per request, journey
 * invocation, and the frozen status mapping. No SQL, no Layer construction.
 */
export interface ContentManagementJourney {
  readonly readWorkspace: (
    context: {
      readonly personId: PersonId;
      readonly authorizationInstant: OrganizationAuthorityInstant;
    },
    query: ContentWorkspaceQuery,
  ) => Promise<unknown>;
  readonly createDraft: (
    command: typeof CreateArticleDraftInputSchema.Type,
    context: {
      readonly personId: PersonId;
      readonly authorizationInstant: OrganizationAuthorityInstant;
    },
  ) => Promise<unknown>;
  readonly reviseDraft: (
    command: Record<string, unknown>,
    context: {
      readonly personId: PersonId;
      readonly authorizationInstant: OrganizationAuthorityInstant;
    },
  ) => Promise<unknown>;
  readonly publish: (
    command: { readonly commandId: ContentCommandId; readonly articleId: number },
    context: {
      readonly personId: PersonId;
      readonly authorizationInstant: OrganizationAuthorityInstant;
    },
  ) => Promise<unknown>;
  readonly unpublish: (
    command: { readonly commandId: ContentCommandId; readonly articleId: number },
    context: {
      readonly personId: PersonId;
      readonly authorizationInstant: OrganizationAuthorityInstant;
    },
  ) => Promise<unknown>;
}

export const makeContentManagementApiHttp = (
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  runManagement: <A>(use: (management: ContentManagementJourney) => Promise<A>) => Promise<A>,
): ContentApiHttp => ({
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === "/api/admin/content/workspace") {
        const query = departmentFromQuery(request);
        const actor = await resolveActor(request);
        try {
          const workspace = await runManagement((management) =>
            management.readWorkspace(contextOf(actor), query),
          );
          return jsonResponse(workspace);
        } catch (cause) {
          process.stderr.write(
            `[content-workspace-debug] ${String((cause as Error)?.stack ?? cause)}\n`,
          );
          throw cause;
        }
      }
      if (request.method === "POST" && pathname === "/api/admin/content/drafts") {
        const command = await decodeCreateBody(request);
        const actor = await resolveActor(request);
        const observation = await runManagement((management) =>
          management.createDraft(command, contextOf(actor)),
        );
        return jsonResponse(observation, 201, noStore);
      }
      const reviseMatch = /^\/api\/admin\/content\/drafts\/(\d+)$/.exec(pathname);
      if (request.method === "PATCH" && reviseMatch !== null) {
        const articleId = articleIdFromPath(pathname, /^\/api\/admin\/content\/drafts\/(\d+)$/);
        const command = await decodeReviseBody(request);
        const actor = await resolveActor(request);
        const observation = await runManagement((management) =>
          management.reviseDraft({ ...command, articleId }, contextOf(actor)),
        );
        return jsonResponse(observation, 200, noStore);
      }
      const publishMatch = /^\/api\/admin\/content\/drafts\/(\d+)\/publish$/.exec(pathname);
      if (request.method === "POST" && publishMatch !== null) {
        const articleId = articleIdFromPath(
          pathname,
          /^\/api\/admin\/content\/drafts\/(\d+)\/publish$/,
        );
        const commandId = await commandIdFromBody(request);
        const actor = await resolveActor(request);
        const observation = await runManagement((management) =>
          management.publish({ commandId, articleId }, contextOf(actor)),
        );
        return jsonResponse(observation, 200, noStore);
      }
      const unpublishMatch = /^\/api\/admin\/content\/drafts\/(\d+)\/unpublish$/.exec(pathname);
      if (request.method === "POST" && unpublishMatch !== null) {
        const articleId = articleIdFromPath(
          pathname,
          /^\/api\/admin\/content\/drafts\/(\d+)\/unpublish$/,
        );
        const commandId = await commandIdFromBody(request);
        const actor = await resolveActor(request);
        const observation = await runManagement((management) =>
          management.unpublish({ commandId, articleId }, contextOf(actor)),
        );
        return jsonResponse(observation, 200, noStore);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

/**
 * Public news adapter: unauthenticated reads with no-store semantics. A slug
 * miss is the same typed ArticleNotFound as any staff unknown-article 404.
 */
export interface PublicNewsJourney {
  readonly readNewsListing: () => Promise<unknown>;
  readonly readPublishedArticle: (slug: string) => Promise<unknown>;
}

export const makePublicNewsApiHttp = (
  runNews: <A>(use: (news: PublicNewsJourney) => Promise<A>) => Promise<A>,
): ContentApiHttp => ({
  fetch: async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/news") {
        departmentFromQuery(request);
        const listing = await runNews((news) => news.readNewsListing());
        return jsonResponse(listing, 200, noStore);
      }
      const detailMatch = /^\/api\/news\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch !== null) {
        const slug = ArticleSlug.make(slugFromPath(url.pathname));
        const article = await runNews((news) => news.readPublishedArticle(slug as string));
        return jsonResponse(article, 200, noStore);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404, noStore);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});
