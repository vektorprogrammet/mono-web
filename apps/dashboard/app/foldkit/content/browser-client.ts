import {
  ContentArticleNotFound,
  ContentAuthorityInactive,
  ContentCommandConflict,
  ContentDecodeError,
  ContentDraftNotOwned,
  ContentIntegritySdkError,
  ContentNotInScope,
  ContentNotPublisher,
  ContentPersistenceSdkError,
  ContentSlugConflictSdkError,
  ContentUnauthenticatedActor,
  ContentWorkspaceSchema,
  type ContentWorkspace,
  type CreateContentDraftCommand,
  type InternalSdkError,
  type PublicationTransitionCommand,
  type ReviseContentDraftCommand,
} from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";

export interface ContentWorkspaceOperations {
  readonly workspace: () => Effect.Effect<ContentWorkspace, InternalSdkError>;
  readonly createDraft: (
    command: CreateContentDraftCommand,
  ) => Effect.Effect<ContentWorkspace, InternalSdkError>;
  readonly reviseDraft: (
    command: ReviseContentDraftCommand,
  ) => Effect.Effect<ContentWorkspace, InternalSdkError>;
  readonly publish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<ContentWorkspace, InternalSdkError>;
  readonly unpublish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<ContentWorkspace, InternalSdkError>;
}

export interface ContentWorkspaceClient {
  readonly admin: {
    readonly content: ContentWorkspaceOperations;
  };
}

/**
 * Maps the bridge's `{ error: { tag } }` body onto the SDK's own typed
 * internal errors so downstream failureFrom() can read `contentTag`/`_tag`.
 */
const failureFromTag = (tag: string): InternalSdkError => {
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
    case "ContentIntegrityError":
      return new ContentIntegritySdkError();
    case "ContentPersistenceError":
      return new ContentPersistenceSdkError();
    default:
      return new ContentDecodeError();
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
  url: string,
  method: string,
  body?: unknown,
): Effect.Effect<A, InternalSdkError> =>
  Effect.tryPromise({
    try: () => readBridge(url, method, body),
    catch: () => failureFromTag("Network"),
  }).pipe(
    Effect.flatMap(({ response, payload }) =>
      response.ok ? Effect.succeed(payload as A) : Effect.fail(failureFromTag(readTag(payload))),
    ),
  );

const readTag = (payload: unknown): string => {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { readonly error: unknown }).error;
    if (typeof error === "object" && error !== null && "tag" in error) {
      return String((error as { readonly tag: unknown }).tag);
    }
  }
  return "ContentPersistenceError";
};

export const createBrowserContentWorkspaceClient = (): ContentWorkspaceClient => ({
  admin: {
    content: {
      workspace: () =>
        request("/content", "GET").pipe(
          Effect.flatMap((payload) =>
            S.decodeUnknownEffect(ContentWorkspaceSchema)(payload, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(() => failureFromTag("ContentDecodeError"))),
          ),
        ),
      createDraft: (command) => request("/content", "POST", command),
      reviseDraft: (command) =>
        request("/content", "POST", { operation: "reviseDraft", ...command }),
      publish: (command) => request("/content", "POST", { operation: "publish", ...command }),
      unpublish: (command) => request("/content", "POST", { operation: "unpublish", ...command }),
    },
  },
});
