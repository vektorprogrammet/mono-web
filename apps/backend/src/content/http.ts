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
  createDraftPostgres,
  publishPostgres,
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
  readPublicNews,
  readPublishedNewsArticleHttpSourcePostgres,
  readPublishedNewsCollectionHttpSourcesPostgres,
  resolveContentActor,
  reviseDraftPostgres,
  runContentArticleDetail,
  runContentWorkspace,
  unpublishPostgres,
  type ContentActor,
  type ContentArticleDetail,
} from "@vektorprogrammet/domain/content";
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
import { Database } from "@vektorprogrammet/domain/database";
import { Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
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
  semanticRequestDigest,
  validationProblemResponse,
} from "../http-semantics.js";
import { nativeCommandOutcomeResponse } from "../native-operation.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
}

type ContentBackendRequirements = Database | Organization | Profile | Content | ContentManagement;

export interface ContentBackendRun {
  <A, E>(effect: Effect.Effect<A, E, ContentBackendRequirements>): Promise<A>;
}

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

const strictDecode = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: ContentBackendRun,
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
    ),
  );

const strictOutput = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: ContentBackendRun,
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
    ),
  );

const readJsonBody = async (
  request: Request,
  expectedMediaType: "application/json" | "application/merge-patch+json",
  maxBodyBytes: number,
): Promise<unknown> => {
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
};

export const readContentRequestBody = readJsonBody;

const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);
  return value === null ? [] : [value];
};

const noQuery = (request: Request): void => {
  if (new URL(request.url).search.length > 0) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
};

const departmentFromQuery = async (
  request: Request,
  run: ContentBackendRun,
): Promise<typeof ContentWorkspaceQuerySchema.Type> => {
  const parameters = [...new URL(request.url).searchParams];
  if (parameters.some(([key]) => key !== "department")) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  const values = parameters.filter(([key]) => key === "department").map(([, value]) => value);
  if (values.length > 1) throw new HttpSemanticFailure("request.malformed", 400);
  return strictDecode(
    ContentWorkspaceQuerySchema,
    values.length === 0 ? {} : { departmentId: values[0] },
    run,
  );
};

const versionFromQuery = (request: Request): number | undefined => {
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
};

const authorizedActor = async (
  request: Request,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
): Promise<AuthorizedContentActor> => {
  const actor = await resolveActor(request);
  const authority = await run(
    Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, actor.authorizationInstant),
    ),
  );
  const decision = resolveContentActor(authority);
  if (decision._tag === "Deny") {
    if (decision.reason === "AuthorityInactive") throw new ContentAuthorityInactive({});
    throw new ContentNotInScope({});
  }
  return { ...actor, contentActor: decision.value };
};

const contentScope: Scope = { _tag: "Domain", domainId: DomainId.make("content") };

const authorizeContentOperation = async (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: AuthorizedContentActor;
  readonly resolution: CanonicalScopeResolution<ContentAccessFacts>;
  readonly run: ContentBackendRun;
}): Promise<void> => {
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
  const evaluation = await input.run(
    evaluateAccessJourney(input.spec, undefined, {
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
    }),
  );
  const status = accessHttpStatus(evaluation, input.spec.concealment);
  if (status !== 200) {
    throw new HttpSemanticFailure(
      status === 401
        ? "credential.invalid"
        : status === 404
          ? "resource.not-found"
          : "authority.denied",
      status,
    );
  }
};

const authorizeAnonymousContentOperation = async (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Record<string, never>>,
  run: ContentBackendRun,
): Promise<void> => {
  const instant = AuthorizationInstant.make(new Date().toISOString());
  const evaluation = await run(
    evaluateAccessJourney(spec, undefined, {
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
    }),
  );
  const status = accessHttpStatus(evaluation, spec.concealment);
  if (status !== 200) {
    throw new HttpSemanticFailure(
      status === 404 ? "resource.not-found" : "authority.denied",
      status,
    );
  }
};

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
): Response => {
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
};

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

const executeCommand = async (
  request: Request,
  actor: AuthorizedContentActor,
  operationId: string,
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
  semanticBody: unknown,
  execute: (
    commandId: ContentCommandId,
  ) => Effect.Effect<Response, unknown, ContentBackendRequirements>,
  run: ContentBackendRun,
): Promise<Response> => {
  const derived = commandIdentity(request, actor, operationId, routeTemplate, identities);
  const commandId = await strictDecode(ContentCommandId, derived.commandId, run);
  const [organization, profile, content, contentManagement] = await run(
    Effect.all([Organization, Profile, Content, ContentManagement]),
  );
  const identity = {
    identitySha256: derived.identitySha256,
    requestSha256: semanticRequestDigest({ body: semanticBody }),
    operationId,
  };
  const outcome = await run(
    executeNativeHttpCommandPostgres(
      identity,
      execute(commandId).pipe(
        Effect.provideService(Organization, organization),
        Effect.provideService(Profile, profile),
        Effect.provideService(Content, content),
        Effect.provideService(ContentManagement, contentManagement),
        Effect.flatMap((response) => Effect.promise(() => responseCapsule(response))),
      ),
    ),
  );
  return nativeCommandOutcomeResponse(outcome);
};

