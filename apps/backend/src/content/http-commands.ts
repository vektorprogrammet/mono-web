/** Content command handlers: create, revise, publish, and unpublish articles. */
import type { Database } from "@vektorprogrammet/database";
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailInTransactionPostgres,
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "@vektorprogrammet/database/content";
import { AuthorityVersion, DomainId } from "@vektorprogrammet/domain/authz";
import {
  ContentArticleDetailSchema,
  ContentCommandId,
  type ArticleId,
  type Content,
  type ContentManagement,
} from "@vektorprogrammet/domain/content";
import type { Organization } from "@vektorprogrammet/domain/organization";
import type { Profile } from "@vektorprogrammet/domain/profile";
import {
  ArticleMergePatch,
  CreateArticleEndpoint,
  CreateArticleRequest,
  PublishArticleEndpoint,
  PublishArticleRequest,
  PublishArticleResponse,
  ReviseArticleEndpoint,
  UnpublishArticleEndpoint,
  UnpublishArticleRequest,
  UnpublishArticleResponse,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Predicate, Schema } from "effect";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  evaluateMutationPrecondition,
  interpretArticleMergePatchSource,
  normalizeTarget,
  parseIdempotencyKey,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
  validationProblemResponse,
  type CanonicalSemanticRequest,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { articleContext, contentScope } from "./http-access.js";
import {
  authorizedActorInTransaction,
  type AuthorizedContentActor,
  type TransactionalAuthorizedContentActor,
} from "./http-context.js";
import {
  headerValues,
  readContentRequestBody,
  rejectQueryString,
  requiredIfMatch,
  strictDecode,
} from "./http-decode.js";
import { knownContentFailure } from "./http-problem.js";
import { articleETagEffect } from "./http-representation.js";

type ContentBackendRequirements = Database | Organization | Profile | Content | ContentManagement;

const NO_STORE = "no-store";

const commandIdentity = (
  request: Request,
  actor: AuthorizedContentActor,
  operationId: string,
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
) => {
  const idempotencyKey = parseIdempotencyKey(headerValues(request, "idempotency-key"));

  return deriveHttpIdentity({
    credentialSubject: `Person:${actor.personId}`,
    qualifiedOperationId: operationId,
    normalizedTarget: normalizeTarget(routeTemplate, identities),
    idempotencyKey,
  });
};

interface PreparedContentCommand {
  readonly actor: TransactionalAuthorizedContentActor;
  readonly execute: (
    commandId: ContentCommandId,
  ) => Effect.Effect<Response, unknown, ContentBackendRequirements>;
}

const executeCommand = <E, R>(
  request: Request,
  operationId: string,
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
  semanticRequest: CanonicalSemanticRequest,
  prepare: () => Effect.Effect<PreparedContentCommand, E, R>,
) =>
  Effect.gen(function* () {
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const prepared = yield* prepare();

        const derived = yield* Effect.try({
          try: () =>
            commandIdentity(request, prepared.actor, operationId, routeTemplate, identities),
          catch: knownContentFailure,
        });

        const commandId = yield* strictDecode(ContentCommandId)(derived.commandId);

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(semanticRequest),
            operationId,
          },
          execute: prepared.execute(commandId).pipe(
            Effect.flatMap((response) =>
              Effect.tryPromise({
                try: () => responseCapsule(response),
                catch: knownContentFailure,
              }),
            ),
          ),
        };
      }),
    );

    return nativeCommandOutcomeResponse(outcome);
  });

