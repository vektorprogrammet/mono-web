import { Effect, Schema } from "effect";
import type { DatabaseShape } from "../database/service.js";
import { Database } from "../database/service.js";
import type { DepartmentId } from "../organization/schema.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { ContentDecodeError, ContentDepartmentNotFound, ContentIntegrityError } from "./errors.js";
import { filterNewsListingByDepartment } from "./projection.js";
import type { ArticleNotFound } from "./content-service.js";
import {
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "./schema.js";

const integrityError = (operation: string, cause: unknown): ContentIntegrityError =>
  new ContentIntegrityError({ operation, message: String(cause) });

interface CurrentVersionRow {
  readonly articleId: number;
  readonly slug: string;
  readonly title: string;
  readonly sticky: boolean;
  readonly publishedAt: string;
  readonly createdByPersonId: string;
}

const readDepartments = (
  database: DatabaseShape,
  articleIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, ReadonlyArray<DepartmentId>>, ContentIntegrityError> =>
  articleIds.length === 0
    ? Effect.succeed(new Map())
    : database<{ readonly articleId: number; readonly departmentId: DepartmentId }>`
        SELECT article_id AS "articleId", department_id AS "departmentId"
        FROM content_article_departments
        WHERE ${database.in("article_id", articleIds)}
        ORDER BY article_id, department_id
      `.pipe(
        Effect.catchTag("SqlError", (cause) => integrityError("read news departments", cause)),
        Effect.map((rows) => {
          const map = new Map<number, Array<DepartmentId>>();
          for (const row of rows) {
            const list = map.get(Number(row.articleId)) ?? [];
            list.push(row.departmentId);
            map.set(Number(row.articleId), list);
          }
          return map;
        }),
      );

/**
 * Reads every article's current published version in one repeatable-read,
 * write-free snapshot (laws 5, 7, 8). The inner join on the current-version
 * pointer admits only published state; drafts never surface.
 */
export const readNewsListingPostgres = (
  departmentId?: DepartmentId,
): Effect.Effect<
  PublishedNewsListing,
  ContentDecodeError | ContentDepartmentNotFound | ContentIntegrityError,
  Database | Organization | Profile
> =>
  Effect.gen(function* () {
    const database = yield* Database;
    const profile = yield* Profile;
    const organization = yield* Organization;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );
          if (departmentId !== undefined) {
            yield* organization
              .readDepartment(departmentId)
              .pipe(
                Effect.mapError((cause) =>
                  cause._tag === "DepartmentNotFound"
                    ? new ContentDepartmentNotFound({ departmentId })
                    : integrityError("validate news department", cause),
                ),
              );
          }
          const rows = yield* database<CurrentVersionRow>`
            SELECT
              CAST(version.article_id AS integer) AS "articleId",
              version.slug,
              version.title,
              version.sticky,
              to_char(
                version.published_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS "publishedAt",
              article.created_by_person_id AS "createdByPersonId"
            FROM content_article_versions AS version
            INNER JOIN content_articles AS article
              ON article.article_id = version.article_id
             AND article.current_version_number = version.version_number
            ORDER BY version.sticky DESC, version.published_at DESC, version.article_id DESC
          `.pipe(
            Effect.catchTag("SqlError", (cause) => integrityError("read news listing", cause)),
          );
          if (rows.length === 0) {
            return { articles: [] } as const;
          }
          const departmentIdsByArticle = yield* readDepartments(database, [
            ...new Set(rows.map((row) => row.articleId)),
          ]);
          const authorPersonIds = [...new Set(rows.map((row) => row.createdByPersonId))].sort();
          const profiles = yield* profile
            .readProfiles(authorPersonIds as never)
            .pipe(Effect.mapError((cause) => integrityError("resolve news authors", cause)));
          const namesByPerson = new Map<string, string>(
            profiles.map((entry) => [entry.personId, `${entry.firstName} ${entry.lastName}`]),
          );
          for (const personId of authorPersonIds) {
            if (!namesByPerson.has(personId)) {
              return yield* new ContentIntegrityError({
                operation: "resolve news authors",
                message: `no profile resolved for author ${personId}`,
              });
            }
          }
          const articles = rows.map((row) => ({
            slug: row.slug,
            title: row.title,
            sticky: row.sticky,
            publishedAt: row.publishedAt,
            authorDisplayName: namesByPerson.get(row.createdByPersonId) ?? "",
            departmentIds: [...(departmentIdsByArticle.get(row.articleId) ?? [])],
            hasImage: false,
          }));
          const listing = yield* Schema.decodeUnknownEffect(PublishedNewsListingSchema)(
            { articles },
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError((cause) => integrityError("decode news listing", cause)));
          return filterNewsListingByDepartment(listing, departmentId);
        }),
      )
      .pipe(Effect.catchTag("SqlError", (cause) => integrityError("news listing snapshot", cause)));
  });