const readWorkspace = async (
  request: Request,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
): Promise<Response> => {
  const query = await departmentFromQuery(request, run);
  const actor = await authorizedActor(request, resolveActor, run);
  await authorizeContentOperation({
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
    run,
  });
  const workspace = await run(
    runContentWorkspace(actor.personId, actor.authorizationInstant, query),
  );
  const body = await strictOutput(ContentWorkspaceSchema, workspace, run);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
  });
};

const createArticle = async (
  request: Request,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
  maxBodyBytes: number,
): Promise<Response> => {
  noQuery(request);
  const actor = await authorizedActor(request, resolveActor, run);
  await authorizeContentOperation({
    spec: Option.getOrThrow(reflectAccessSpec(CreateArticleEndpoint)),
    request,
    actor,
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
    run,
  });
  const body = await strictDecode(
    CreateArticleRequest,
    await readJsonBody(request, "application/json", maxBodyBytes),
    run,
  );
  return executeCommand(
    request,
    actor,
    "content.createArticle",
    "/api/content/articles",
    {},
    body,
    (commandId) =>
      createDraftPostgres({
        command: { ...body, commandId },
        personId: actor.personId,
        authorizationInstant: actor.authorizationInstant,
      }).pipe(
        Effect.flatMap((created) =>
          Effect.gen(function* () {
            const detail = yield* runContentArticleDetail(
              actor.personId,
              actor.authorizationInstant,
              created.articleId,
            );
            const source = yield* readContentArticleHttpSourcePostgres(created.articleId);
            const authority = yield* readContentAuthorityHttpSourcesPostgres(actor.personId);
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
    run,
  );
};

const readArticle = async (
  request: Request,
  articleId: ArticleId,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
): Promise<Response> => {
  noQuery(request);
  const actor = await authorizedActor(request, resolveActor, run);
  const [detail, source, authority] = await run(
    Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(actor.personId),
    ]),
  );
  await authorizeContentOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ReadArticleEndpoint)),
    request,
    actor,
    resolution: {
      selection: "ExactlyOne",
      contexts: [articleContext(detail, source.createdByPersonId, actor.authorizationInstant)],
    },
    run,
  });
  const output = await strictOutput(ContentArticleDetailSchema, detail, run);
  const etag = deriveStrongETag({
    representationKind: "ContentArticleDetailSchema",
    resourceIdentity: `content-article:${articleId}`,
    version: [
      source.articleRevision,
      source.authorProfileRevision,
      authority.map((item) => [item.kind, item.identity, item.revisions]),
    ],
  });
  return conditionalJsonResponse(request, output, etag, PRIVATE_NO_STORE);
};

const reviseArticle = async (
  request: Request,
  articleId: ArticleId,
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
  maxBodyBytes: number,
): Promise<Response> => {
  noQuery(request);
  const actor = await authorizedActor(request, resolveActor, run);
  const [current, source] = await run(
    Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
    ]),
  );
  await authorizeContentOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ReviseArticleEndpoint)),
    request,
    actor,
    resolution: {
      selection: "ExactlyOne",
      contexts: [articleContext(current, source.createdByPersonId, actor.authorizationInstant)],
    },
    run,
  });
  const patchSource = await readJsonBody(request, "application/merge-patch+json", maxBodyBytes);
  const interpretation = interpretArticleMergePatchSource(patchSource);
  if (interpretation._tag === "Rejected") {
    return validationProblemResponse(interpretation.code, interpretation.errors);
  }
  const patch = await strictDecode(ArticleMergePatch, patchSource, run);
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  return executeCommand(
    request,
    actor,
    "content.reviseArticle",
    "/api/content/articles/{articleId}",
    { articleId: String(articleId) },
    { patch, ifMatch },
    (commandId) =>
      Effect.gen(function* () {
        const transactionCurrent = yield* runContentArticleDetail(
          actor.personId,
          actor.authorizationInstant,
          articleId,
        );
        const currentETag = yield* articleETagEffect(articleId, actor.personId);
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
            expectedRevision: transactionCurrent.revision,
            title: patch.title ?? transactionCurrent.title,
            bodyHtml: patch.bodyHtml ?? transactionCurrent.bodyHtml,
            departmentIds: patch.departmentIds ?? transactionCurrent.departmentIds,
            sticky: patch.sticky ?? transactionCurrent.sticky,
          },
          personId: actor.personId,
          authorizationInstant: actor.authorizationInstant,
        });
        const detail = yield* runContentArticleDetail(
          actor.personId,
          actor.authorizationInstant,
          revised.articleId,
        );
        const output = yield* Schema.decodeEffect(ContentArticleDetailSchema)(detail, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));
        const etag = yield* articleETagEffect(articleId, actor.personId);
        return new Response(JSON.stringify(output), {
          status: 200,
          headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
        });
      }),
    run,
  );
};