export const createArticle = (request: Request, maxBodyBytes: number) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const rawBody = yield* readContentRequestBody(request, "application/json", maxBodyBytes);
    const body = yield* strictDecode(CreateArticleRequest)(rawBody);

    return yield* executeCommand(
      request,
      "content.createArticle",
      "/api/content/articles",
      {},
      { body },
      () =>
        Effect.gen(function* () {
          const actor = yield* authorizedActorInTransaction(request);
          yield* authorizePersonNativeOperation({
            spec: Option.getOrThrow(reflectAccessSpec(CreateArticleEndpoint)),
            credential: actor.credential,
            personId: actor.personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                {
                  domainId: DomainId.make("content"),
                  departmentId: null,
                  resource: null,
                  facts: {},
                  authorityVersion: AuthorityVersion.make(actor.authorizationInstant),
                },
              ],
            },
            grantScopes: [contentScope],
            now: actor.authorizationInstant,
          });

          return {
            actor,
            execute: (commandId) =>
              createDraftPostgres({
                command: { ...body, commandId },
                personId: actor.personId,
                authorizationInstant: actor.authorizationInstant,
              }).pipe(
                Effect.flatMap((created) =>
                  Effect.gen(function* () {
                    const detail = yield* readArticleDetailInTransactionPostgres({
                      personId: actor.personId,
                      authorizationInstant: actor.authorizationInstant,
                      articleId: created.articleId,
                    });

                    const source = yield* readContentArticleHttpSourcePostgres(created.articleId);

                    const authority = yield* readContentAuthorityHttpSourcesPostgres(
                      actor.personId,
                    );

                    const etag = deriveStrongETag({
                      representationKind: "ContentArticleDetailSchema",
                      resourceIdentity: `content-article:${created.articleId}`,
                      version: [
                        source.articleRevision,
                        source.authorProfileRevision,
                        authority.map((item) => [item.kind, item.identity, item.revisions]),
                      ],
                    });

                    const output = yield* Schema.decodeEffect(ContentArticleDetailSchema)(detail, {
                      onExcessProperty: "error",
                    }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                    return new Response(JSON.stringify(output), {
                      status: 201,
                      headers: {
                        "cache-control": NO_STORE,
                        "content-type": "application/json",
                        etag,
                        location: `/api/content/articles/${created.articleId}`,
                      },
                    });
                  }),
                ),
              ),
          };
        }),
    );
  });

export const reviseArticle = (request: Request, articleId: ArticleId, maxBodyBytes: number) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const patchSource = yield* readContentRequestBody(
      request,
      "application/merge-patch+json",
      maxBodyBytes,
    );

    const interpretation = yield* Effect.try({
      try: () => interpretArticleMergePatchSource(patchSource),
      catch: knownContentFailure,
    });

    if (Predicate.isTagged(interpretation, "Rejected")) {
      return validationProblemResponse(interpretation.code, interpretation.errors);
    }

    const patch = yield* strictDecode(ArticleMergePatch)(patchSource);

    const ifMatch = yield* requiredIfMatch(request);

    return yield* executeCommand(
      request,
      "content.reviseArticle",
      "/api/content/articles/{articleId}",
      { articleId: String(articleId) },
      semanticMutationRequest(patch, ifMatch),
      () =>
        Effect.gen(function* () {
          const actor = yield* authorizedActorInTransaction(request);

          const [current, source, authority] = yield* Effect.all([
            readArticleDetailInTransactionPostgres({
              personId: actor.personId,
              authorizationInstant: actor.authorizationInstant,
              articleId,
            }),
            readContentArticleHttpSourcePostgres(articleId),
            readContentAuthorityHttpSourcesPostgres(actor.personId),
          ]);

          yield* authorizePersonNativeOperation({
            spec: Option.getOrThrow(reflectAccessSpec(ReviseArticleEndpoint)),
            credential: actor.credential,
            personId: actor.personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                articleContext(current, source.createdByPersonId, actor.authorizationInstant),
              ],
            },
            grantScopes: [contentScope],
            now: actor.authorizationInstant,
          });

          const currentETag = deriveStrongETag({
            representationKind: "ContentArticleDetailSchema",
            resourceIdentity: `content-article:${articleId}`,
            version: [
              source.articleRevision,
              source.authorProfileRevision,
              authority.map((item) => [item.kind, item.identity, item.revisions]),
            ],
          });

          return {
            actor,
            execute: (commandId) =>
              Effect.gen(function* () {
                // Exact replay is selected before execute; a fresh mutation still
                // checks the selected representation inside the owning transaction.
                const precondition = evaluateMutationPrecondition(currentETag, ifMatch);

                if (Predicate.isTagged(precondition, "Failed")) {
                  return yield* Effect.fail(
                    new HttpSemanticFailure(precondition.code, precondition.status),
                  );
                }

                const revised = yield* reviseDraftPostgres({
                  command: {
                    commandId,
                    articleId,
                    expectedRevision: current.revision,
                    title: patch.title ?? current.title,
                    bodyHtml: patch.bodyHtml ?? current.bodyHtml,
                    departmentIds: patch.departmentIds ?? current.departmentIds,
                    sticky: patch.sticky ?? current.sticky,
                  },
                  personId: actor.personId,
                  authorizationInstant: actor.authorizationInstant,
                });

                const detail = yield* readArticleDetailInTransactionPostgres({
                  personId: actor.personId,
                  authorizationInstant: actor.authorizationInstant,
                  articleId: revised.articleId,
                });

                const output = yield* Schema.decodeEffect(ContentArticleDetailSchema)(detail, {
                  onExcessProperty: "error",
                }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const etag = yield* articleETagEffect(articleId, actor.personId);

                return new Response(JSON.stringify(output), {
                  status: 200,
                  headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
                });
              }),
          };
        }),
    );
  });

