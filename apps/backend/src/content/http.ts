import {
  ArticleMergePatch,
  CreateArticleEndpoint,
  CreateArticleRequest,
  ExternalNativeApi,
  ListNewsEndpoint,
  PublishArticleEndpoint,
  PublishArticleRequest,
  PublishArticleResponse,
  ReadArticleEndpoint,
  ReadContentWorkspaceEndpoint,
  ReadNewsArticleEndpoint,
  ReviseArticleEndpoint,
  UnpublishArticleEndpoint,
  UnpublishArticleRequest,
  UnpublishArticleResponse,
  reflectAccessSpec,
  type StrongETag,
} from "@vektorprogrammet/http-api";
import {
  ArticleId,
  Content,
  ContentArticleDetailSchema,
  ContentAuthorityInactive,
  ContentCommandId,
  ContentManagement,
  ContentNotInScope,
  ContentWorkspaceQuerySchema,
  ContentWorkspaceSchema,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  readPublicNews,
  resolveContentActor,
  runContentArticleDetail,
  runContentWorkspace,
  type ContentActor,
  type ContentArticleDetail,
} from "@vektorprogrammet/domain/content";
import {
  createDraftPostgres,
  publishPostgres,
  readContentArticleHttpSourcePostgres,
  readArticleDetailInTransactionPostgres,
  readContentAuthorityHttpSourcesPostgres,
  readPublishedNewsArticleHttpSourcePostgres,
  readPublishedNewsCollectionHttpSourcesPostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "@vektorprogrammet/database/content";
import {
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CredentialEvidenceRef,
  DomainId,
  GrantId,
  ResourceId,
  ResourceKind,
  accessHttpStatus,
  evaluateAccessJourney,
  makeGrant,
  type AccessSpec,
  type CanonicalScopeResolution,
  type Scope,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  type CanonicalSemanticRequest,
  deriveHttpIdentity,
  deriveStrongETag,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  interpretArticleMergePatchSource,
  nativeProblemResponse,
  normalizeTarget,
  notModifiedResponse,
  parseIdempotencyKey,
  parseIfNoneMatch,
  parseJsonWithoutDuplicateMembers,
  parseReadIfMatch,
  parseRequiredIfMatch,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
  validationProblemResponse,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
}

type ContentBackendRequirements = Database | Organization | Profile | Content | ContentManagement;

type ContentRequestActorResolver<E, R> = (
  request: Request,
) => Effect.Effect<ContentRequestActor, E, R>;

export const CONTENT_NATIVE_OPERATION_IDS = [
  "content.readContentWorkspace",
  "content.createArticle",
  "content.readArticle",
  "content.reviseArticle",
  "content.publishArticle",
  "content.unpublishArticle",
  "content.listNews",
  "content.readNewsArticle",
] as const;

const NO_STORE = "no-store";
const PRIVATE_NO_STORE = "private, no-store";
const PUBLIC_NEWS_CACHE = "public, max-age=60, s-maxage=300, must-revalidate";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

interface ContentAccessFacts {
  readonly state?: string;
  readonly ownerPersonId?: PersonId;
  readonly publishable?: boolean;
  readonly unpublishable?: boolean;
}

interface AuthorizedContentActor extends ContentRequestActor {
  readonly contentActor: ContentActor;
}

interface TransactionalAuthorizedContentActor extends AuthorizedContentActor {
  readonly credential: TransactionPersonAuthority["credential"];
}

const errorTag = (cause: unknown): string | undefined =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : undefined;

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(
      cause.code,
      cause.status,
      cause.status === 401 ? { "www-authenticate": PERSON_CHALLENGE } : undefined,
    );
  }
  switch (errorTag(cause)) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": PERSON_CHALLENGE,
      });
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return nativeProblemResponse("authority.denied", 403);
    case "ArticleNotFound":
      return nativeProblemResponse("content.article-not-found", 404);
    case "SlugConflict":
      return nativeProblemResponse("content.slug-conflict", 422);
    case "DepartmentNotFound":
      return nativeProblemResponse("content.department-not-found", 422);
    case "CommandConflict":
      return nativeProblemResponse("content.lifecycle-conflict", 409);
    case "ContentIntegrityError":
      return nativeProblemResponse("content.integrity-error", 500);
    case "ContentPersistenceError":
      return nativeProblemResponse("content.unavailable", 503);
    case "ContentDecodeError":
      return nativeProblemResponse("internal.error", 500);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};

export const contentHttpErrorResponse = errorResponse;

const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );

const strictOutput = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

