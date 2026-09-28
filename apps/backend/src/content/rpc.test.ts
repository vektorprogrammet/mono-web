import { describe, expect, it } from "@effect/vitest";
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  ARTICLE_SLUG_MAX_LENGTH,
  ArticleId,
  ArticleSlug,
  Content,
  ContentArticleNotFound,
  ContentDepartmentNotFound,
  ContentIntegrityError,
  ContentManagement,
  ContentPersistenceError,
  type ContentManagementFailure,
} from "@vektorprogrammet/domain/content";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Exit, Layer, Option } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const staffPerson = PersonId.make("content-staff");

const cookie = { cookie: "better-auth.session_token=content-staff" };

const actor = IdentityActor.make({
  personId: staffPerson,
  sessionId: "content-staff-session",
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
});

/** An identity engine that resolves sessions with `resolveSession` and does nothing else. */
const identityOf = (resolveSession: IdentityOperations["resolveSession"]) =>
  Identity.of({
    signIn: () => Effect.die("unexpected sign-in"),
    resolveSession,
    readCurrentSession: () => Effect.die("unexpected session read"),
    listSessions: () => Effect.die("unexpected session list"),
    revokeCurrentSession: () => Effect.die("unexpected session mutation"),
    revokeSession: () => Effect.die("unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected session mutation"),
    revokeAllSessions: () => Effect.die("unexpected session mutation"),
    recordSecurityEvent: () => Effect.die("unexpected identity audit"),
    signOut: () => Effect.succeed({ setCookies: [] }),
  } satisfies IdentityOperations);

const staffSession = (cookieHeader: string | undefined) =>
  cookieHeader?.includes("content-staff") === true
    ? Effect.succeed(actor)
    : Effect.fail(IdentitySessionNotFound.make());

/** The staff person's session, in and outside a transaction, and no OAuth bearer. */
const security = Layer.mergeAll(
  Layer.succeed(Identity, identityOf(staffSession)),
  Layer.mock(IdentitySnapshot, { resolveSession: staffSession }),
  Layer.succeed(
    OAuthCredentialAuthority,
    OAuthCredentialAuthority.of({
      resolve: () => Effect.die("unexpected OAuth credential resolution"),
      resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
    }),
  ),
);

const globalAdministrator = (personId: PersonId, evaluatedAt: string) =>
  Effect.succeed({
    personId,
    evaluatedAt,
    globalAdministrator: "Active" as const,
    memberships: [],
    nationalBoardSeats: [],
    delegations: [],
  });

/** One content administrator, whose Organization projection is mocked. */
const administrator = Layer.merge(
  security,
  Layer.mock(Organization, {
    resolvePersonAuthority: globalAdministrator,
    resolvePersonAuthorityForRead: globalAdministrator,
  }),
);

const backendOver = (services: Layer.Layer<never>) =>
  makeBackendTestRpc({ config: backendTestConfig, services }).client;

/** The problem code of a failed call, or `ok`. */
const codeOf = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => (isProblem(error) ? error.code : "defect"),
      });

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

const staleETag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