const lifecycleArticle = async (
  request: Request,
  articleId: ArticleId,
  operation: "Publish" | "Unpublish",
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
  maxBodyBytes: number,
): Promise<Response> => {
  noQuery(request);
  const actor = await authorizedActor(request, resolveActor, run);
  const [current, source] = await run(
    Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
    ]),
  );
  const endpoint = operation === "Publish" ? PublishArticleEndpoint : UnpublishArticleEndpoint;
  await authorizeContentOperation({
    spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
    request,
    actor,
    resolution: {
      selection: "ExactlyOne",
      contexts: [articleContext(current, source.createdByPersonId, actor.authorizationInstant)],
    },
    run,
  });
  const wireSchema = operation === "Publish" ? PublishArticleRequest : UnpublishArticleRequest;
  const body = await strictDecode(
    wireSchema,
    await readJsonBody(request, "application/json", maxBodyBytes),
    run,
  );
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const operationId =
    operation === "Publish" ? "content.publishArticle" : "content.unpublishArticle";
  const suffix = operation === "Publish" ? "publish" : "unpublish";
  return executeCommand(
    request,
    actor,
    operationId,
    `/api/content/articles/{articleId}:${suffix}`,
    { articleId: String(articleId) },
    { body, ifMatch },
    (commandId) =>
      Effect.gen(function* () {
        const currentETag = yield* articleETagEffect(articleId, actor.personId);
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
            headers: { "cache-control": NO_STORE, "content-type": "application/json", etag },
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
    run,
  );
};

const listNews = async (request: Request, run: ContentBackendRun): Promise<Response> => {
  const query = await departmentFromQuery(request, run);
  await authorizeAnonymousContentOperation(
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
    run,
  );
  const listing = await run(readPublicNews({ _tag: "Listing", departmentId: query.departmentId }));
  const [body, sources] = await Promise.all([
    strictOutput(PublishedNewsListingSchema, listing, run),
    run(readPublishedNewsCollectionHttpSourcesPostgres(query.departmentId)),
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
  return conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
};

const readNewsArticle = async (
  request: Request,
  slug: string,
  run: ContentBackendRun,
): Promise<Response> => {
  const versionNumber = versionFromQuery(request);
  await authorizeAnonymousContentOperation(
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
    run,
  );
  const article = await run(readPublicNews({ _tag: "Article", slug, versionNumber }));
  const [body, source] = await Promise.all([
    strictOutput(PublishedNewsArticleSchema, article, run),
    run(readPublishedNewsArticleHttpSourcePostgres(slug, versionNumber)),
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
  return conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
};

/** Native HttpApi implementations for staff content and public news endpoints. */
export const ContentApiHandlers = (
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: ContentBackendRun,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "content", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readContentWorkspace", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readWorkspace(webRequest, resolveActor, run),
            errorResponse,
          ),
        )
        .handleRaw("createArticle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createArticle(webRequest, resolveActor, run, maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("readArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readArticle(webRequest, params.articleId, resolveActor, run),
            errorResponse,
          ),
        )
        .handleRaw("reviseArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              reviseArticle(webRequest, params.articleId, resolveActor, run, maxBodyBytes),
            errorResponse,
          ),
        )
        .handleRaw("publishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              lifecycleArticle(
                webRequest,
                params.articleId,
                "Publish",
                resolveActor,
                run,
                maxBodyBytes,
              ),
            errorResponse,
          ),
        )
        .handleRaw("unpublishArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              lifecycleArticle(
                webRequest,
                params.articleId,
                "Unpublish",
                resolveActor,
                run,
                maxBodyBytes,
              ),
            errorResponse,
          ),
        )
        .handleRaw("listNews", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => listNews(webRequest, run), errorResponse),
        )
        .handleRaw("readNewsArticle", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readNewsArticle(webRequest, params.slug, run),
            errorResponse,
          ),
        ),
    ),
  );