const readJsonBody = (
  request: Request,
  expectedMediaType: "application/json" | "application/merge-patch+json",
  maxBodyBytes: number,
) =>
  Effect.tryPromise({
    try: async () => {
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== expectedMediaType) {
        throw new HttpSemanticFailure("media-type.unsupported", 415);
      }
      const declaredLength = request.headers.get("content-length");
      if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }
        if (length > maxBodyBytes) throw new HttpSemanticFailure("request.too-large", 413);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > maxBodyBytes) throw new HttpSemanticFailure("request.too-large", 413);
      return parseJsonWithoutDuplicateMembers(bytes);
    },
    catch: (cause) => cause,
  });

export const readContentRequestBody = readJsonBody;

const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);
  return value === null ? [] : [value];
};

const noQuery = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search.length > 0) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: (cause) => cause,
  });

const departmentFromQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];
      if (parameters.some(([key]) => key !== "department")) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      const values = parameters.filter(([key]) => key === "department").map(([, value]) => value);
      if (values.length > 1) throw new HttpSemanticFailure("request.malformed", 400);
      return values.length === 0 ? {} : { departmentId: values[0] };
    },
    catch: (cause) => cause,
  }).pipe(Effect.flatMap((query) => strictDecode(ContentWorkspaceQuerySchema, query)));

const versionFromQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];
      if (parameters.some(([key]) => key !== "version")) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      const values = parameters.filter(([key]) => key === "version").map(([, value]) => value);
      if (values.length > 1) throw new HttpSemanticFailure("request.malformed", 400);
      if (values.length === 0) return undefined;
      const version = Number(values[0]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      return version;
    },
    catch: (cause) => cause,
  });

const authorizedActor = <E, R>(request: Request, resolveActor: ContentRequestActorResolver<E, R>) =>
  Effect.gen(function* () {
    const actor = yield* resolveActor(request);
    const authority = yield* Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, actor.authorizationInstant),
    );
    const decision = resolveContentActor(authority);
    if (decision._tag === "Deny") {
      return yield* Effect.fail(
        decision.reason === "AuthorityInactive"
          ? new ContentAuthorityInactive({})
          : new ContentNotInScope({}),
      );
    }
    return { ...actor, contentActor: decision.value };
  });

const authorizedActorInTransaction = (request: Request) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestPersonAuthorityInTransaction(request);
    if (authenticated.credential.principal._tag !== "Person") {
      return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
    }
    const decision = resolveContentActor(authenticated.authority);
    if (decision._tag === "Deny") {
      return yield* Effect.fail(
        decision.reason === "AuthorityInactive"
          ? new ContentAuthorityInactive({})
          : new ContentNotInScope({}),
      );
    }
    return {
      personId: authenticated.credential.principal.personId,
      authorizationInstant: authenticated.authorizationInstant,
      credential: authenticated.credential,
      contentActor: decision.value,
    };
  });

const contentScope: Scope = { _tag: "Domain", domainId: DomainId.make("content") };

const authorizeContentOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: AuthorizedContentActor;
  readonly resolution: CanonicalScopeResolution<ContentAccessFacts>;
}) => {
  const instant = AuthorizationInstant.make(input.actor.authorizationInstant);
  const principal = { _tag: "Person" as const, personId: input.actor.personId };
  const capabilityList =
    input.spec.capabilities._tag === "One"
      ? [input.spec.capabilities.capability]
      : input.spec.capabilities._tag === "All" || input.spec.capabilities._tag === "Any"
        ? input.spec.capabilities.capabilities
        : [];
  const grants = capabilityList.map((capability, index) =>
    makeGrant({
      grantId: GrantId.make(`native-content:${input.actor.personId}:${index}`),
      subject: principal,
      capability,
      scope: contentScope,
      startAt: instant,
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("native-content-role-projection"),
      revision: 0,
    }),
  );
  const bearer = input.request.headers.get("authorization")?.startsWith("Bearer ") === true;
  return evaluateAccessJourney(input.spec, undefined, {
    now: Effect.succeed(instant),
    resolveCredential: () =>
      Effect.succeed({
        _tag: "Accepted" as const,
        mechanism: {
          _tag: bearer ? ("OAuthUserBearer" as const) : ("BetterAuthCookie" as const),
        },
        principal,
        evidenceRef: CredentialEvidenceRef.make("native-content-person-credential"),
      }),
    resolveScope: () => Effect.succeed(input.resolution),
    resolveGrants: () => Effect.succeed(grants),
  }).pipe(
    Effect.flatMap((evaluation) => {
      const status = accessHttpStatus(evaluation, input.spec.concealment);
      return status === 200
        ? Effect.void
        : Effect.fail(
            new HttpSemanticFailure(
              status === 401
                ? "credential.invalid"
                : status === 404
                  ? "resource.not-found"
                  : "authority.denied",
              status,
            ),
          );
    }),
  );
};

