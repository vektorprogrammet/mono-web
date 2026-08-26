import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { readNewsListingPostgres, readPublishedArticlePostgres } from "./news.js";

const creatorId = "person-creator";
const publisherId = "person-publisher";
const publishedAt = "2030-01-01T00:00:00.000Z";

const makeDatabase = (rowsFor: (statement: string) => ReadonlyArray<unknown>): DatabaseShape => {
  const sql = ((strings: TemplateStringsArray) =>
    Effect.succeed(rowsFor(strings.join("?")))) as unknown as DatabaseShape;
  return Object.assign(sql, {
    withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program,
    in: () => ({}) as never,
  });
};

const profile = (requested: Array<string>) =>
  ({
    readProfiles: (personIds: ReadonlyArray<string>) => {
      requested.push(...personIds);
      return Effect.succeed([
        {
          personId: creatorId,
          firstName: "Article",
          lastName: "Creator",
          revision: 0,
        },
      ] as never);
    },
  }) as never;

describe("public news author attribution", () => {
  it.effect("uses the article creator in listings even when another person published", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const database = makeDatabase((statement) => {
        if (statement.includes("FROM content_article_versions AS version")) {
          return [
            {
              articleId: 1,
              slug: "creator-attribution",
              title: "Creator attribution",
              sticky: false,
              publishedAt,
              createdByPersonId: creatorId,
              publishedByPersonId: publisherId,
            },
          ];
        }
        if (statement.includes("FROM content_article_departments")) return [];
        return [];
      });

      const listing = yield* readNewsListingPostgres().pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Organization, {} as never),
        Effect.provideService(Profile, profile(requested)),
      );

      expect(requested).toEqual([creatorId]);
      expect(listing.articles[0]?.authorDisplayName).toBe("Article Creator");
    }),
  );

  it.effect("uses the article creator in published detail even for a historical version", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const database = makeDatabase((statement) => {
        if (statement.includes("FROM content_article_versions AS version")) {
          return [
            {
              articleId: 1,
              versionNumber: 2,
              slug: "creator-attribution",
              title: "Creator attribution",
              sticky: false,
              bodyHtml: "<p>body</p>",
              publishedAt,
              createdByPersonId: creatorId,
              publishedByPersonId: publisherId,
            },
            {
              articleId: 1,
              versionNumber: 1,
              slug: "creator-attribution",
              title: "Creator attribution",
              sticky: false,
              bodyHtml: "<p>old body</p>",
              publishedAt: "2029-12-01T00:00:00.000Z",
              createdByPersonId: creatorId,
              publishedByPersonId: publisherId,
            },
          ];
        }
        if (statement.includes("FROM content_article_departments")) return [];
        return [];
      });

      const article = yield* readPublishedArticlePostgres("creator-attribution", 1).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Profile, profile(requested)),
      );

      expect(requested).toEqual([creatorId]);
      expect(article.authorDisplayName).toBe("Article Creator");
      expect(article.bodyHtml).toBe("<p>old body</p>");
    }),
  );
});
