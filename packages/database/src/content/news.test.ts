import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { readNewsListingPostgres, readPublishedArticlePostgres } from "./news.js";

const runtime = makeControlledTestRuntime(
  ProfileLive.pipe(
    Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
  ),
);

beforeAll(
  () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* Database;
        yield* sql`
      INSERT INTO person_profiles (person_id, first_name, last_name)
      VALUES ('person-creator', 'Article', 'Creator'), ('person-publisher', 'Different', 'Publisher')
    `;
        yield* sql`
      INSERT INTO content_articles (
        title, slug, body_html, created_by_person_id, current_version_number
      ) VALUES ('Creator attribution', 'creator-attribution', '<p>new body</p>', 'person-creator', 3)
    `;
        yield* sql`
      INSERT INTO content_article_versions (
        article_id, version_number, title, slug, body_html, sticky, published_at, published_by_person_id
      ) SELECT article.article_id, version.number, article.title, article.slug, version.body, FALSE,
        version.published_at::timestamptz, 'person-publisher'
      FROM content_articles AS article
      CROSS JOIN (VALUES
        (1, '<p>old body</p>', '2029-12-01T00:00:00.000Z'),
        (2, '<p>body</p>', '2030-01-01T00:00:00.000Z'),
        (3, '<p>new body</p>', '2030-02-01T00:00:00.000Z')
      ) AS version(number, body, published_at)
    `;
      }),
    ),
  15_000,
);

afterAll(() => runtime.dispose());

describe("public news author attribution", () => {
  it("uses the article creator in listings even when another person published", async () => {
    const listing = await runtime.runPromise(readNewsListingPostgres());

    expect(
      listing.articles.map((article) => ({
        slug: article.slug,
        authorDisplayName: article.authorDisplayName,
      })),
    ).toEqual([{ slug: "creator-attribution", authorDisplayName: "Article Creator" }]);
  });

  it("links only older published versions for every selected detail version", async () => {
    for (const testCase of [
      { versionNumber: 1, bodyHtml: "<p>old body</p>", previousVersions: [] },
      {
        versionNumber: 2,
        bodyHtml: "<p>body</p>",
        previousVersions: [
          {
            versionNumber: 1,
            publishedAt: "2029-12-01T00:00:00.000Z",
            urlPath: "/nyhet/creator-attribution?versjon=1",
          },
        ],
      },
      {
        versionNumber: 3,
        bodyHtml: "<p>new body</p>",
        previousVersions: [
          {
            versionNumber: 2,
            publishedAt: "2030-01-01T00:00:00.000Z",
            urlPath: "/nyhet/creator-attribution?versjon=2",
          },
          {
            versionNumber: 1,
            publishedAt: "2029-12-01T00:00:00.000Z",
            urlPath: "/nyhet/creator-attribution?versjon=1",
          },
        ],
      },
    ]) {
      const article = await runtime.runPromise(
        readPublishedArticlePostgres("creator-attribution", testCase.versionNumber),
      );

      expect(article.authorDisplayName).toBe("Article Creator");
      expect(article.bodyHtml).toBe(testCase.bodyHtml);
      expect(article.previousVersions).toEqual(testCase.previousVersions);
    }
  });
});
