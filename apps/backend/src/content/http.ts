/** Native HttpApi composition for staff content and public news endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import { createArticle, lifecycleArticle, reviseArticle } from "./http-commands.js";
import type { ContentRequestActorResolver } from "./http-context.js";
import { contentHttpErrorResponse } from "./http-problem.js";
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
        .handleRaw("readContentWorkspace", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readContentWorkspace(webRequest, resolveActor),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createArticle(webRequest, maxBodyBytes),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readArticle(webRequest, params.articleId, resolveActor),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseArticle(webRequest, params.articleId, maxBodyBytes),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleArticle(webRequest, params.articleId, "Publish", maxBodyBytes),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              lifecycleArticle(webRequest, params.articleId, "Unpublish", maxBodyBytes),
            contentHttpErrorResponse,
          ),
        )
        .handleRaw("listNews", ({ request }) =>
          toHttpApiResponse(request, listNews, contentHttpErrorResponse),
        )
        .handleRaw("readNewsArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readNewsArticle(webRequest, params.slug),
            contentHttpErrorResponse,
          ),
        ),
    ),
  );
