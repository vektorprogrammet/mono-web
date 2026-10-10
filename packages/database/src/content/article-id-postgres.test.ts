import { types } from "@electric-sql/pglite";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  ArticleId,
  ContentCommandId,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  ReviseArticleDraftInputSchema,
} from "@vektorprogrammet/domain/content";
import {
  DepartmentId,
  OrganizationAuthorityInstantSchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailPostgres,
  readContentArticleHttpSourcePostgres,
  readPublishedNewsArticleHttpSourcePostgres,
  readPublishedNewsCollectionHttpSourcesPostgres,
  readWorkspacePostgres,
  reviseDraftPostgres,
} from "./postgres.js";

/**
 * The native driver decodes every int8 as a bigint, where PGlite narrows a safe int8 to a number.
 * This layer reproduces the driver, so an id read that the SQL does not project as text fails here
 * as it fails on PostgreSQL. The article ids of these tests exceed integer: the check constraint of
 * the column admits every safe integer, so `CAST(article_id AS integer)` would fail on them.
 */
const nativeInt8Layer = ProfileLive.pipe(
  Layer.provideMerge(
    OrganizationLive.pipe(
      Layer.provideMerge(
        DatabaseTestLive({ parsers: { [types.INT8]: (value: string) => BigInt(value) } }),
      ),
    ),
  ),
);

const administratorId = PersonId.make("big-id-administrator");

const departmentId = DepartmentId.make("department-big-id");

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2030-01-01T00:00:00.000Z");

/** The first id above integer. */
const bigId = ArticleId.make(2 ** 31);

const seed = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`
    INSERT INTO person_profiles (person_id, first_name, last_name)
    VALUES (${administratorId}, 'Ada', 'Administrator')
  `;
  yield* sql`
    INSERT INTO organization_departments (department_id, name, short_name, email, city, independent)
    VALUES (${departmentId}, 'Big Id Department', 'BIG', 'big@example.invalid', 'Oslo', TRUE)
  `;
  yield* sql`
    INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at)
    VALUES ('big-id-administrator-grant', ${administratorId}, '2028-01-01T00:00:00.000Z')
  `;
});

const reset = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`
    TRUNCATE content_publication_audit, content_publication_command_receipts,
      content_article_departments, content_article_versions, content_articles RESTART IDENTITY
  `;
  yield* sql`
    INSERT INTO content_articles (
      article_id, title, slug, body_html, sticky, created_by_person_id,
      created_at, updated_at, revision
    ) OVERRIDING SYSTEM VALUE VALUES (
      ${bigId}, 'Big id draft', 'big-id-draft', '<p>Body</p>', FALSE,
      ${administratorId}, '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z', 0
    )
  `;
  yield* sql`
    INSERT INTO content_article_departments (article_id, department_id)
    VALUES (${bigId}, ${departmentId})
  `;
});

const actor = { personId: administratorId, authorizationInstant };

layer(Layer.effectDiscard(seed).pipe(Layer.provideMerge(nativeInt8Layer)), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("content article ids above integer under the native int8 codec", (it) => {
  it.effect("lists the workspace draft and reads its detail", () =>
    Effect.gen(function* () {
      yield* reset;

      const workspace = yield* readWorkspacePostgres({ ...actor, query: {} });
      const detail = yield* readArticleDetailPostgres({ ...actor, articleId: bigId });

      expect(workspace.entries.map((entry) => entry.articleId)).toEqual([bigId]);
      expect(detail.articleId).toBe(bigId);
      expect(detail.departmentIds).toEqual([departmentId]);
    }),
  );

  it.effect("locks, revises, and publishes the draft", () =>
    Effect.gen(function* () {
      yield* reset;

      const before = yield* readArticleDetailPostgres({ ...actor, articleId: bigId });

      const revised = yield* reviseDraftPostgres({
        ...actor,
        command: ReviseArticleDraftInputSchema.make({
          commandId: ContentCommandId.make("big-id-revise"),
          articleId: bigId,
          expectedRevision: before.revision,
          title: "Big id revised",
          bodyHtml: "<p>Revised</p>",
          departmentIds: [departmentId],
        }),
      });

      const published = yield* publishPostgres({
        ...actor,
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make("big-id-publish"),
          articleId: bigId,
        }),
      });

      expect(revised.articleId).toBe(bigId);
      expect(published.articleId).toBe(bigId);
      expect(published.versionNumber).toBe(1);
    }),
  );

  it.effect("reads the HTTP sources of the published article", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* publishPostgres({
        ...actor,
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make("big-id-publish-source"),
          articleId: bigId,
        }),
      });

      const staff = yield* readContentArticleHttpSourcePostgres(bigId);
      const collection = yield* readPublishedNewsCollectionHttpSourcesPostgres();
      const article = yield* readPublishedNewsArticleHttpSourcePostgres("big-id-draft");

      expect(staff.articleId).toBe(bigId);
      expect(collection.map((source) => source.articleId)).toEqual([bigId]);
      expect(article.articleId).toBe(bigId);
    }),
  );

  it.effect("creates a draft whose generated id exceeds integer", () =>
    Effect.gen(function* () {
      yield* reset;

      const sql = yield* Database;
      yield* sql`SELECT setval(pg_get_serial_sequence('content_articles', 'article_id'), ${2 ** 32})`;

      const created = yield* createDraftPostgres({
        ...actor,
        command: CreateArticleDraftInputSchema.make({
          commandId: ContentCommandId.make("big-id-create"),
          title: "Generated big id",
          bodyHtml: "<p>Generated</p>",
          departmentIds: [departmentId],
          sticky: false,
        }),
      });

      expect(created.articleId).toBe(2 ** 32 + 1);
    }),
  );
});
