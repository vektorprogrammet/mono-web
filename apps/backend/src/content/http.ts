import {
  ArticleId,
  ContentCommandId,
  ContentWorkspaceQuerySchema,
  CreateArticleDraftInputSchema,
  ReviseArticleDraftInputSchema,
  type ContentWorkspaceQuery,
} from "@vektorprogrammet/domain/content";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import {
  createDraftPostgres,
  publishPostgres,
  readWorkspacePostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "@vektorprogrammet/domain/content";
import { Schema } from "effect";
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

const errorResponse = (cause: unknown, extraHeaders: Record<string, string> = {}): Response => {
  if (cause instanceof ContentHttpDecodeError) {
    return jsonResponse({ error: { tag: cause._tag } }, cause.status);
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
      return jsonResponse({ error: { tag } }, 503);
    default:
      return jsonResponse({ error: { tag: "ContentPersistenceError" } }, 503);
  }
};

const strictDecode = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  input: unknown,
): A => Schema.decodeUnknownSync(schema as never)(input, { onExcessProperty: "error" }) as A;

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

const decodeCreateBody = async (
  request: Request,
): Promise<typeof CreateArticleDraftInputSchema.Type> => {
  const body = await decodeJsonBody(request);
  return strictDecode(CreateArticleDraftInputSchema, body);
};

const ContentCommandBodySchema = Schema.Struct({ commandId: ContentCommandId });

const commandIdFromBody = async (request: Request): Promise<ContentCommandId> => {
  const body = await decodeJsonBody(request);
  const decoded = strictDecode(ContentCommandBodySchema, body);
  return decoded.commandId;
};

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
          readWorkspacePostgres({ ...contextOf(actor), query }),
        );
        return jsonResponse(workspace);
      }
      if (request.method === "POST" && pathname === "/api/admin/content/drafts") {
        const command = await decodeCreateBody(request);
        const actor = await resolveActor(request);
        const observation = await run(
          createDraftPostgres({ command, ...contextOf(actor) }),
        );
        return jsonResponse(observation, 201, noStore);
      }
      if (request.method === "POST" && pathname === "/api/admin/content") {
        const body = await decodeJsonBody(request);
        const operation =
          typeof (body as { operation?: unknown }).operation === "string"
            ? String((body as { operation?: unknown }).operation)
            : "createDraft";
        const { operation: _op, ...payload } = body as Record<string, unknown>;
        const actor = await resolveActor(request);
        let observation: unknown;
        if (operation === "publish") {
          observation = await run(
            publishPostgres({
              command: {
                commandId: ContentCommandId.make(payload.commandId as string),
                articleId: ArticleId.make(Number(payload.articleId)),
              },
              ...contextOf(actor),
            }),
          );
        } else if (operation === "unpublish") {
          observation = await run(
            unpublishPostgres({
              command: {
                commandId: ContentCommandId.make(payload.commandId as string),
                articleId: ArticleId.make(Number(payload.articleId)),
              },
              ...contextOf(actor),
            }),
          );
        } else if (operation === "reviseDraft") {
          observation = await run(
            reviseDraftPostgres({
              command: {
                commandId: ContentCommandId.make(payload.commandId as string),
                articleId: ArticleId.make(Number(payload.articleId)),
                expectedRevision: Number(payload.expectedRevision),
                title: payload.title as string,
                bodyHtml: payload.bodyHtml as string,
                departmentIds: payload.departmentIds as never,
                sticky: Boolean(payload.sticky),
              },
              ...contextOf(actor),
            }),
          );
        } else {
          observation = await run(
            createDraftPostgres({
              command: strictDecode(CreateArticleDraftInputSchema, {
                commandId: payload.commandId,
                title: payload.title,
                bodyHtml: payload.bodyHtml,
                departmentIds: payload.departmentIds,
                sticky: payload.sticky,
              }),
              ...contextOf(actor),
            }),
          );
        }
        return jsonResponse(observation, 201, noStore);
      }
      const reviseMatch = /^\/api\/admin\/content\/drafts\/(\d+)$/.exec(pathname);
      if (request.method === "PATCH" && reviseMatch !== null) {
        const articleId = articleIdFromPath(pathname, /^\/api\/admin\/content\/drafts\/(\d+)$/);
        const command = await decodeReviseBody(request);
        const actor = await resolveActor(request);
        const observation = await run(
          reviseDraftPostgres({ command: { ...command, articleId }, ...contextOf(actor) }),
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
        const observation = await run(
          publishPostgres({
            command: { commandId, articleId },
            ...contextOf(actor),
          }),
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
        const observation = await run(
          unpublishPostgres({
            command: { commandId, articleId },
            ...contextOf(actor),
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
export const makePublicNewsApiHttp = (
  readNewsListing: () => Promise<unknown>,
  readPublishedArticle: (slug: string) => Promise<unknown>,
): ContentApiHttp => ({
  fetch: async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/news") {
        departmentFromQuery(request);
        const listing = await readNewsListing();
        return jsonResponse(listing, 200, noStore);
      }
      const detailMatch = /^\/api\/news\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch !== null) {
        const slug = slugFromPath(url.pathname);
        try {
          const article = await readPublishedArticle(slug);
          return jsonResponse(article, 200, noStore);
        } catch (cause) {
          return errorResponse(cause, noStore);
        }
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404, noStore);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});
