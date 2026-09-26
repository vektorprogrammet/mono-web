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
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Predicate } from "effect";
import {
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  semanticProblem,
  strictOutput,
  unreachable,
  jsonText,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  interpretArticleMergePatchSource,
  NO_STORE,
  normalizeTarget,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
  type CanonicalSemanticRequest,
} from "../http-semantics.js";
import { articleContext, authorizeContentOperation } from "./http-access.js";
import {
  authorizedActorInTransaction,
  contentOperationId,
  type ContentEndpoint,
  type TransactionalAuthorizedContentActor,
} from "./http-context.js";
import { contentActorProblems, contentProblems } from "./http-problem.js";
import { articleETagEffect } from "./http-representation.js";

type ContentBackendRequirements = Database | Organization | Profile | Content | ContentManagement;

const JSON_BODY = /^application\/json(?:\s*;|$)/iu;

const MERGE_PATCH_BODY = /^application\/merge-patch\+json(?:\s*;|$)/iu;

interface PreparedContentCommand<E> {
  readonly actor: TransactionalAuthorizedContentActor;
  readonly execute: (
    commandId: ContentCommandId,
  ) => Effect.Effect<Response, E, ContentBackendRequirements>;
}

/**
 * Runs one content command and its receipt in one transaction. Domain,
 * receipt, and credential failures are answered after the executor.
 */
const executeCommand = <EPrepare, EExecute, R>(
  request: Request,
  presentation: CredentialPresentation,
  endpoint: ContentEndpoint,
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
  semanticRequest: CanonicalSemanticRequest,
  prepare: () => Effect.Effect<PreparedContentCommand<EExecute>, EPrepare, R>,
) =>
  Effect.gen(function* () {
    const operationId = contentOperationId(endpoint);

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const prepared = yield* prepare();
        const idempotencyKey = yield* idempotencyKeyOf(request);

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${prepared.actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget(routeTemplate, identities),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticRequest),
            operationId,
          },
          execute: prepared
            .execute(ContentCommandId.make(identity.commandId))
            .pipe(Effect.flatMap((response) => Effect.promise(() => responseCapsule(response)))),
        };
      }),
    ).pipe(contentProblems, commandReceiptProblems, contentActorProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

export const createArticle = (request: Request, maxBodyBytes: number) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const rawBody = yield* readJsonBody(request, JSON_BODY, maxBodyBytes);
    const body = yield* decodeRequest(CreateArticleRequest)(rawBody);

    return yield* executeCommand(
      request,
      presentation,
      CreateArticleEndpoint,
      "/api/content/articles",
      {},
      { body },
      () =>
        Effect.gen(function* () {
          const actor = yield* authorizedActorInTransaction(request);

          yield* authorizeContentOperation({
            endpoint: CreateArticleEndpoint,
            credential: actor.credential,
            personId: actor.personId,
            authorizationInstant: actor.authorizationInstant,
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
            presentation,
          });

          return {
            actor,
            execute: (commandId: ContentCommandId) =>
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

                    const output = yield* strictOutput(ContentArticleDetailSchema)(detail);

                    return new Response(yield* jsonText(output), {
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
  }).pipe(
    // A new draft names no existing article, and its receipt answers any repeated command first.
    unreachable("content.article-not-found", "content.lifecycle-conflict"),
  );
};

export const reviseArticle = (request: Request, articleId: ArticleId, maxBodyBytes: number) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const patchSource = yield* readJsonBody(request, MERGE_PATCH_BODY, maxBodyBytes);

    const interpretation = yield* semanticProblem(
      () => interpretArticleMergePatchSource(patchSource),
      ["request.malformed"],
    );

    if (Predicate.isTagged(interpretation, "Rejected")) {
      return yield* Problem.validation(interpretation.code, interpretation.errors);
    }

    const patch = yield* decodeRequest(ArticleMergePatch)(patchSource);
    const ifMatch = yield* requiredIfMatchOf(request);

    return yield* executeCommand(
      request,
      presentation,
      ReviseArticleEndpoint,
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

          yield* authorizeContentOperation({
            endpoint: ReviseArticleEndpoint,
            credential: actor.credential,
            personId: actor.personId,
            authorizationInstant: actor.authorizationInstant,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                articleContext(current, source.createdByPersonId, actor.authorizationInstant),
              ],
            },
            presentation,
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
            execute: (commandId: ContentCommandId) =>
              Effect.gen(function* () {
                // Exact replay is selected before execute; a fresh mutation still
                // checks the selected representation inside the owning transaction.
                yield* requireCurrentETag(currentETag, ifMatch);

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

                const output = yield* strictOutput(ContentArticleDetailSchema)(detail);
                const etag = yield* articleETagEffect(articleId, actor.personId);

                return new Response(yield* jsonText(output), {
                  status: 200,
                  headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
                });
              }),
          };
        }),
    );
  }).pipe(
    // The revision is read in the command's own serializable snapshot, and
    // its receipt answers any repeated command first.
    unreachable("content.lifecycle-conflict"),
  );
};

export const lifecycleArticle = (
  request: Request,
  articleId: ArticleId,
  operation: "Publish" | "Unpublish",
  maxBodyBytes: number,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const endpoint = operation === "Publish" ? PublishArticleEndpoint : UnpublishArticleEndpoint;
    const wireSchema = operation === "Publish" ? PublishArticleRequest : UnpublishArticleRequest;
    const rawBody = yield* readJsonBody(request, JSON_BODY, maxBodyBytes);
    const body = yield* decodeRequest(wireSchema)(rawBody);

    const ifMatch = yield* requiredIfMatchOf(request);

    const suffix = operation === "Publish" ? "publish" : "unpublish";

    return yield* executeCommand(
      request,
      presentation,
      endpoint,
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

          yield* authorizeContentOperation({
            endpoint,
            credential: actor.credential,
            personId: actor.personId,
            authorizationInstant: actor.authorizationInstant,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                articleContext(current, source.createdByPersonId, actor.authorizationInstant),
              ],
            },
            presentation,
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
            execute: (commandId: ContentCommandId) =>
              Effect.gen(function* () {
                // Exact replay is selected before execute; a fresh mutation still
                // checks the selected representation inside the owning transaction.
                yield* requireCurrentETag(currentETag, ifMatch);

                if (operation === "Publish") {
                  const published = yield* publishPostgres({
                    command: { commandId, articleId },
                    personId: actor.personId,
                    authorizationInstant: actor.authorizationInstant,
                  });

                  const output = yield* strictOutput(PublishArticleResponse)({
                    articleId: published.articleId,
                    versionNumber: published.versionNumber,
                    publishedAt: published.publishedAt,
                  });

                  const etag = yield* articleETagEffect(articleId, actor.personId);

                  return new Response(yield* jsonText(output), {
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

                const output = yield* strictOutput(UnpublishArticleResponse)({
                  articleId: unpublished.articleId,
                });

                const etag = yield* articleETagEffect(articleId, actor.personId);

                return new Response(yield* jsonText(output), {
                  status: 200,
                  headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
                });
              }),
          };
        }),
    );
  }).pipe(
    // Publication changes neither the slug nor the departments of an article.
    unreachable("content.slug-conflict", "content.department-not-found"),
  );
};
