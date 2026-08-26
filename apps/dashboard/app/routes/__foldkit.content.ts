import {
  ConfigurationError,
  ContentRejectionError,
  CreateContentDraftCommandSchema,
  NetworkError,
  PublicationTransitionCommandSchema,
  ReviseContentDraftCommandSchema,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { ArticleId } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { data } from "react-router";
import { contentBridgeFailure, type ContentBridgeErrorTag } from "../foldkit/content/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.content";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const ContentBridgeActionSchema = S.Union([
  S.Struct({
    operation: S.Literals(["readArticle"]),
    articleId: ArticleId,
  }),
  S.Struct({
    operation: S.Literals(["createDraft"]),
    ...CreateContentDraftCommandSchema.fields,
  }),
  S.Struct({
    operation: S.Literals(["reviseDraft"]),
    ...ReviseContentDraftCommandSchema.fields,
  }),
  S.Struct({
    operation: S.Literals(["publish"]),
    ...PublicationTransitionCommandSchema.fields,
  }),
  S.Struct({
    operation: S.Literals(["unpublish"]),
    ...PublicationTransitionCommandSchema.fields,
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
    default:
      return 503;
  }
};

const contentRejectionTagFrom = (error: unknown): ContentBridgeErrorTag | undefined => {
  let tag: unknown;
  if (error instanceof ContentRejectionError) {
    tag = error.contentTag;
  } else if (typeof error === "object" && error !== null && "contentTag" in error) {
    tag = error.contentTag;
  }
  switch (tag) {
    case "UnauthenticatedActor":
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
    case "SlugConflict":
    case "CommandConflict":
    case "ArticleNotFound":
    case "DepartmentNotFound":
    case "ContentDecodeError":
    case "ContentIntegrityError":
    case "ContentPersistenceError":
      return tag;
    default:
      return undefined;
  }
};

const tagFrom = (error: unknown): ContentBridgeErrorTag => {
  const contentTag = contentRejectionTagFrom(error);
  if (contentTag !== undefined) return contentTag;
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }
  if (error instanceof UnauthorizedError) return "UnauthenticatedActor";
  if (error instanceof ConfigurationError) return "Configuration";
  if (error instanceof NetworkError) {
    return error.cause === undefined ? "ContentPersistenceError" : "Network";
  }
  return "ContentPersistenceError";
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
    const client = createAuthenticatedClient(cookie);
    const [workspace, departments] = await Promise.all([
      client.admin.content.workspace(),
      client.public.organization.listDepartments(),
    ]);
    return data(
      {
        workspace,
        knownDepartments: departments
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
    const client = createAuthenticatedClient(cookie);
    switch (command.operation) {
      case "readArticle":
        return data(await client.admin.content.read(command.articleId), {
          headers: responseHeaders,
        });
      case "createDraft": {
        const { operation: _, ...contentCommand } = command;
        return data(await client.admin.content.createDraft(contentCommand), {
          headers: responseHeaders,
        });
      }
      case "reviseDraft": {
        const { operation: _, ...contentCommand } = command;
        return data(await client.admin.content.reviseDraft(contentCommand), {
          headers: responseHeaders,
        });
      }
      case "publish": {
        const { operation: _, ...contentCommand } = command;
        return data(await client.admin.content.publish(contentCommand), {
          headers: responseHeaders,
        });
      }
      case "unpublish": {
        const { operation: _, ...contentCommand } = command;
        return data(await client.admin.content.unpublish(contentCommand), {
          headers: responseHeaders,
        });
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