/**
 * Resolves the current or one immutable historical version while the article
 * remains published. Unknown, withdrawn, and unknown-version reads share the
 * same typed not-found result.
 */
export const readPublishedArticlePostgres = (
  slug: string,
  versionNumber?: number,
): Effect.Effect<
  PublishedNewsArticle,
  ContentDecodeError | ContentIntegrityError | ArticleNotFound,
  Database | Profile
> =>
  Effect.gen(function* () {
    const database = yield* Database;
    const profile = yield* Profile;
    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );
          const versions = yield* database<{
            readonly articleId: number;
            readonly versionNumber: number;
            readonly slug: string;
            readonly title: string;
            readonly sticky: boolean;
            readonly bodyHtml: string;
            readonly publishedAt: string;
            readonly createdByPersonId: string;
          }>`
            SELECT
              CAST(version.article_id AS integer) AS "articleId",
              version.version_number AS "versionNumber",
              version.slug,
              version.title,
              version.sticky,
              version.body_html AS "bodyHtml",
              to_char(
                version.published_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS "publishedAt",
              article.created_by_person_id AS "createdByPersonId"
            FROM content_article_versions AS version
            INNER JOIN content_articles AS article
              ON article.article_id = version.article_id
             AND article.current_version_number IS NOT NULL
            WHERE version.slug = ${slug}
            ORDER BY version.version_number DESC
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              integrityError("read published article versions", cause),
            ),
          );
          const current = versions[0];
          if (current === undefined) {
            return yield* Effect.fail({
              _tag: "ArticleNotFound",
            } as const satisfies ArticleNotFound);
          }
          const selected =
            versionNumber === undefined
              ? current
              : versions.find((version) => version.versionNumber === versionNumber);
          if (selected === undefined) {
            return yield* Effect.fail({
              _tag: "ArticleNotFound",
            } as const satisfies ArticleNotFound);
          }
          const departments = yield* readDepartments(database, [selected.articleId]);
          const profiles = yield* profile
            .readProfiles([selected.createdByPersonId] as never)
            .pipe(Effect.mapError((cause) => integrityError("resolve news author", cause)));
          const author = profiles.find((entry) => entry.personId === selected.createdByPersonId);
          if (author === undefined) {
            return yield* new ContentIntegrityError({
              operation: "resolve news author",
              message: `no profile resolved for author ${selected.createdByPersonId}`,
            });
          }
          const previousVersions = versions.slice(1).map((row) => ({
            versionNumber: row.versionNumber,
            publishedAt: row.publishedAt,
            urlPath: `/nyhet/${slug}?versjon=${row.versionNumber}`,
          }));
          return yield* Schema.decodeUnknownEffect(PublishedNewsArticleSchema)(
            {
              slug: selected.slug,
              title: selected.title,
              sticky: selected.sticky,
              publishedAt: selected.publishedAt,
              authorDisplayName: `${author.firstName} ${author.lastName}`,
              departmentIds: [...(departments.get(selected.articleId) ?? [])],
              hasImage: false,
              bodyHtml: selected.bodyHtml,
              previousVersions,
            },
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError((cause) => integrityError("decode published article", cause)));
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) => integrityError("published article snapshot", cause)),
      );
  });
