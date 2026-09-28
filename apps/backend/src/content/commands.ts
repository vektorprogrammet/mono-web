/**
 * Content commands: create, revise, publish, and unpublish articles.
 *
 * A command resolves the credential, the content actor, and the authority inside the serializable
 * transaction that commits it, and stores its answer as a command receipt, byte for byte what the
 * HTTP contract stored: the response body, and the article's new entity tag as the `etag` header
 * (a new draft: status 201 and its `location` too). A retry that straddles the cutover from HTTP
 * therefore replays its first answer. The database adapter resolves content authority itself, in
 * the same transaction, before it writes.
 */
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailInTransactionPostgres,
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "@vektorprogrammet/database/content";
import {
  ContentArticleDetailSchema,
  ContentCommandId,
  type ArticleId,
} from "@vektorprogrammet/domain/content";
import {
  type ArticleMergePatch,
  CreateArticle,
  type CreateArticleRequest,
  PublishArticle,
  PublishArticleResponse,
  ReviseArticle,
  UnpublishArticle,
  UnpublishArticleResponse,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  Problem,
  StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  interpretArticleMergePatchSource,
  jsonBodyBytes,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
  type CanonicalSemanticRequest,
} from "../http-semantics.js";
import {
  commandIdentity,
  commandReceiptProblems,
  personPresentation,
  requireCurrentETag,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";
import {
  articleContext,
  articleETag,
  authorizeContentOperation,
  readArticleETag,
  unscopedContext,
} from "./access.js";
import { commandActorInTransaction, type ContentCommandActor } from "./context.js";
import { contentActorProblems, contentProblems } from "./problem.js";

/** A schema whose JSON codec a command receipt stores. */
type ReceiptSchema = Schema.Codec<unknown, unknown, never, never>;

/**
 * The receipt of a content command: its body as JSON, and the article's entity tag as the `etag`
 * header. A new draft also keeps its 201 status and the article's `location`.
 */
const articleCapsule =
  <S extends ReceiptSchema>(schema: S) =>
  (input: {
    readonly body: S["Type"];
    readonly etag: StrongETag;
    readonly location?: string;
  }): Effect.Effect<NativeHttpResponseCapsule> =>
    Schema.encodeEffect(Schema.toCodecJson(schema))(input.body).pipe(
      Effect.orDie,
      Effect.map(
        (body): NativeHttpResponseCapsule => ({
          status: input.location === undefined ? 200 : 201,
          mediaType: "application/json",
          headers:
            input.location === undefined
              ? { "content-type": "application/json", etag: input.etag }
              : { "content-type": "application/json", etag: input.etag, location: input.location },
          bodyBytes: jsonBodyBytes(body),
        }),
      ),
    );

/** The body and entity tag that a content command receipt stores; a mismatch is a defect. */
const storedArticleCommand =
  <S extends ReceiptSchema>(schema: S) =>
  (capsule: NativeHttpResponseCapsule) =>
    Effect.gen(function* () {
      if (capsule.bodyBytes === null || capsule.headers.etag === undefined) {
        return yield* Effect.die(
          new NativeHttpReceiptInvalid({ reason: "a content receipt stores no article" }),
        );
      }

      const body: S["Type"] = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(schema)),
      )(new TextDecoder().decode(capsule.bodyBytes)).pipe(Effect.orDie);

      const etag = yield* Schema.decodeEffect(StrongETag)(capsule.headers.etag).pipe(Effect.orDie);

      return { body, etag };
    });

/**
 * The value of a content command outcome: the committed or replayed body beside its entity tag,
 * or an idempotency problem.
 */
const articleCommandOutcome =
  <S extends ReceiptSchema>(schema: S) =>
  (outcome: NativeHttpCommandOutcome) =>
    Match.value(outcome).pipe(
      Match.tag("Committed", "Replay", ({ response }) => storedArticleCommand(schema)(response)),
      Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
      Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
      Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
      Match.exhaustive,
    );

