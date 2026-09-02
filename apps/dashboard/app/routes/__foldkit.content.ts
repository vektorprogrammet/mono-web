import { ArticleId } from "@vektorprogrammet/domain/content";
import { ArticleMergePatch, CreateArticleRequest, IdempotencyKey, StrongETag } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { data } from "react-router";
import {
  contentBridgeFailure,
  type ContentBridgeErrorTag,
} from "../foldkit/content/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.content";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const ContentBridgeActionSchema = S.Union([
  S.Struct({ operation: S.Literals(["readArticle"]), articleId: ArticleId }),
  S.Struct({
    operation: S.Literals(["createDraft"]),
    commandId: IdempotencyKey,
    ...CreateArticleRequest.fields,
  }),
  S.Struct({
    operation: S.Literals(["reviseDraft"]),
    commandId: IdempotencyKey,
    articleId: ArticleId,
    etag: StrongETag,
    ...ArticleMergePatch.fields,
  }),
  S.Struct({
    operation: S.Literals(["publish", "unpublish"]),
    commandId: IdempotencyKey,
    articleId: ArticleId,
  }),
]);

const statusFor = (tag: ContentBridgeErrorTag): number => {
  switch (tag) {
    case "UnauthenticatedActor":
      return 401;
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return 403;
    case "ArticleNotFound":
      return 404;
    case "SlugConflict":
    case "DepartmentNotFound":
    case "ContentDecodeError":
      return 422;
    case "CommandConflict":
      return 409;
    case "Network":
      return 502;
    case "ContentIntegrityError":
    case "ContentPersistenceError":
    case "Configuration":
      return 503;
  }
};

const tagFrom = (error: unknown): ContentBridgeErrorTag => {
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "credential.missing" || code === "credential.invalid") {
    return "UnauthenticatedActor";
  }
  if (code === "authority.denied" || code === "scope.not-found") return "NotInScope";
  if (code === "resource.not-found") return "ArticleNotFound";
  if (code.includes("slug")) return "SlugConflict";
  if (code.includes("department")) return "DepartmentNotFound";
  if (code.startsWith("precondition.") || code.startsWith("idempotency.")) {
    return "CommandConflict";
  }
  if (code.startsWith("validation.") || code === "request.malformed") {
    return "ContentDecodeError";
  }
  if (code === "dependency.unavailable") return "Network";
  return "ContentPersistenceError";
};

const articleObservation = <A extends { readonly body: unknown; readonly headers: { readonly ETag: StrongETag } }>(
  result: A,
) => {
  if (result.body === undefined) throw new Error("Content response did not include a body");
  return { body: result.body, etag: result.headers.ETag };
};

export async function loader({ request }: Route.LoaderArgs) {
  let cookie: string;
  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);
    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  try {
    const client = createAuthenticatedClient(cookie, request);
    const [workspaceResult, departmentsResult] = await Promise.all([
      client.content.readContentWorkspace({ query: {} }),
      client.organization.listDepartments({ headers: {} }),
    ]);
    if (workspaceResult.body === undefined || departmentsResult.body === undefined) {
      throw new Error("Content workspace response did not include a body");
    }
    return data(
      {
        workspace: workspaceResult.body,
        knownDepartments: departmentsResult.body
          .filter((department) => department.active)
          .map(({ departmentId, name }) => ({ departmentId, name })),
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    const tag = tagFrom(error);
    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;
  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);
    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  let command: typeof ContentBridgeActionSchema.Type;
  try {
    command = S.decodeUnknownSync(ContentBridgeActionSchema)(
      await request.json().catch(() => null),
      { onExcessProperty: "error" },
    );
  } catch {
    return data(contentBridgeFailure("ContentDecodeError"), {
      status: 422,
      headers: responseHeaders,
    });
  }

  try {
    const client = createAuthenticatedClient(cookie, request);
    switch (command.operation) {
      case "readArticle":
        return data(
          articleObservation(
            await client.content.readArticle({
              params: { articleId: command.articleId },
              headers: {},
            }),
          ),
          { headers: responseHeaders },
        );
      case "createDraft": {
        const { operation: _, commandId, ...payload } = command;
        return data(
          articleObservation(
            await client.content.createArticle({
              headers: { "idempotency-key": commandId },
              payload,
            }),
          ),
          { headers: responseHeaders },
        );
      }
      case "reviseDraft": {
        const { operation: _, commandId, articleId, etag, ...payload } = command;
        return data(
          articleObservation(
            await client.content.reviseArticle({
              params: { articleId },
              headers: { "idempotency-key": commandId, "if-match": etag },
              payload,
            }),
          ),
          { headers: responseHeaders },
        );
      }
      case "publish":
      case "unpublish": {
        const current = await client.content.readArticle({
          params: { articleId: command.articleId },
          headers: {},
        });
        const method =
          command.operation === "publish"
            ? client.content.publishArticle
            : client.content.unpublishArticle;
        await method({
          params: { articleId: command.articleId },
          headers: {
            "idempotency-key": command.commandId,
            "if-match": current.headers.ETag,
          },
          payload: {},
        });
        return data({}, { headers: responseHeaders });
      }
    }
  } catch (error) {
    const tag = tagFrom(error);
    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}