const authorizeAnonymousContentOperation = (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Record<string, never>>,
) =>
  Effect.gen(function* () {
    const instant = yield* Effect.sync(() => AuthorizationInstant.make(new Date().toISOString()));
    const evaluation = yield* evaluateAccessJourney(spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: { _tag: "None" as const },
          principal: { _tag: "Anonymous" as const },
          evidenceRef: CredentialEvidenceRef.make("native-content-anonymous"),
        }),
      resolveScope: () => Effect.succeed(resolution),
      resolveGrants: () => Effect.succeed([]),
    });
    const status = accessHttpStatus(evaluation, spec.concealment);
    if (status !== 200) {
      return yield* Effect.fail(
        new HttpSemanticFailure(status === 404 ? "resource.not-found" : "authority.denied", status),
      );
    }
  });

const articleContext = (
  detail: ContentArticleDetail,
  createdByPersonId: PersonId,
  authorityVersion: string,
) => ({
  domainId: DomainId.make("content"),
  departmentId: detail.departmentIds[0] ?? null,
  resource: {
    kind: ResourceKind.make("content-article"),
    id: ResourceId.make(String(detail.articleId)),
  },
  facts: {
    state: detail.status,
    ownerPersonId: createdByPersonId,
    publishable: detail.canPublish,
    unpublishable: detail.status === "Published",
  },
  authorityVersion: AuthorityVersion.make(authorityVersion),
});

const articleETagEffect = (articleId: ArticleId, personId: PersonId) =>
  Effect.gen(function* () {
    const [article, authority] = yield* Effect.all([
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(personId),
    ]);
    return deriveStrongETag({
      representationKind: "ContentArticleDetailSchema",
      resourceIdentity: `content-article:${articleId}`,
      version: [
        article.articleRevision,
        article.authorProfileRevision,
        authority.map((source) => [source.kind, source.identity, source.revisions]),
      ],
    });
  });

const conditionalJsonResponse = (
  request: Request,
  body: unknown,
  etag: StrongETag,
  cacheControl: string,
) =>
  Effect.try({
    try: () => {
      const decision = evaluateReadPreconditions({
        currentETag: etag,
        ifMatch: parseReadIfMatch(headerValues(request, "if-match")),
        ifNoneMatch: parseIfNoneMatch(headerValues(request, "if-none-match")),
      });
      if (decision._tag === "Failed") return nativeProblemResponse(decision.code, decision.status);
      if (decision._tag === "NotModified") {
        return notModifiedResponse({ etag, cacheControl, vary: "Origin" });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "cache-control": cacheControl,
          "content-type": "application/json",
          etag,
          vary: "Origin",
        },
      });
    },
    catch: (cause) => cause,
  });

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
          catch: (cause) => cause,
        });
        const commandId = yield* strictDecode(ContentCommandId, derived.commandId);
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
                catch: (cause) => cause,
              }),
            ),
          ),
        };
      }),
    );
    return nativeCommandOutcomeResponse(outcome);
  });

const readWorkspace = <E, R>(request: Request, resolveActor: ContentRequestActorResolver<E, R>) =>
  Effect.gen(function* () {
    const query = yield* departmentFromQuery(request);
    const actor = yield* authorizedActor(request, resolveActor);
    yield* authorizeContentOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadContentWorkspaceEndpoint)),
      request,
      actor,
      resolution: {
        selection: "AllMatching",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: query.departmentId ?? null,
            resource: null,
            facts: {},
            authorityVersion: AuthorityVersion.make(actor.authorizationInstant),
          },
        ],
      },
    });
    const workspace = yield* runContentWorkspace(actor.personId, actor.authorizationInstant, query);
    const body = yield* strictOutput(ContentWorkspaceSchema, workspace);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  });

const createArticle = (request: Request, maxBodyBytes: number) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const rawBody = yield* readJsonBody(request, "application/json", maxBodyBytes);
    const body = yield* strictDecode(CreateArticleRequest, rawBody);
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

const readArticle = <E, R>(
  request: Request,
  articleId: ArticleId,
  resolveActor: ContentRequestActorResolver<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const actor = yield* authorizedActor(request, resolveActor);
    const [detail, source, authority] = yield* Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(actor.personId),
    ]);
    yield* authorizeContentOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadArticleEndpoint)),
      request,
      actor,
      resolution: {
        selection: "ExactlyOne",
        contexts: [articleContext(detail, source.createdByPersonId, actor.authorizationInstant)],
      },
    });
    const output = yield* strictOutput(ContentArticleDetailSchema, detail);
    const etag = deriveStrongETag({
      representationKind: "ContentArticleDetailSchema",
      resourceIdentity: `content-article:${articleId}`,
      version: [
        source.articleRevision,
        source.authorProfileRevision,
        authority.map((item) => [item.kind, item.identity, item.revisions]),
      ],
    });
    return yield* conditionalJsonResponse(request, output, etag, PRIVATE_NO_STORE);
  });

