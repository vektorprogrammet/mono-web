import {
  ConfigurationError,
  ContentRejectionError,
  NetworkError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
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
    case "CommandConflict":
      return 409;
    case "Network":
      return 502;
    case "ContentDecodeError":
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
    const workspace = await client.admin.content.workspace();
    return data(workspace, { headers: responseHeaders });
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

  const command = (await request.json().catch(() => null)) as unknown;
  if (
    command === null ||
    typeof command !== "object" ||
    !("commandId" in command) ||
    typeof (command as { commandId: unknown }).commandId !== "string"
  ) {
    return data(contentBridgeFailure("ContentDecodeError"), {
      status: 422,
      headers: responseHeaders,
    });
  }

  const rawOperation = (command as { operation?: unknown }).operation;
  const operation = typeof rawOperation === "string" ? rawOperation : "createDraft";
  const articleId = Number((command as { articleId?: unknown }).articleId ?? 0) as never;
  const commandId = (command as { commandId: string }).commandId as never;

  try {
    const client = createAuthenticatedClient(cookie);
    const result =
      operation === "publish"
        ? await client.admin.content.publish({ commandId, articleId } as never)
        : operation === "unpublish"
          ? await client.admin.content.unpublish({ commandId, articleId } as never)
          : operation === "reviseDraft"
            ? await client.admin.content.reviseDraft(command as never)
            : await client.admin.content.createDraft(command as never);
    return data(result, { headers: responseHeaders });
  } catch (error) {
    const tag = tagFrom(error);
    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}
