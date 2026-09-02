import { ArticleId } from "@vektorprogrammet/domain/content";
import { Effect, Schema as S } from "effect";
import {
  ContentArticleObservationSchema,
  ContentBridgeFailureSchema,
  ContentCreateCommandSchema,
  ContentReviseCommandSchema,
  ContentTransitionCommandSchema,
  ContentWorkspaceBootstrapSchema,
  contentBridgeFailure,
  type ContentArticleObservation,
  type ContentBridgeFailure,
  type ContentCreateCommand,
  type ContentReviseCommand,
  type ContentTransitionCommand,
  type ContentWorkspaceBootstrap,
} from "./bridge";

export interface ContentWorkspaceOperations {
  readonly readContentWorkspace: () => Effect.Effect<ContentWorkspaceBootstrap, ContentBridgeFailure>;
  readonly readArticle: (input: {
    readonly articleId: typeof ArticleId.Type;
  }) => Effect.Effect<ContentArticleObservation, ContentBridgeFailure>;
  readonly createArticle: (
    command: ContentCreateCommand,
  ) => Effect.Effect<ContentArticleObservation, ContentBridgeFailure>;
  readonly reviseArticle: (
    command: ContentReviseCommand,
  ) => Effect.Effect<ContentArticleObservation, ContentBridgeFailure>;
  readonly publishArticle: (
    command: ContentTransitionCommand,
  ) => Effect.Effect<void, ContentBridgeFailure>;
  readonly unpublishArticle: (
    command: ContentTransitionCommand,
  ) => Effect.Effect<void, ContentBridgeFailure>;
}

export interface ContentWorkspaceClient {
  readonly content: ContentWorkspaceOperations;
}

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
): Effect.Effect<A, ContentBridgeFailure> =>
  Effect.tryPromise({
    try: () => readBridge(url, method, body),
    catch: () => contentBridgeFailure("Network"),
  }).pipe(
    Effect.flatMap(({ response, payload }) => {
      if (!response.ok) {
        return S.decodeUnknownEffect(ContentBridgeFailureSchema)(payload, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() => contentBridgeFailure("ContentDecodeError")),
          Effect.flatMap(Effect.fail),
        );
      }
      return S.decodeUnknownEffect(schema)(payload, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => contentBridgeFailure("ContentDecodeError")));
    }),
  );

const transition = (command: ContentTransitionCommand, operation: "publish" | "unpublish") =>
  request(S.Struct({}), "/content", "POST", {
    operation,
    ...S.encodeSync(ContentTransitionCommandSchema)(command),
  }).pipe(Effect.asVoid);

export const createBrowserContentWorkspaceClient = (): ContentWorkspaceClient => ({
  content: {
    readContentWorkspace: () => request(ContentWorkspaceBootstrapSchema, "/content", "GET"),
    readArticle: ({ articleId }) =>
      request(ContentArticleObservationSchema, "/content", "POST", {
        operation: "readArticle",
        articleId,
      }),
    createArticle: (command) =>
      request(ContentArticleObservationSchema, "/content", "POST", {
        operation: "createDraft",
        ...S.encodeSync(ContentCreateCommandSchema)(command),
      }),
    reviseArticle: (command) =>
      request(ContentArticleObservationSchema, "/content", "POST", {
        operation: "reviseDraft",
        ...S.encodeSync(ContentReviseCommandSchema)(command),
      }),
    publishArticle: (command) => transition(command, "publish"),
    unpublishArticle: (command) => transition(command, "unpublish"),
  },
});
