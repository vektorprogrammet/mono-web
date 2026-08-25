import {
  ConfigurationError,
  ContentRejectionError,
  NetworkError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { data } from "react-router";
import { contentBridgeFailure, type ContentBridgeErrorTag } from "../foldkit/content/bridge";
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

const tagFrom = (error: unknown): ContentBridgeErrorTag => {
  if (error instanceof ContentRejectionError) return error.contentTag;
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
  void cookie;
  return data(contentBridgeFailure("ContentDecodeError"), {
    status: 422,
    headers: responseHeaders,
  });
}
