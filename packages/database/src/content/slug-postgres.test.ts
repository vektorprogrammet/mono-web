import { expect, layer } from "@effect/vitest";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  ContentCommandId,
  ContentManagement,
  CreateArticleDraftInputSchema,
} from "@vektorprogrammet/domain/content";
import {
  DepartmentId,
  OrganizationAuthorityInstantSchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { DatabaseLive } from "../layers.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { Database } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { ContentManagementLive } from "./postgres-layer.js";

class SlugPostgres extends Context.Service<SlugPostgres, DisposablePostgres>()(
  "content/slug-postgres.test/SlugPostgres",
) {}

const cluster = Layer.effect(
  SlugPostgres,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (postgres) => Effect.promise(() => postgres.stop()),
  ),
);

const database = Layer.unwrap(
  Effect.map(SlugPostgres, (postgres) =>
    DatabaseLive({
      url: Redacted.make(postgres.url),
      applicationName: "content-slug-postgres-test",
      maxConnections: 2,
    }).pipe(Layer.provide(TestPlatform)),
  ),
);

const content = ContentManagementLive.pipe(
  Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(database))),
  Layer.provideMerge(cluster),
);

const personId = PersonId.make("slug-editor");

const departmentId = DepartmentId.make("slug-department");

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2030-01-01T00:00:00.000Z");

const create = (commandId: string, title: string) =>
  ContentManagement.use((management) =>
    management.createDraft(
      CreateArticleDraftInputSchema.make({
        commandId: ContentCommandId.make(commandId),
        title,
        bodyHtml: "<p>Stored article</p>",
        departmentIds: [departmentId],
      }),
      { personId, authorizationInstant },
    ),
  );

const PersistedSlugRows = Schema.Array(
  Schema.Struct({
    articleId: Schema.Int,
    slug: Schema.String,
    characters: Schema.Int,
    bytes: Schema.Int,
  }),
);

const WriteCounts = Schema.Array(
  Schema.Struct({
    articles: Schema.Int,
    departments: Schema.Int,
    receipts: Schema.Int,
    audits: Schema.Int,
    versions: Schema.Int,
  }),
);

layer(content, { excludeTestServices: true, timeout: "90 seconds" })(
  "ContentManagement create on real PostgreSQL",
  (it) => {
    it.effect(
      "keeps colliding transliterated long slugs inside the SQL bound without partial writes",
      () =>
        Effect.gen(function* () {
          const sql = yield* Database;
          yield* sql`
          INSERT INTO person_profiles (person_id, first_name, last_name)
          VALUES (${personId}, 'Slug', 'Editor')
        `;
          yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city, independent)
          VALUES (${departmentId}, 'Slug department', 'SLUG', 'slug@example.invalid', 'Oslo', TRUE)
        `;
          yield* sql`
          INSERT INTO organization_teams (team_id, department_id, name, kind)
          VALUES ('slug-board', ${departmentId}, 'Slug board', 'DepartmentBoard')
        `;
          yield* sql`
          INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at)
          VALUES ('slug-editor-membership', ${personId}, 'slug-board', '2028-01-01T00:00:00.000Z')
        `;

          // Both titles fit the 255-character title constraint but transliterate to 510 bytes.
          const first = yield* create("slug-long-lower", "æ".repeat(255));
          const second = yield* create("slug-long-upper", "Æ".repeat(255));
          const firstSlug = "ae".repeat(127) + "a";
          const secondSlug = "ae".repeat(126) + "a-2";

          expect(first.slug).toBe(firstSlug);
          expect(second.slug).toBe(secondSlug);
          expect(second.articleId).not.toBe(first.articleId);

          const persisted = yield* sql`
          SELECT article_id::integer AS "articleId", slug,
            char_length(slug)::integer AS "characters", octet_length(slug)::integer AS "bytes"
          FROM content_articles ORDER BY article_id
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PersistedSlugRows)));

          expect(persisted).toEqual([
            { articleId: first.articleId, slug: firstSlug, characters: 255, bytes: 255 },
            { articleId: second.articleId, slug: secondSlug, characters: 255, bytes: 255 },
          ]);

          const invalid = yield* Effect.flip(
            create("slug-empty-after-normalization", "!".repeat(255)),
          );

          expect(invalid._tag).toBe("SlugConflict");

          const counts = yield* sql`
          SELECT (SELECT count(*)::integer FROM content_articles) AS articles,
            (SELECT count(*)::integer FROM content_article_departments) AS departments,
            (SELECT count(*)::integer FROM content_publication_command_receipts) AS receipts,
            (SELECT count(*)::integer FROM content_publication_audit) AS audits,
            (SELECT count(*)::integer FROM content_article_versions) AS versions
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(WriteCounts)));

          expect(counts).toEqual([
            { articles: 2, departments: 2, receipts: 2, audits: 2, versions: 0 },
          ]);
        }),
    );
  },
);