export const lifecycleArticle = (
  request: Request,
  articleId: ArticleId,
  operation: "Publish" | "Unpublish",
  maxBodyBytes: number,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const endpoint = operation === "Publish" ? PublishArticleEndpoint : UnpublishArticleEndpoint;
    const wireSchema = operation === "Publish" ? PublishArticleRequest : UnpublishArticleRequest;
    const rawBody = yield* readContentRequestBody(request, "application/json", maxBodyBytes);
    const body = yield* strictDecode(wireSchema)(rawBody);

    const ifMatch = yield* requiredIfMatch(request);

    const operationId =
      operation === "Publish" ? "content.publishArticle" : "content.unpublishArticle";

    const suffix = operation === "Publish" ? "publish" : "unpublish";

    return yield* executeCommand(
      request,
      operationId,
      `/api/content/articles/{articleId}:${suffix}`,
      { articleId: String(articleId) },
      semanticMutationRequest(body, ifMatch),
      () =>
        Effect.gen(function* () {
          const actor = yield* authorizedActorInTransaction(request);

          const [current, source, authority] = yield* Effect.all([
            readArticleDetailInTransactionPostgres({
              personId: actor.personId,
              authorizationInstant: actor.authorizationInstant,
              articleId,
            }),
            readContentArticleHttpSourcePostgres(articleId),
            readContentAuthorityHttpSourcesPostgres(actor.personId),
          ]);

          yield* authorizePersonNativeOperation({
            spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
            credential: actor.credential,
            personId: actor.personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                articleContext(current, source.createdByPersonId, actor.authorizationInstant),
              ],
            },
            grantScopes: [contentScope],
            now: actor.authorizationInstant,
          });

          const currentETag = deriveStrongETag({
            representationKind: "ContentArticleDetailSchema",
            resourceIdentity: `content-article:${articleId}`,
            version: [
              source.articleRevision,
              source.authorProfileRevision,
              authority.map((item) => [item.kind, item.identity, item.revisions]),
            ],
          });

          return {
            actor,
            execute: (commandId) =>
              Effect.gen(function* () {
                // Exact replay is selected before execute; a fresh mutation still
                // checks the selected representation inside the owning transaction.
                const precondition = evaluateMutationPrecondition(currentETag, ifMatch);

                if (Predicate.isTagged(precondition, "Failed")) {
                  return yield* Effect.fail(
                    new HttpSemanticFailure(precondition.code, precondition.status),
                  );
                }

                if (operation === "Publish") {
                  const published = yield* publishPostgres({
                    command: { commandId, articleId },
                    personId: actor.personId,
                    authorizationInstant: actor.authorizationInstant,
                  });

                  const output = yield* Schema.decodeEffect(PublishArticleResponse)({
                    articleId: published.articleId,
                    versionNumber: published.versionNumber,
                    publishedAt: published.publishedAt,
                  }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                  const etag = yield* articleETagEffect(articleId, actor.personId);

                  return new Response(JSON.stringify(output), {
                    status: 200,
                    headers: {
                      "cache-control": NO_STORE,
                      "content-type": "application/json",
                      etag,
                    },
                  });
                }

                const unpublished = yield* unpublishPostgres({
                  command: { commandId, articleId },
                  personId: actor.personId,
                  authorizationInstant: actor.authorizationInstant,
                });

                const output = yield* Schema.decodeEffect(UnpublishArticleResponse)({
                  articleId: unpublished.articleId,
                }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const etag = yield* articleETagEffect(articleId, actor.personId);

                return new Response(JSON.stringify(output), {
                  status: 200,
                  headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
                });
              }),
          };
        }),
    );
  });
