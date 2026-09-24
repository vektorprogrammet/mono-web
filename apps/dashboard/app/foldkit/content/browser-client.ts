import { ArticleId } from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { ContentArticleObservationSchema, ContentBridgeFailureSchema, ContentCreateCommandSchema, ContentReviseCommandSchema, ContentTransitionCommandSchema, ContentWorkspaceBootstrapSchema, contentBridgeFailure, type ContentArticleObservation, type ContentBridgeFailure, type ContentCreateCommand, type ContentReviseCommand, type ContentTransitionCommand, type ContentWorkspaceBootstrap, ContentBridgeAction } from "./bridge";

export interface ContentWorkspaceOperations {
  readonly readContentWorkspace: () => Effect.Effect<
    ContentWorkspaceBootstrap,
    ContentBridgeFailure
  >;
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

const request = <A>(
  schema: S.Decoder<A, never>,
  url: string,
  method: string,
  body?: ContentBridgeAction,
): Effect.Effect<A, ContentBridgeFailure> =>
  Effect.gen(function* () {
    const headers = new Headers({ accept: "application/json" });

    if (body !== undefined) headers.set("content-type", "application/json");

    const response = yield* Effect.tryPromise({
      try: () => fetch(url, {
        method,
        credentials: "same-origin",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      catch: () => contentBridgeFailure("Network"),
    });

    const payload = yield* Effect.promise(() => response.json().catch(() => null));

    if (!response.ok) {
      const failure = yield* S.decodeUnknownEffect(ContentBridgeFailureSchema)(payload, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => contentBridgeFailure("ContentDecodeError")));

      return yield* Effect.fail(failure);
    }

    return yield* S.decodeUnknownEffect(schema)(payload, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => contentBridgeFailure("ContentDecodeError")));
  });

const transition = (
  bridgeUrl: string,
  command: ContentTransitionCommand,
  operation: "publish" | "unpublish",
) =>
  request(S.Struct({}), bridgeUrl, "POST", {
    operation,
    ...S.encodeSync(ContentTransitionCommandSchema)(command),
  }).pipe(Effect.asVoid);

export const createBrowserContentWorkspaceClient = (bridgeUrl: string): ContentWorkspaceClient => ({
  content: {
    readContentWorkspace: () => request(ContentWorkspaceBootstrapSchema, bridgeUrl, "GET"),
    readArticle: ({ articleId }) =>
      request(ContentArticleObservationSchema, bridgeUrl, "POST", {
        operation: "readArticle",
        articleId,
      }),
    createArticle: (command) =>
      request(ContentArticleObservationSchema, bridgeUrl, "POST", {
        operation: "createDraft",
        ...S.encodeSync(ContentCreateCommandSchema)(command),
      }),
    reviseArticle: (command) =>
      request(ContentArticleObservationSchema, bridgeUrl, "POST", {
        operation: "reviseDraft",
        ...S.encodeSync(ContentReviseCommandSchema)(command),
      }),
    publishArticle: (command) => transition(bridgeUrl, command, "publish"),
    unpublishArticle: (command) => transition(bridgeUrl, command, "unpublish"),
  },
});
