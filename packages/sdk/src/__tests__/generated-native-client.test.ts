import {
  ApproveReceiptEndpoint,
  ContentArticleDetailSchema,
  CreateArticleEndpoint,
  CreateArticleRequest,
  IdempotencyKey,
  isProblem,
  PersonSecurity,
  Problem,
  PublishArticleEndpoint,
  ReadArticleEndpoint,
  ReadContentWorkspaceEndpoint,
  ReadSessionEndpoint,
  ReceiptId,
  ReviseArticleEndpoint,
  SessionResponse,
  SessionSecurity,
  StrongETag,
  UnpublishArticleEndpoint,
} from "@vektorprogrammet/http-api";
import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { Array, Effect, Layer, Order, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { createEffectClient, type FetchCapability } from "../effect-client.js";
import { createPromiseClient, type PromiseSdk } from "../promise.js";

const idempotencyKey = IdempotencyKey.make("AAAAAAAAAAAAAAAAAAAAAA");

const etag = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');

const sessionCookie = "better-auth.session_token=sdk-session";

/**
 * Serves `app`, built from the contract's endpoints, as a web handler for the scope of the test,
 * and gives the generated client a Fetch capability that answers through it.
 */
const serveContract = (app: Layer.Layer<never, never, HttpRouter.HttpRouter>) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ dispose }) => Effect.promise(() => dispose()),
  ).pipe(
    Effect.map(
      ({ handler }): FetchCapability =>
        (input, init) =>
          handler(new Request(input, init)),
    ),
  );

/** Passes each request to its handler and records the session cookie that the client presented. */
const recordingSecurity = (cookies: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.mergeAll(
    Layer.succeed(PersonSecurity)(
      PersonSecurity.of({
        cookieHeader: (httpEffect, { credential }) =>
          Ref.update(cookies, Array.append(Redacted.value(credential))).pipe(
            Effect.andThen(httpEffect),
          ),
        oauthUserBearer: (httpEffect) => httpEffect,
      }),
    ),
    Layer.succeed(SessionSecurity)(
      SessionSecurity.of({
        cookieHeader: (httpEffect, { credential }) =>
          Ref.update(cookies, Array.append(Redacted.value(credential))).pipe(
            Effect.andThen(httpEffect),
          ),
      }),
    ),
  );

describe("generated NativeApi client", () => {
  it("accepts the complete command union through one Promise endpoint", () => {
    // The union payload type-checks through the patched HttpApiEndpoint.ClientRequest of
    // patches/effect@4.0.0-rc.116.patch, exception EX-0010 of docs/effect-exceptions.json.
    type Request = Parameters<PromiseSdk["placements"]["commandBoard"]>[0];

    expectTypeOf<{
      query: Request["query"];
      headers: Request["headers"];
      payload: Request["payload"];
    }>().toExtend<Request>();
  });

  it.effect(
    "sends an action path, its reflected headers, and the session cookie to the contract",
    () =>
      Effect.gen(function* () {
        const cookies = yield* Ref.make<ReadonlyArray<string>>([]);

        const approvals = yield* Ref.make<
          ReadonlyArray<{
            readonly receiptId: string;
            readonly idempotencyKey: string;
            readonly ifMatch: string;
          }>
        >([]);

        const api = HttpApi.make("sdk-receipt-approval").add(
          HttpApiGroup.make("receipts").add(ApproveReceiptEndpoint),
        );

        const handlers = HttpApiBuilder.group(api, "receipts", (group) =>
          group.handle("approveReceipt", ({ params, headers }) =>
            Ref.update(
              approvals,
              Array.append({
                receiptId: params.receiptId,
                idempotencyKey: headers["idempotency-key"],
                ifMatch: headers["if-match"],
              }),
            ).pipe(Effect.andThen(Effect.fail(Problem.make("authority.denied")))),
          ),
        );

        const fetch = yield* serveContract(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provide(recordingSecurity(cookies)),
            Layer.provide(HttpServer.layerServices),
          ),
        );

        const client = createEffectClient("https://api.example.test", {
          cookie: sessionCookie,
          fetch,
        });

        const failure = yield* client.receipts
          .approveReceipt({
            params: { receiptId: ReceiptId.make("receipt-1") },
            headers: { "idempotency-key": idempotencyKey, "if-match": etag },
            payload: {},
          })
          .pipe(Effect.flip);

        assert.isTrue(isProblem(failure) && failure.code === "authority.denied");
        assert.deepStrictEqual(yield* Ref.get(approvals), [
          { receiptId: "receipt-1", idempotencyKey, ifMatch: etag },
        ]);
        assert.deepStrictEqual(yield* Ref.get(cookies), [sessionCookie]);
      }),
  );

  it.effect("decodes the body and declared headers of a private session read", () =>
    Effect.gen(function* () {
      const cookies = yield* Ref.make<ReadonlyArray<string>>([]);

      const session = yield* Schema.decodeEffect(SessionResponse)({
        sessionId: "session-1",
        personId: "person-1",
        createdAt: "2026-09-02T08:00:00.000Z",
        updatedAt: "2026-09-02T08:00:00.000Z",
        expiresAt: "2026-09-09T08:00:00.000Z",
        ipAddress: null,
        userAgent: null,
        current: true,
      });

      const headers = { "cache-control": "private, no-store", vary: "Origin" } as const;

      const api = HttpApi.make("sdk-session").add(
        HttpApiGroup.make("system").add(ReadSessionEndpoint),
      );

      const handlers = HttpApiBuilder.group(api, "system", (group) =>
        group.handle("readSession", () =>
          Effect.succeed(HttpApiSchema.withHeaders({ body: session, headers })),
        ),
      );

      const fetch = yield* serveContract(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(handlers),
          Layer.provide(recordingSecurity(cookies)),
          Layer.provide(HttpServer.layerServices),
        ),
      );

      const result = yield* createEffectClient("https://api.example.test", {
        cookie: sessionCookie,
        fetch,
      }).system.readSession();

      assert.deepStrictEqual(result.body, session);
      assert.deepStrictEqual(result.headers, headers);
      assert.deepStrictEqual(yield* Ref.get(cookies), [sessionCookie]);
    }),
  );
});