const reviseArticle = (request: Request, articleId: ArticleId, maxBodyBytes: number) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const patchSource = yield* readJsonBody(request, "application/merge-patch+json", maxBodyBytes);
    const interpretation = yield* Effect.try({
      try: () => interpretArticleMergePatchSource(patchSource),
      catch: (cause) => cause,
    });
    if (interpretation._tag === "Rejected") {
      return validationProblemResponse(interpretation.code, interpretation.errors);
    }
    const patch = yield* strictDecode(ArticleMergePatch, patchSource);
    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) => cause,
    });
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
                if (precondition._tag === "Failed") {
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

const lifecycleArticle = (
  request: Request,
  articleId: ArticleId,
  operation: "Publish" | "Unpublish",
  maxBodyBytes: number,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const endpoint = operation === "Publish" ? PublishArticleEndpoint : UnpublishArticleEndpoint;
    const wireSchema = operation === "Publish" ? PublishArticleRequest : UnpublishArticleRequest;
    const rawBody = yield* readJsonBody(request, "application/json", maxBodyBytes);
    const body = yield* strictDecode(wireSchema, rawBody);
    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) => cause,
    });
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
                if (precondition._tag === "Failed") {
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

const listNews = (request: Request) =>
  Effect.gen(function* () {
    const query = yield* departmentFromQuery(request);
    yield* authorizeAnonymousContentOperation(
      Option.getOrThrow(reflectAccessSpec(ListNewsEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: query.departmentId ?? null,
            resource: null,
            facts: {},
            authorityVersion: AuthorityVersion.make("public-news"),
          },
        ],
      },
    );
    const listing = yield* readPublicNews({ _tag: "Listing", departmentId: query.departmentId });
    const [body, sources] = yield* Effect.all([
      strictOutput(PublishedNewsListingSchema, listing),
      readPublishedNewsCollectionHttpSourcesPostgres(query.departmentId),
    ]);
    const identity =
      query.departmentId === undefined ? "/api/news" : `/api/news?department=${query.departmentId}`;
    const etag = deriveStrongETag({
      representationKind: "PublishedNewsListing",
      resourceIdentity: identity,
      version: sources.map((source) => [
        source.articleId,
        source.currentVersionNumber,
        source.publishedAt,
        source.authorProfileRevision,
      ]),
    });
    return yield* conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
  });

const readNewsArticle = (request: Request, slug: string) =>
  Effect.gen(function* () {
    const versionNumber = yield* versionFromQuery(request);
    yield* authorizeAnonymousContentOperation(
      Option.getOrThrow(reflectAccessSpec(ReadNewsArticleEndpoint)),
      {
        selection: "ExactlyOne",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: null,
            resource: {
              kind: ResourceKind.make("content-article"),
              id: ResourceId.make(slug),
            },
            facts: {},
            authorityVersion: AuthorityVersion.make("public-news"),
          },
        ],
      },
    );
    const article = yield* readPublicNews({ _tag: "Article", slug, versionNumber });
    const [body, source] = yield* Effect.all([
      strictOutput(PublishedNewsArticleSchema, article),
      readPublishedNewsArticleHttpSourcePostgres(slug, versionNumber),
    ]);
    const etag = deriveStrongETag({
      representationKind: "PublishedNewsArticle",
      resourceIdentity:
        versionNumber === undefined
          ? `/api/news/${slug}`
          : `/api/news/${slug}?version=${versionNumber}`,
      version: [
        source.articleId,
        source.currentVersionNumber,
        source.selectedVersionNumber,
        source.publishedAt,
        source.authorProfileRevision,
      ],
    });
    return yield* conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
  });

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
            (webRequest) => readWorkspace(webRequest, resolveActor),
            errorResponse,
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createArticle(webRequest, maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readArticle(webRequest, params.articleId, resolveActor),
            errorResponse,
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseArticle(webRequest, params.articleId, maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleArticle(webRequest, params.articleId, "Publish", maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              lifecycleArticle(webRequest, params.articleId, "Unpublish", maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("listNews", ({ request }) => toHttpApiResponse(request, listNews, errorResponse))
        .handleRaw("readNewsArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readNewsArticle(webRequest, params.slug),
            errorResponse,
          ),
        ),
    ),
  );
