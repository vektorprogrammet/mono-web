/** Native HttpApi composition for staff content and public news endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { webHandler } from "../http-api/problem.js";
import { createArticle, lifecycleArticle, reviseArticle } from "./http-commands.js";
import type { ContentRequestActorResolver } from "./http-context.js";
import { listNews, readArticle, readContentWorkspace, readNewsArticle } from "./http-reads.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Native HttpApi implementations for staff content and public news endpoints. */
export const ContentApiHandlers = <E, R>(
  resolveActor: ContentRequestActorResolver<E, R>,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "content", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readContentWorkspace", ({ request, query }) =>
          webHandler(request, (webRequest) =>
            readContentWorkspace(webRequest, query.department, resolveActor),
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          webHandler(request, (webRequest) => createArticle(webRequest, maxBodyBytes)),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readArticle(webRequest, params.articleId, resolveActor),
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            reviseArticle(webRequest, params.articleId, maxBodyBytes),
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            lifecycleArticle(webRequest, params.articleId, "Publish", maxBodyBytes),
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            lifecycleArticle(webRequest, params.articleId, "Unpublish", maxBodyBytes),
          ),
        )
        .handleRaw("listNews", ({ request, query }) =>
          webHandler(request, (webRequest) => listNews(webRequest, query.department)),
        )
        .handleRaw("readNewsArticle", ({ request, params }) =>
          webHandler(request, (webRequest) => readNewsArticle(webRequest, params.slug)),
        ),
    ),
  );