describe("generated content SDK", () => {
  type ContentOperation =
    | "readContentWorkspace"
    | "readArticle"
    | "createArticle"
    | "reviseArticle"
    | "publishArticle"
    | "unpublishArticle";

  interface ContentRequest {
    readonly operation: ContentOperation;
    readonly articleId?: number;
    readonly idempotencyKey?: string;
    readonly ifMatch?: string;
    readonly payload?: object;
  }

  const articleId = ContentArticleDetailSchema.fields.articleId.make(7);

  const createPayload = Schema.decodeSync(CreateArticleRequest)({
    title: "Tittel",
    bodyHtml: "<p>Brødtekst</p>",
    departmentIds: ["department-1"],
  });

  it.effect(
    "routes every operation, its mutation headers, and its payload through the contract",
    () =>
      Effect.gen(function* () {
        const cookies = yield* Ref.make<ReadonlyArray<string>>([]);
        const received = yield* Ref.make<ReadonlyArray<ContentRequest>>([]);

        const deny = (request: ContentRequest) =>
          Ref.update(received, Array.append(request)).pipe(
            Effect.andThen(Effect.fail(Problem.make("authority.denied"))),
          );

        const api = HttpApi.make("sdk-content").add(
          HttpApiGroup.make("content").add(
            ReadContentWorkspaceEndpoint,
            ReadArticleEndpoint,
            CreateArticleEndpoint,
            ReviseArticleEndpoint,
            PublishArticleEndpoint,
            UnpublishArticleEndpoint,
          ),
        );

        const handlers = HttpApiBuilder.group(api, "content", (group) =>
          group
            .handle("readContentWorkspace", () => deny({ operation: "readContentWorkspace" }))
            .handle("readArticle", ({ params }) =>
              deny({ operation: "readArticle", articleId: params.articleId }),
            )
            .handle("createArticle", ({ headers, payload }) =>
              deny({
                operation: "createArticle",
                idempotencyKey: headers["idempotency-key"],
                payload,
              }),
            )
            .handle("reviseArticle", ({ params, headers, payload }) =>
              deny({
                operation: "reviseArticle",
                articleId: params.articleId,
                idempotencyKey: headers["idempotency-key"],
                ifMatch: headers["if-match"],
                payload,
              }),
            )
            .handle("publishArticle", ({ params, headers, payload }) =>
              deny({
                operation: "publishArticle",
                articleId: params.articleId,
                idempotencyKey: headers["idempotency-key"],
                ifMatch: headers["if-match"],
                payload,
              }),
            )
            .handle("unpublishArticle", ({ params, headers, payload }) =>
              deny({
                operation: "unpublishArticle",
                articleId: params.articleId,
                idempotencyKey: headers["idempotency-key"],
                ifMatch: headers["if-match"],
                payload,
              }),
            ),
        );

        const fetch = yield* serveContract(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provide(recordingSecurity(cookies)),
            Layer.provide(HttpServer.layerServices),
          ),
        );

        const client = createPromiseClient("http://api.test", { cookie: sessionCookie, fetch });

        const settled = yield* Effect.promise(() =>
          Promise.allSettled([
            client.content.readContentWorkspace({ query: {} }),
            client.content.readArticle({ params: { articleId }, headers: {} }),
            client.content.createArticle({
              headers: { "idempotency-key": idempotencyKey },
              payload: createPayload,
            }),
            client.content.reviseArticle({
              params: { articleId },
              headers: { "idempotency-key": idempotencyKey, "if-match": etag },
              payload: { sticky: false },
            }),
            client.content.publishArticle({
              params: { articleId },
              headers: { "idempotency-key": idempotencyKey, "if-match": etag },
              payload: {},
            }),
            client.content.unpublishArticle({
              params: { articleId },
              headers: { "idempotency-key": idempotencyKey, "if-match": etag },
              payload: {},
            }),
          ]),
        );

        for (const outcome of settled) {
          assert.isTrue(
            outcome.status === "rejected" &&
              isProblem(outcome.reason) &&
              outcome.reason.code === "authority.denied",
          );
        }

        const byOperation = Order.mapInput(
          Order.String,
          (request: ContentRequest) => request.operation,
        );

        assert.deepStrictEqual(Array.sort(yield* Ref.get(received), byOperation), [
          { operation: "createArticle", idempotencyKey, payload: createPayload },
          { operation: "publishArticle", articleId, idempotencyKey, ifMatch: etag, payload: {} },
          { operation: "readArticle", articleId },
          { operation: "readContentWorkspace" },
          {
            operation: "reviseArticle",
            articleId,
            idempotencyKey,
            ifMatch: etag,
            payload: { sticky: false },
          },
          { operation: "unpublishArticle", articleId, idempotencyKey, ifMatch: etag, payload: {} },
        ]);
        assert.deepStrictEqual(yield* Ref.get(cookies), Array.replicate(sessionCookie, 6));
      }),
  );
});
