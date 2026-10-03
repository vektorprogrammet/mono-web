import { expect, it } from "@effect/vitest";
import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { ContentManagementLive } from "@vektorprogrammet/database/content";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { ContentArticleDetailSchema } from "@vektorprogrammet/domain/content";
import { IdentityActor } from "@vektorprogrammet/domain/identity";
import { Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { ContentApi, RequestSchemaErrorMiddleware } from "@vektorprogrammet/http-api";
import { NativeProblem, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { DateTime, Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { backendDatabase } from "../../test/database.js";
import { ContentApiHandlers as GeneratedContentApiHandlers } from "../../.effx/generated/content-handlers.js";
import { jsonText } from "../http-api/problem.js";
import { NativeHttpApiMiddlewareLive } from "../http-api/transport.js";
import { makeContentManagementTestHttp, testFetch } from "../test/native-http.js";
import { contentGuards, makeContentRawHandlers } from "./http.js";

const personId = PersonId.make("content-replay-editor");

it.live(
  "revoked authority and a generated guard both reject an exact committed Content replay",
  () =>
    Effect.gen(function* () {
      let active = true;

      const database = backendDatabase(
        Database.use((sql) =>
          sql`INSERT INTO person_profiles (person_id, first_name, last_name)
            VALUES (${personId}, 'Kari', 'Editor')`.pipe(Effect.asVoid),
        ),
      );

      const organization = Layer.mock(Organization, {
        resolvePersonAuthority: (requested, evaluatedAt) =>
          Effect.succeed({
            personId: requested,
            evaluatedAt,
            globalAdministrator: active ? ("Active" as const) : ("Inactive" as const),
            memberships: [],
            nationalBoardSeats: [],
            delegations: [],
          }),
        resolvePersonAuthorityForRead: (requested, evaluatedAt) =>
          Effect.succeed({
            personId: requested,
            evaluatedAt,
            globalAdministrator: active ? ("Active" as const) : ("Inactive" as const),
            memberships: [],
            nationalBoardSeats: [],
            delegations: [],
          }),
      });

      const identity = Layer.mock(IdentitySnapshot, {
        resolveSession: () =>
          Effect.succeed(
            new IdentityActor({
              personId,
              sessionId: "content-replay-session",
              expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
            }),
          ),
      });

      const services = Layer.mergeAll(
        database.layer,
        organization,
        identity,
        ContentManagementLive.pipe(Layer.provide(database.layer)),
        ProfileLive.pipe(Layer.provide(Layer.merge(database.layer, organization))),
      );

      const body = yield* jsonText({
        title: "Replay authorization",
        bodyHtml: "<p>Original published work.</p>",
        departmentIds: [],
      });

      const request = () =>
        new Request("http://backend.test/api/content/articles", {
          method: "POST",
          headers: {
            cookie: "better-auth.session_token=content-replay-editor",
            origin: "http://127.0.0.1:5174",
            "content-type": "application/json",
            "idempotency-key": "content-replay-authorization-000001",
          },
          body,
        });

      const live = makeContentManagementTestHttp(
        () => Effect.succeed({ personId, authorizationInstant: "2030-01-01T00:00:00.000Z" }),
        services,
      );

      const committed = yield* live.fetch(request());
      expect(committed.status).toBe(201);

      const detail = yield* Schema.decodeUnknownEffect(ContentArticleDetailSchema)(
        yield* Effect.promise(() => committed.json()),
      );

      expect(detail.title).toBe("Replay authorization");

      active = false;
      const revoked = yield* live.fetch(request());
      expect(revoked.status).toBe(403);
      expect(
        (yield* Schema.decodeUnknownEffect(NativeProblem)(
          yield* Effect.promise(() => revoked.json()),
        )).code,
      ).toBe("authority.denied");

      active = true;
      const seen: Array<string> = [];

      const guards = {
        ...contentGuards,
        "content.createArticle": () =>
          Effect.sync(() => {
            seen.push("content.createArticle");
          }).pipe(Effect.andThen(Effect.fail(Problem.make("authority.denied")))),
      };

      const probed = testFetch(
        HttpApiBuilder.layer(
          HttpApi.make("external-native-api")
            .add(ContentApi)
            .middleware(RequestSchemaErrorMiddleware),
        ).pipe(
          Layer.provide(
            GeneratedContentApiHandlers({
              raw: makeContentRawHandlers(
                () => Effect.die("unexpected staff read"),
                1_048_576,
                guards,
              ),
              guards,
            }),
          ),
          Layer.provide(NativeHttpApiMiddlewareLive),
        ),
        services,
      );

      const denied = yield* probed(request());
      expect(denied.status).toBe(403);
      expect(
        (yield* Schema.decodeUnknownEffect(NativeProblem)(
          yield* Effect.promise(() => denied.json()),
        )).code,
      ).toBe("authority.denied");
      expect(seen).toEqual(["content.createArticle"]);

      const rows = yield* database.run(
        Database.use(
          (sql) =>
            sql<{ readonly total: number }>`
        SELECT count(*)::integer AS total FROM native_http_idempotency_receipts
        WHERE operation_id = 'content.createArticle'
      `,
        ),
      );

      expect(rows).toEqual([{ total: 1 }]);
    }),
);