interface PreparedContentCommand<E, R> {
  readonly actor: ContentCommandActor;
  readonly execute: (commandId: ContentCommandId) => Effect.Effect<NativeHttpResponseCapsule, E, R>;
}

/**
 * Runs one content command and its receipt in one transaction: the actor and authority first,
 * then the stored receipt, then the command. Domain, receipt, and credential failures are
 * answered after the executor.
 */
const executeCommand = <EPrepare, RPrepare, EExecute, RExecute>(input: {
  readonly presentation: CredentialPresentation;
  readonly operationId: string;
  readonly normalizedTarget: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticRequest: CanonicalSemanticRequest;
  readonly prepare: Effect.Effect<PreparedContentCommand<EExecute, RExecute>, EPrepare, RPrepare>;
}) =>
  executeNativeHttpCommandPostgres(
    Effect.gen(function* () {
      const prepared = yield* input.prepare;

      // The HTTP route stays the normalized target, so receipts and command IDs are stable.
      const identity = yield* commandIdentity({
        credentialSubject: `Person:${prepared.actor.personId}`,
        qualifiedOperationId: input.operationId,
        normalizedTarget: input.normalizedTarget,
        idempotencyKey: input.idempotencyKey,
      });

      return {
        identity: {
          identitySha256: identity.identitySha256,
          requestSha256: semanticRequestDigest(input.semanticRequest),
          operationId: input.operationId,
        },
        execute: prepared.execute(ContentCommandId.make(identity.commandId)),
      };
    }),
  ).pipe(contentProblems, commandReceiptProblems, contentActorProblems(input.presentation));

/** The route of one article, as the HTTP contract named it. A path it cannot spell is a defect. */
const articleTarget = (routeTemplate: string, articleId: ArticleId) =>
  Effect.sync(() => normalizeTarget(routeTemplate, { articleId: String(articleId) }));

/**
 * The article that a command is about to change, its entity tag, and the AccessSpec evaluation of
 * `rpc` on it, all inside the command's transaction.
 */
const currentArticle = (input: {
  readonly actor: ContentCommandActor;
  readonly articleId: ArticleId;
  readonly rpc: typeof ReviseArticle | typeof PublishArticle | typeof UnpublishArticle;
  readonly presentation: CredentialPresentation;
}) =>
  Effect.gen(function* () {
    const { actor, articleId } = input;

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
      rpc: input.rpc,
      credential: actor.credential,
      personId: actor.personId,
      authorizationInstant: actor.authorizationInstant,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          articleContext({
            detail: current,
            createdByPersonId: source.createdByPersonId,
            authorityVersion: actor.authorizationInstant,
          }),
        ],
      },
      presentation: input.presentation,
    });

    return { current, etag: articleETag({ articleId, source, authority }) };
  });

/** Creates, or replays by its idempotency key, one article draft. */
export const createArticle = (input: {
  readonly headers: Headers.Headers;
  readonly idempotencyKey: IdempotencyKey;
  readonly request: CreateArticleRequest;
}) => {
  const presentation = personPresentation(input.headers);
  const { request } = input;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      presentation,
      operationId: "content.createArticle",
      normalizedTarget: "/api/content/articles",
      idempotencyKey: input.idempotencyKey,
      semanticRequest: { body: request },
      prepare: Effect.gen(function* () {
        const actor = yield* commandActorInTransaction(input.headers);

        yield* authorizeContentOperation({
          rpc: CreateArticle,
          credential: actor.credential,
          personId: actor.personId,
          authorizationInstant: actor.authorizationInstant,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              unscopedContext({ departmentId: null, authorityVersion: actor.authorizationInstant }),
            ],
          },
          presentation,
        });

        return {
          actor,
          execute: (commandId: ContentCommandId) =>
            Effect.gen(function* () {
              const created = yield* createDraftPostgres({
                command: { ...request, commandId },
                personId: actor.personId,
                authorizationInstant: actor.authorizationInstant,
              });

              const detail = yield* readArticleDetailInTransactionPostgres({
                personId: actor.personId,
                authorizationInstant: actor.authorizationInstant,
                articleId: created.articleId,
              });

              const etag = yield* readArticleETag({
                articleId: created.articleId,
                personId: actor.personId,
              });

              const body = yield* strictOutput(ContentArticleDetailSchema)(detail);

              return yield* articleCapsule(ContentArticleDetailSchema)({
                body,
                etag,
                location: `/api/content/articles/${created.articleId}`,
              });
            }),
        };
      }),
    });

    const stored = yield* articleCommandOutcome(ContentArticleDetailSchema)(outcome);

    return { article: stored.body, etag: stored.etag };
  }).pipe(
    // A new draft names no existing article, and its receipt answers any repeated command first.
    unreachable("content.article-not-found", "content.lifecycle-conflict"),
  );
};