describe("content RPC failures", () => {
  it.live("answers owned domain failures with the problems their operations declare", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly ["readArticle" | "readContentWorkspace", ContentManagementFailure, string]
      > = [
        ["readArticle", ContentArticleNotFound.make({}), "content.article-not-found"],
        [
          "readArticle",
          ContentIntegrityError.make({ operation: "read", message: "missing author" }),
          "content.integrity-error",
        ],
        [
          "readArticle",
          ContentPersistenceError.make({ operation: "read", message: "database unavailable" }),
          "content.unavailable",
        ],
        [
          "readContentWorkspace",
          ContentDepartmentNotFound.make({ departmentId: DepartmentId.make("department-1") }),
          "content.department-not-found",
        ],
      ];

      for (const [operation, failure, code] of cases) {
        const client = yield* backendOver(
          Layer.merge(
            administrator,
            Layer.mock(ContentManagement, {
              readArticleDetail: () => Effect.fail(failure),
              readWorkspace: () => Effect.fail(failure),
            }),
          ),
        );

        const answered =
          operation === "readArticle"
            ? codeOf(
                yield* Effect.exit(
                  client["content.readArticle"]({ articleId: ArticleId.make(1) }),
                ).pipe(RpcClient.withHeaders(cookie)),
              )
            : codeOf(
                yield* Effect.exit(
                  client["content.readContentWorkspace"]({
                    departmentId: DepartmentId.make("department-1"),
                  }),
                ).pipe(RpcClient.withHeaders(cookie)),
              );

        expect([operation, answered]).toEqual([operation, code]);
      }
    }),
  );

  it.live("answers a slug conflict from inside the create transaction", () =>
    Effect.gen(function* () {
      const client = yield* backendOver(administrator);

      const exit = yield* Effect.exit(
        client["content.createArticle"]({
          idempotencyKey: key("content-create-slug-conflict"),
          // The title leaves no letter or digit to build a slug from.
          request: { title: "!!!", bodyHtml: "<p>Tekst</p>", departmentIds: [] },
        }),
      ).pipe(RpcClient.withHeaders(cookie));

      expect(codeOf(exit)).toBe("content.slug-conflict");
    }),
  );

  it.live("reads a news article by a slug of the maximum length", () =>
    Effect.gen(function* () {
      const slug = "a".repeat(ARTICLE_SLUG_MAX_LENGTH);
      const reads: Array<string> = [];

      const client = yield* backendOver(
        Layer.mock(Content, {
          readPublishedArticle: (requested) => {
            reads.push(requested);

            return Effect.fail(ContentArticleNotFound.make({}));
          },
        }),
      );

      const exit = yield* Effect.exit(
        client["content.readNewsArticle"]({ slug: ArticleSlug.make(slug) }),
      );

      expect(codeOf(exit)).toBe("content.article-not-found");
      expect(reads).toEqual([slug]);
    }),
  );

  it.live("answers a person rejected after the middleware from the credential presented", () =>
    Effect.gen(function* () {
      let calls = 0;

      // The middleware admits the session; the handler's own resolution then rejects it.
      const flaky: IdentityOperations["resolveSession"] = (cookieHeader) => {
        calls += 1;

        return calls === 1
          ? staffSession(cookieHeader)
          : Effect.fail(IdentitySessionNotFound.make());
      };

      const client = yield* backendOver(Layer.succeed(Identity, identityOf(flaky)));

      const rejected = yield* Effect.exit(client["content.readContentWorkspace"]({})).pipe(
        RpcClient.withHeaders(cookie),
      );

      const anonymous = yield* Effect.exit(client["content.readContentWorkspace"]({}));

      expect([codeOf(rejected), codeOf(anonymous), calls]).toEqual([
        "credential.invalid",
        "credential.missing",
        2,
      ]);
    }),
  );
});

