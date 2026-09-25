/** Native HttpApi composition for staff content and public news endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { nativeUserChallenges } from "@vektorprogrammet/http-api/http-semantics";
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { classifyCredential } from "../http-api/problem.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import { createArticle, lifecycleArticle, reviseArticle } from "./http-commands.js";
import type { ContentRequestActorResolver } from "./http-context.js";
import { contentHttpErrorResponse } from "./http-problem.js";
import { listNews, readArticle, readContentWorkspace, readNewsArticle } from "./http-reads.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Answers a content failure; a rejected person is classified by the credential the request carries. */
const contentFailure =
  (request: HttpServerRequest.HttpServerRequest) =>
  (cause: unknown): Response =>
    contentHttpErrorResponse(
      cause,
      classifyCredential(
        request.headers.authorization,
        request.headers.cookie,
        nativeUserChallenges(),
      ),
    );

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
            contentFailure(request),
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createArticle(webRequest, maxBodyBytes),
            contentFailure(request),
          ),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readArticle(webRequest, params.articleId, resolveActor),
            contentFailure(request),
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseArticle(webRequest, params.articleId, maxBodyBytes),
            contentFailure(request),
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleArticle(webRequest, params.articleId, "Publish", maxBodyBytes),
            contentFailure(request),
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              lifecycleArticle(webRequest, params.articleId, "Unpublish", maxBodyBytes),
            contentFailure(request),
          ),
        )
        .handleRaw("listNews", ({ request }) =>
          toHttpApiResponse(request, listNews, contentFailure(request)),
        )
        .handleRaw("readNewsArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readNewsArticle(webRequest, params.slug),
            contentFailure(request),
          ),
        ),
    ),
  );