/**
 * Judges the merge patch before the command: an empty patch changes nothing, and a null member
 * would delete a field that an article requires.
 */
const interpretPatch = (patch: ArticleMergePatch) =>
  Effect.gen(function* () {
    // The payload schema decoded JSON, so each present member holds a JSON value or null.
    const source: { [member: string]: Schema.Json } = {};

    if (patch.title !== undefined) source.title = patch.title;

    if (patch.bodyHtml !== undefined) source.bodyHtml = patch.bodyHtml;

    if (patch.departmentIds !== undefined) source.departmentIds = patch.departmentIds;

    if (patch.sticky !== undefined) source.sticky = patch.sticky;

    const interpretation = yield* Effect.sync(() => interpretArticleMergePatchSource(source));

    if (Predicate.isTagged(interpretation, "Rejected")) {
      const { code, errors } = interpretation;

      // The payload schema decoded an object of known members only, so the interpreter's
      // validation.failed (a non-object or an unknown member) cannot occur here.
      return yield* code === "validation.failed"
        ? Effect.die(new Error("a decoded article merge patch failed its interpretation"))
        : Effect.fail(Problem.validation(code, errors));
    }

    return {
      source,
      title: patch.title ?? undefined,
      bodyHtml: patch.bodyHtml ?? undefined,
      departmentIds: patch.departmentIds ?? undefined,
      sticky: patch.sticky ?? undefined,
    };
  });

/** Revises, or replays by its idempotency key, one draft under its entity tag. */
export const reviseArticle = (input: {
  readonly headers: Headers.Headers;
  readonly articleId: ArticleId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  readonly request: ArticleMergePatch;
}) => {
  const presentation = personPresentation(input.headers);
  const { articleId, ifMatch } = input;

  return Effect.gen(function* () {
    const patch = yield* interpretPatch(input.request);

    const outcome = yield* executeCommand({
      presentation,
      operationId: "content.reviseArticle",
      normalizedTarget: yield* articleTarget("/api/content/articles/{articleId}", articleId),
      idempotencyKey: input.idempotencyKey,
      semanticRequest: semanticMutationRequest(patch.source, ifMatch),
      prepare: Effect.gen(function* () {
        const actor = yield* commandActorInTransaction(input.headers);

        const { current, etag: currentETag } = yield* currentArticle({
          actor,
          articleId,
          rpc: ReviseArticle,
          presentation,
        });

        return {
          actor,
          execute: (commandId: ContentCommandId) =>
            Effect.gen(function* () {
              // Exact replay is selected before execute; a fresh mutation still checks the
              // selected representation inside the owning transaction.
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

              const body = yield* strictOutput(ContentArticleDetailSchema)(detail);
              const etag = yield* readArticleETag({ articleId, personId: actor.personId });

              return yield* articleCapsule(ContentArticleDetailSchema)({ body, etag });
            }),
        };
      }),
    });

    const stored = yield* articleCommandOutcome(ContentArticleDetailSchema)(outcome);

    return { article: stored.body, etag: stored.etag };
  }).pipe(
    // The revision is read in the command's own serializable snapshot, and its receipt answers
    // any repeated command first.
    unreachable("content.lifecycle-conflict"),
  );
};

