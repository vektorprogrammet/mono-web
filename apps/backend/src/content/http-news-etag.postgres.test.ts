import { expect, it } from "@effect/vitest";
import { Database } from "@vektorprogrammet/database";
import { ContentLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
} from "@vektorprogrammet/domain/content";
import { Effect, Layer, Schema } from "effect";
import { backendDatabase } from "../../test/database.js";
import { makePublicNewsTestHttp } from "../test/native-http.js";

const articleId = 731;

const slug = "department-link-only";

const oldDepartment = "department-original";

const newDepartment = "department-replacement";

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO person_profiles (person_id, first_name, last_name)
      VALUES ('news-author', 'Ada', 'Editor')
    `;
    yield* sql`
      INSERT INTO organization_departments (department_id, name, short_name, email, city, independent)
      VALUES (${oldDepartment}, 'Original', 'OLD', 'old@example.invalid', 'Oslo', TRUE),
        (${newDepartment}, 'Replacement', 'NEW', 'new@example.invalid', 'Bergen', TRUE)
    `;
    yield* sql`
      INSERT INTO content_articles (article_id, title, slug, body_html, created_by_person_id)
      OVERRIDING SYSTEM VALUE VALUES
        (${articleId}, 'Department link', ${slug}, '<p>Published text</p>', 'news-author')
    `;
    yield* sql`
      INSERT INTO content_article_versions (
        article_id, version_number, title, slug, body_html, sticky,
        published_at, published_by_person_id
      ) VALUES (
        ${articleId}, 1, 'Department link', ${slug}, '<p>Published text</p>', FALSE,
        '2025-01-01T00:00:00.000Z', 'news-author'
      )
    `;
    yield* sql`UPDATE content_articles SET current_version_number = 1 WHERE article_id = ${articleId}`;
    yield* sql`
      INSERT INTO content_article_departments (article_id, department_id)
      VALUES (${articleId}, ${oldDepartment})
    `;
  }),
);

const fixture = () => {
  const database = backendDatabase(seed);

  const services = ContentLive.pipe(
    Layer.provideMerge(
      ProfileLive.pipe(
        Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(database.layer))),
      ),
    ),
  );

  const http = makePublicNewsTestHttp(services);

  const read = (path: string, ifNoneMatch?: string) =>
    Effect.gen(function* () {
      const response = yield* http.fetch(
        new Request(`http://backend.test${path}`, {
          headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
        }),
      );

      return {
        status: response.status,
        etag: response.headers.get("etag"),
        body: yield* Effect.promise(() => response.text()),
      };
    });

  const publishedMetadata = database.run(
    Database.use(
      (sql) =>
        sql`
        SELECT article.current_version_number, article.updated_at,
          version.version_number, version.title, version.body_html, version.published_at,
          author.revision AS author_revision
        FROM content_articles AS article
        JOIN content_article_versions AS version
          ON version.article_id = article.article_id
         AND version.version_number = article.current_version_number
        JOIN person_profiles AS author ON author.person_id = article.created_by_person_id
        WHERE article.article_id = ${articleId}
      `,
    ),
  );

  const relink = database.run(
    Database.use(
      (sql) =>
        sql`
        UPDATE content_article_departments SET department_id = ${newDepartment}
        WHERE article_id = ${articleId} AND department_id = ${oldDepartment}
      `,
    ),
  );

  return { read, publishedMetadata, relink };
};

const listing = Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedNewsListingSchema));

const article = Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedNewsArticleSchema));

it.live("changes both public news validators when only the department link changes", () =>
  Effect.gen(function* () {
    const { read, publishedMetadata, relink } = fixture();
    const listingPath = "/api/news";
    const articlePath = `/api/news/${slug}`;

    const before = {
      listing: yield* read(listingPath),
      article: yield* read(articlePath),
    };

    expect([before.listing.status, before.article.status]).toEqual([200, 200]);

    const originalListing = yield* listing(before.listing.body);
    const originalArticle = yield* article(before.article.body);

    expect(originalListing.articles.map((item) => item.departmentIds)).toEqual([[oldDepartment]]);
    expect(originalArticle.departmentIds).toEqual([oldDepartment]);
    expect(before.listing.etag).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(before.article.etag).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);

    const unchanged = {
      listing: yield* read(listingPath, before.listing.etag!),
      article: yield* read(articlePath, before.article.etag!),
    };

    expect(unchanged).toEqual({
      listing: { status: 304, etag: before.listing.etag, body: "" },
      article: { status: 304, etag: before.article.etag, body: "" },
    });

    // The department-link trigger increments article.revision; the published version stays fixed.
    const metadata = yield* publishedMetadata;
    yield* relink;
    expect(yield* publishedMetadata).toEqual(metadata);

    const after = {
      listing: yield* read(listingPath, before.listing.etag!),
      article: yield* read(articlePath, before.article.etag!),
    };

    // Keep both responses in the red failure: status, ETag and body of the original and stale read.
    const evidence = [
      `before listing: ${before.listing.status} ${before.listing.etag} ${before.listing.body}`,
      `before article: ${before.article.status} ${before.article.etag} ${before.article.body}`,
      `after listing: ${after.listing.status} ${after.listing.etag} ${after.listing.body}`,
      `after article: ${after.article.status} ${after.article.etag} ${after.article.body}`,
    ].join("\n");

    expect([after.listing.status, after.article.status], evidence).toEqual([200, 200]);
    expect(after.listing.etag).not.toBe(before.listing.etag);
    expect(after.article.etag).not.toBe(before.article.etag);

    const updatedListing = yield* listing(after.listing.body);
    const updatedArticle = yield* article(after.article.body);

    expect(updatedListing.articles).toEqual([
      { ...originalListing.articles[0], departmentIds: [newDepartment] },
    ]);
    expect(updatedArticle).toEqual({ ...originalArticle, departmentIds: [newDepartment] });

    expect(yield* read(listingPath, after.listing.etag!)).toEqual({
      status: 304,
      etag: after.listing.etag,
      body: "",
    });
    expect(yield* read(articlePath, after.article.etag!)).toEqual({
      status: 304,
      etag: after.article.etag,
      body: "",
    });
  }),
);
