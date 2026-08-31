import {
  ArticleId,
  readPublicNews,
  runContentArticleDetail,
  runContentWorkspace,
  runPublicationTransition,
  ContentWorkspaceQuerySchema,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  ReviseArticleDraftInputSchema,
  UnpublishArticleInputSchema,
  type ContentWorkspaceQuery,
} from "@vektorprogrammet/domain/content";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { NativeApi } from "@vektorprogrammet/http-api";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import type { BackendRun } from "../router.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
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
      return jsonResponse({ error: { tag } }, 409);
    case "SlugConflict":
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
  return strictDecode(ContentWorkspaceQuerySchema, { departmentId: values[0] });
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

const readWorkspace = async (
  request: Request,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  const query = departmentFromQuery(request);
  const actor = await resolveActor(request);
  const workspace = await run(
    runContentWorkspace(actor.personId, actor.authorizationInstant, query),
  );
  return jsonResponse(workspace);
};

const createArticle = async (
  request: Request,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  const command = await decodeCreateBody(request);
  const actor = await resolveActor(request);
  const observation = await run(
    runPublicationTransition(actor.personId, actor.authorizationInstant, {
      _tag: "CreateDraft",
      command,
    }),
  );
  return jsonResponse(observation, 201, noStore);
};

const readArticle = async (
  request: Request,
  articleId: typeof ArticleId.Type,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  if ([...new URL(request.url).searchParams].length > 0) {
    throw new ContentHttpDecodeError("unexpected content detail query parameter");
  }
  const actor = await resolveActor(request);
  const detail = await run(
    runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
  );
  return jsonResponse(detail, 200, noStore);
};

const reviseArticle = async (
  request: Request,
  articleId: typeof ArticleId.Type,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  const command = await decodeReviseBody(request);
  if (command.articleId !== articleId) {
    throw new ContentHttpDecodeError("article body and path identifiers must match");
  }
  const actor = await resolveActor(request);
  const observation = await run(
    runPublicationTransition(actor.personId, actor.authorizationInstant, {
      _tag: "ReviseDraft",
      command,
    }),
  );
  return jsonResponse(observation, 200, noStore);
};

const publishArticle = async (
  request: Request,
  articleId: typeof ArticleId.Type,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  const command = await decodePublishBody(request);
  if (command.articleId !== articleId) {
    throw new ContentHttpDecodeError("article body and path identifiers must match");
  }
  const actor = await resolveActor(request);
  const observation = await run(
    runPublicationTransition(actor.personId, actor.authorizationInstant, {
      _tag: "Publish",
      command,
    }),
  );
  return jsonResponse(observation, 200, noStore);
};

const unpublishArticle = async (
  request: Request,
  articleId: typeof ArticleId.Type,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
): Promise<Response> => {
  const command = await decodeUnpublishBody(request);
  if (command.articleId !== articleId) {
    throw new ContentHttpDecodeError("article body and path identifiers must match");
  }
  const actor = await resolveActor(request);
  const observation = await run(
    runPublicationTransition(actor.personId, actor.authorizationInstant, {
      _tag: "Unpublish",
      command,
    }),
  );
  return jsonResponse(observation, 200, noStore);
};

const listNews = async (request: Request, run: BackendRun): Promise<Response> => {
  const query = departmentFromQuery(request);
  const listing = await run(readPublicNews({ _tag: "Listing", departmentId: query.departmentId }));
  return jsonResponse(listing, 200, noStore);
};

const readNewsArticle = async (
  request: Request,
  slug: string,
  run: BackendRun,
): Promise<Response> => {
  const versionNumber = versionFromQuery(request);
  const article = await run(readPublicNews({ _tag: "Article", slug, versionNumber }));
  return jsonResponse(article, 200, noStore);
};

/** Native HttpApi implementations for staff content and public news endpoints. */
export const ContentApiHandlers = (
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
) =>
  HttpApiBuilder.group(NativeApi, "content", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readContentWorkspace", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readWorkspace(webRequest, resolveActor, run),
            errorResponse,
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createArticle(webRequest, resolveActor, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readArticle(webRequest, params.articleId, resolveActor, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseArticle(webRequest, params.articleId, resolveActor, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => publishArticle(webRequest, params.articleId, resolveActor, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => unpublishArticle(webRequest, params.articleId, resolveActor, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("listNews", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listNews(webRequest, run),
            (cause) => errorResponse(cause, noStore),
          ),
        )
        .handleRaw("readNewsArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readNewsArticle(webRequest, params.slug, run),
            (cause) => errorResponse(cause, noStore),
          ),
        ),
    ),
  );