/** Runs one publication transition under the article's entity tag. */
const transitionArticle = <S extends ReceiptSchema, E, R>(input: {
  readonly headers: Headers.Headers;
  readonly articleId: ArticleId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  readonly operationId: "content.publishArticle" | "content.unpublishArticle";
  readonly routeTemplate: string;
  readonly rpc: typeof PublishArticle | typeof UnpublishArticle;
  readonly schema: S;
  readonly transition: (command: {
    readonly actor: ContentCommandActor;
    readonly commandId: ContentCommandId;
  }) => Effect.Effect<S["Type"], E, R>;
}) => {
  const presentation = personPresentation(input.headers);
  const { articleId, ifMatch } = input;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      presentation,
      operationId: input.operationId,
      normalizedTarget: yield* articleTarget(input.routeTemplate, articleId),
      idempotencyKey: input.idempotencyKey,
      // The HTTP body of a transition was an exact empty object, which the digest still covers.
      semanticRequest: semanticMutationRequest({}, ifMatch),
      prepare: Effect.gen(function* () {
        const actor = yield* commandActorInTransaction(input.headers);

        const { etag: currentETag } = yield* currentArticle({
          actor,
          articleId,
          rpc: input.rpc,
          presentation,
        });

        return {
          actor,
          execute: (commandId: ContentCommandId) =>
            Effect.gen(function* () {
              // Exact replay is selected before execute; a fresh mutation still checks the
              // selected representation inside the owning transaction.
              yield* requireCurrentETag(currentETag, ifMatch);

              const result = yield* input.transition({ actor, commandId });
              const body = yield* strictOutput(input.schema)(result);
              const etag = yield* readArticleETag({ articleId, personId: actor.personId });

              return yield* articleCapsule(input.schema)({ body, etag });
            }),
        };
      }),
    });

    const stored = yield* articleCommandOutcome(input.schema)(outcome);

    return { result: stored.body, etag: stored.etag };
  }).pipe(
    // Publication changes neither the slug nor the departments of an article.
    unreachable("content.slug-conflict", "content.department-not-found"),
  );
};

/** Publishes, or replays by its idempotency key, a new version of one article. */
export const publishArticle = (input: {
  readonly headers: Headers.Headers;
  readonly articleId: ArticleId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
}) =>
  transitionArticle({
    ...input,
    operationId: "content.publishArticle",
    routeTemplate: "/api/content/articles/{articleId}:publish",
    rpc: PublishArticle,
    schema: PublishArticleResponse,
    transition: ({ actor, commandId }) =>
      publishPostgres({
        command: { commandId, articleId: input.articleId },
        personId: actor.personId,
        authorizationInstant: actor.authorizationInstant,
      }).pipe(
        Effect.map((published) => ({
          articleId: published.articleId,
          versionNumber: published.versionNumber,
          publishedAt: published.publishedAt,
        })),
      ),
  });

/** Unpublishes, or replays by its idempotency key, one published article. */
export const unpublishArticle = (input: {
  readonly headers: Headers.Headers;
  readonly articleId: ArticleId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
}) =>
  transitionArticle({
    ...input,
    operationId: "content.unpublishArticle",
    routeTemplate: "/api/content/articles/{articleId}:unpublish",
    rpc: UnpublishArticle,
    schema: UnpublishArticleResponse,
    transition: ({ actor, commandId }) =>
      unpublishPostgres({
        command: { commandId, articleId: input.articleId },
        personId: actor.personId,
        authorizationInstant: actor.authorizationInstant,
      }).pipe(Effect.map((unpublished) => ({ articleId: unpublished.articleId }))),
  });