describe("content RPC journey on PostgreSQL", () => {
  const seed = Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${staffPerson}, 'Kari', 'Penerbit')`;
      yield* sql`INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at) VALUES ('content-admin-grant', ${staffPerson}, '2020-01-01T00:00:00.000Z')`;
    }),
  );

  const backend = () => {
    const database = backendDatabase(seed);
    const organization = OrganizationLive.pipe(Layer.provide(database.layer));
    const profile = ProfileLive.pipe(Layer.provide(Layer.merge(database.layer, organization)));

    return backendOver(
      Layer.mergeAll(
        database.layer,
        security,
        organization,
        profile,
        ContentManagementLive.pipe(Layer.provide(database.layer)),
        ContentLive.pipe(Layer.provide(Layer.mergeAll(database.layer, organization, profile))),
      ),
    );
  };

  it.live("drafts, revises, publishes, and unpublishes under entity tags, replaying by key", () =>
    Effect.gen(function* () {
      const client = yield* backend();
      const as = RpcClient.withHeaders(cookie);

      const createRequest = {
        title: "Opptak til høsten",
        bodyHtml: "<p>Søk nå.</p>",
        departmentIds: [],
      };

      const created = yield* client["content.createArticle"]({
        idempotencyKey: key("content-create"),
        request: createRequest,
      }).pipe(as);

      const replayed = yield* client["content.createArticle"]({
        idempotencyKey: key("content-create"),
        request: createRequest,
      }).pipe(as);

      expect(replayed).toEqual(created);
      expect(created.article.status).toBe("Draft");

      const conflicting = yield* Effect.exit(
        client["content.createArticle"]({
          idempotencyKey: key("content-create"),
          request: { ...createRequest, title: "Et annet opptak" },
        }),
      ).pipe(as);

      expect(codeOf(conflicting)).toBe("idempotency.digest-conflict");

      const { articleId } = created.article;
      const read = yield* client["content.readArticle"]({ articleId }).pipe(as);

      expect(read).toEqual(created);

      const revise = (
        idempotencyKey: IdempotencyKey,
        ifMatch: StrongETag,
        request: Parameters<(typeof client)["content.reviseArticle"]>[0]["request"],
      ) =>
        client["content.reviseArticle"]({ articleId, idempotencyKey, ifMatch, request }).pipe(as);

      expect(codeOf(yield* Effect.exit(revise(key("no-change"), read.etag, {})))).toBe(
        "validation.no-change",
      );
      expect(
        codeOf(yield* Effect.exit(revise(key("delete-title"), read.etag, { title: null }))),
      ).toBe("validation.field-not-deletable");
      expect(
        codeOf(yield* Effect.exit(revise(key("stale"), staleETag, { bodyHtml: "<p>Nå.</p>" }))),
      ).toBe("precondition.failed");

      const revised = yield* revise(key("revise"), read.etag, { bodyHtml: "<p>Søk i dag.</p>" });

      expect(revised.article.bodyHtml).toBe("<p>Søk i dag.</p>");
      expect(revised.article.title).toBe(createRequest.title);
      expect(revised.etag).not.toBe(read.etag);
      expect(yield* revise(key("revise"), read.etag, { bodyHtml: "<p>Søk i dag.</p>" })).toEqual(
        revised,
      );

      const transition = { articleId, ifMatch: revised.etag };

      expect(
        codeOf(
          yield* Effect.exit(
            client["content.publishArticle"]({
              ...transition,
              idempotencyKey: key("publish-stale"),
              ifMatch: read.etag,
            }).pipe(as),
          ),
        ),
      ).toBe("precondition.failed");

      const published = yield* client["content.publishArticle"]({
        ...transition,
        idempotencyKey: key("publish"),
      }).pipe(as);

      expect(published.result).toMatchObject({ articleId, versionNumber: 1 });
      expect(
        yield* client["content.publishArticle"]({
          ...transition,
          idempotencyKey: key("publish"),
        }).pipe(as),
      ).toEqual(published);

      const listing = yield* client["content.listNews"]({});
      const news = yield* client["content.readNewsArticle"]({ slug: created.article.slug });

      expect(listing.articles.map((article) => article.slug)).toEqual([created.article.slug]);
      expect(news.bodyHtml).toBe("<p>Søk i dag.</p>");

      const unpublished = yield* client["content.unpublishArticle"]({
        articleId,
        idempotencyKey: key("unpublish"),
        ifMatch: published.etag,
      }).pipe(as);

      expect(unpublished.result).toEqual({ articleId });
      expect((yield* client["content.listNews"]({})).articles).toEqual([]);
      expect((yield* client["content.readArticle"]({ articleId }).pipe(as)).etag).toBe(
        unpublished.etag,
      );
    }),
  );
});
