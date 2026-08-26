import {
  Configuration,
  ContentArticleNotFound,
  ContentAuthorityInactive,
  ContentCommandConflict,
  ContentDecodeError,
  ContentDepartmentNotFound,
  ContentDraftNotOwned,
  ContentIntegritySdkError,
  ContentNotInScope,
  ContentNotPublisher,
  ContentPersistenceSdkError,
  ContentSlugConflictSdkError,
  ContentUnauthenticatedActor,
  ContentArticleDetailSchema,
  CreateArticleDraftObservationSchema,
  Network,
  PublishObservationSchema,
  ReviseArticleDraftObservationSchema,
  UnpublishObservationSchema,
  type ContentArticleDetail,
  type CreateArticleDraftObservation,
  type CreateContentDraftCommand,
  type InternalSdkError,
  type PublicationTransitionCommand,
  type PublishObservation,
  type ReviseArticleDraftObservation,
  type ReviseContentDraftCommand,
  type UnpublishObservation,
} from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import {
  ContentBridgeFailureSchema,
  ContentWorkspaceBootstrapSchema,
  type ContentBridgeErrorTag,
  type ContentWorkspaceBootstrap,
} from "./bridge";

export interface ContentWorkspaceOperations {
  readonly workspace: () => Effect.Effect<ContentWorkspaceBootstrap, InternalSdkError>;
  readonly readArticle: (
    articleId: number,
  ) => Effect.Effect<ContentArticleDetail, InternalSdkError>;
  readonly createDraft: (
    command: CreateContentDraftCommand,
  ) => Effect.Effect<CreateArticleDraftObservation, InternalSdkError>;
  readonly reviseDraft: (
    command: ReviseContentDraftCommand,
  ) => Effect.Effect<ReviseArticleDraftObservation, InternalSdkError>;
  readonly publish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<PublishObservation, InternalSdkError>;
  readonly unpublish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<UnpublishObservation, InternalSdkError>;
}

export interface ContentWorkspaceClient {
  readonly admin: {
    readonly content: ContentWorkspaceOperations;
  };
}

/**
 * Maps the bridge's strictly decoded tag onto the SDK's typed internal errors.
 */
const failureFromTag = (tag: ContentBridgeErrorTag): InternalSdkError => {
  switch (tag) {
    case "UnauthenticatedActor":
      return new ContentUnauthenticatedActor();
    case "AuthorityInactive":
      return new ContentAuthorityInactive();
    case "NotInScope":
      return new ContentNotInScope();
    case "NotPublisher":
      return new ContentNotPublisher();
    case "DraftNotOwned":
      return new ContentDraftNotOwned();
    case "SlugConflict":
      return new ContentSlugConflictSdkError();
    case "CommandConflict":
      return new ContentCommandConflict();
    case "ArticleNotFound":
      return new ContentArticleNotFound();
    case "DepartmentNotFound":
      return new ContentDepartmentNotFound();
    case "ContentDecodeError":
      return new ContentDecodeError();
    case "ContentIntegrityError":
      return new ContentIntegritySdkError();
    case "ContentPersistenceError":
      return new ContentPersistenceSdkError();
    case "Network":
      return new Network({ message: "Content bridge request failed" });
    case "Configuration":
      return new Configuration({ message: "Content bridge is not configured" });
  }
};

const readBridge = async (
  url: string,
  method: string,
  body?: unknown,
): Promise<{ readonly response: Response; readonly payload: unknown }> => {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  return { response, payload };
};

const request = <A>(
  schema: S.Decoder<A, never>,
  url: string,
  method: string,
  body?: unknown,
): Effect.Effect<A, InternalSdkError> =>
  Effect.tryPromise({
    try: () => readBridge(url, method, body),
    catch: (cause) => new Network({ message: "Content bridge request failed", cause }),
  }).pipe(
    Effect.flatMap(({ response, payload }) => {
      if (!response.ok) {
        try {
          const failure = S.decodeUnknownSync(ContentBridgeFailureSchema)(payload, {
            onExcessProperty: "error",
          });
          return Effect.fail(failureFromTag(failure.error.tag));
        } catch {
          return Effect.fail(new ContentDecodeError());
        }
      }
      return S.decodeUnknownEffect(schema)(payload, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new ContentDecodeError()));
    }),
  );

export const createBrowserContentWorkspaceClient = (): ContentWorkspaceClient => ({
  admin: {
    content: {
      workspace: () => request(ContentWorkspaceBootstrapSchema, "/content", "GET"),
      readArticle: (articleId) =>
        request(ContentArticleDetailSchema, "/content", "POST", {
          operation: "readArticle",
          articleId,
        }),
      createDraft: (command) =>
        request(CreateArticleDraftObservationSchema, "/content", "POST", {
          operation: "createDraft",
          ...command,
        }),
      reviseDraft: (command) =>
        request(ReviseArticleDraftObservationSchema, "/content", "POST", {
          operation: "reviseDraft",
          ...command,
        }),
      publish: (command) =>
        request(PublishObservationSchema, "/content", "POST", {
          operation: "publish",
          ...command,
        }),
      unpublish: (command) =>
        request(UnpublishObservationSchema, "/content", "POST", {
          operation: "unpublish",
          ...command,
        }),
    },
  },
});
