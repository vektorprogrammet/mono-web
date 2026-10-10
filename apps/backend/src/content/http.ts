/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
/** Generated native HttpApi binding for staff content and public news. */
import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import {
  createArticle as createArticleEndpoint,
  ExternalNativeApi,
  listNews as listNewsEndpoint,
  publishArticle as publishArticleEndpoint,
  readArticle as readArticleEndpoint,
  readContentWorkspace as readContentWorkspaceEndpoint,
  readNewsArticle as readNewsArticleEndpoint,
  reflectAccessSpec,
  reviseArticle as reviseArticleEndpoint,
  unpublishArticle as unpublishArticleEndpoint,
} from "@vektorprogrammet/http-api";
import { Effect, Option } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import {
  ContentApiHandlers as GeneratedContentApiHandlers,
  type ContentGuards,
  type ContentRawHandlers,
} from "../../.effx/generated/content-handlers.js";
import {
  authorizeAnonymous,
  authorizePerson,
  personPresentation,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import { CurrentContentAccess } from "./http-access.js";
import { createArticle, lifecycleArticle, reviseArticle } from "./http-commands.js";
import {
  contentOperationId,
  type ContentEndpoint,
  type ContentRequestActorResolver,
} from "./http-context.js";
import { listNews, readArticle, readContentWorkspace, readNewsArticle } from "./http-reads.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

type ContentEndpoints = HttpApiGroup.Endpoints<(typeof ExternalNativeApi)["groups"]["content"]>;

const contentScope: Scope = Scope.Domain({ domainId: DomainId.make("content") });

/** The generated guards are request-local; none can ask for a service at evaluation time. */
type LocalContentGuards = {
  readonly [Operation in keyof ContentGuards<ContentEndpoints>]: (
    request: Parameters<ContentGuards<ContentEndpoints>[Operation]>[0],
  ) => Effect.Effect<
    unknown,
    Effect.Error<ReturnType<ContentGuards<ContentEndpoints>[Operation]>>,
    never
  >;
};

const staffGuard = (endpoint: ContentEndpoint) =>
  Effect.gen(function* () {
    const frame = yield* CurrentContentAccess;

    if (
      frame === undefined ||
      frame.operation !== contentOperationId(endpoint) ||
      frame.kind === "Public"
    ) {
      return yield* Effect.die(
        new TypeError("Content staff guard ran outside its matching access decision"),
      );
    }

    return yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
        request: frame.request,
        credential: frame.kind === "StaffCommand" ? frame.actor.credential : undefined,
        personId: frame.actor.personId,
        resolution: frame.resolution,
        grantScopes: [contentScope],
        now: frame.actor.authorizationInstant,
      },
      personPresentation(frame.request),
    ).pipe(
      // Content access reveals every denial; none becomes a concealed not-found.
      unreachable("resource.not-found"),
    );
  });

const publicGuard = (endpoint: ContentEndpoint) =>
  Effect.gen(function* () {
    const frame = yield* CurrentContentAccess;

    if (
      frame === undefined ||
      frame.operation !== contentOperationId(endpoint) ||
      frame.kind !== "Public"
    ) {
      return yield* Effect.die(
        new TypeError("Content public guard ran outside its matching access decision"),
      );
    }

    return yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(endpoint)),
      frame.resolution,
      frame.now,
    );
  });

export const contentGuards = {
  "content.createArticle": () => staffGuard(createArticleEndpoint),
  "content.listNews": () => publicGuard(listNewsEndpoint),
  "content.publishArticle": () => staffGuard(publishArticleEndpoint),
  "content.readArticle": () => staffGuard(readArticleEndpoint),
  "content.readContentWorkspace": () => staffGuard(readContentWorkspaceEndpoint),
  "content.readNewsArticle": () => publicGuard(readNewsArticleEndpoint),
  "content.reviseArticle": () => staffGuard(reviseArticleEndpoint),
  "content.unpublishArticle": () => staffGuard(unpublishArticleEndpoint),
} satisfies ContentGuards<ContentEndpoints>;

/** Raw operations keep transport parsing and execute their generated guards at the original decision points. */
export const makeContentRawHandlers = <E, R, Guards extends LocalContentGuards>(
  resolveActor: ContentRequestActorResolver<E, R>,
  maxBodyBytes: number,
  _guards: Guards,
) =>
  ({
    readContentWorkspace: ({ request, query }, authorize) =>
      webHandler(request, (webRequest) =>
        readContentWorkspace(webRequest, query.department, resolveActor, authorize),
      ),
    createArticle: ({ request }, authorize) =>
      webHandler(request, (webRequest) => createArticle(webRequest, maxBodyBytes, authorize)),
    readArticle: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        readArticle(webRequest, params.articleId, resolveActor, authorize),
      ),
    reviseArticle: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        reviseArticle(webRequest, params.articleId, maxBodyBytes, authorize),
      ),
    publishArticle: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        lifecycleArticle(webRequest, params.articleId, "Publish", maxBodyBytes, authorize),
      ),
    unpublishArticle: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        lifecycleArticle(webRequest, params.articleId, "Unpublish", maxBodyBytes, authorize),
      ),
    listNews: ({ request, query }, authorize) =>
      webHandler(request, (webRequest) => listNews(webRequest, query.department, authorize)),
    readNewsArticle: ({ request, params }, authorize) =>
      // Keep the raw Web query parser for version; HttpApi also decodes the declared query.
      webHandler(request, (webRequest) => readNewsArticle(webRequest, params.slug, authorize)),
  }) satisfies ContentRawHandlers<ContentEndpoints, Guards>;

/** All eight operations bind through the generated group; no second actor or access decision. */
export const ContentApiHandlers = <E, R>(
  resolveActor: ContentRequestActorResolver<E, R>,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
) =>
  GeneratedContentApiHandlers({
    raw: makeContentRawHandlers(resolveActor, maxBodyBytes, contentGuards),
    guards: contentGuards,
  });
