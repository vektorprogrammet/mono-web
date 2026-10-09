import { expect, layer } from "@effect/vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import {
  ContentCommandId,
  ContentManagement,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  ReviseArticleDraftInputSchema,
} from "@vektorprogrammet/domain/content";
import {
  DepartmentId,
  OrganizationAuthorityInstantSchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { DatabaseLive } from "../layers.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { Database } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { readPublishedArticlePostgres } from "./news.js";
import { ContentManagementLive } from "./postgres-layer.js";

const editorId = PersonId.make("visibility-editor-a");

const publisherId = PersonId.make("visibility-publisher-b");

const administratorId = PersonId.make("visibility-administrator");

const departmentA = DepartmentId.make("visibility-department-a");

const departmentB = DepartmentId.make("visibility-department-b");

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2030-01-01T00:00:00.000Z");

class VisibilityCluster extends Context.Service<VisibilityCluster, DisposablePostgres>()(
  "content/workspace-visibility-postgres.test/VisibilityCluster",
) {}

const clusterLayer = Layer.effect(
  VisibilityCluster,
  Effect.acquireRelease(
    Effect.promise(() =>
      startDisposablePostgres({ listen: "socket", database: "visibility", maxConnections: 8 }),
    ),
    (cluster) => Effect.promise(() => cluster.stop()),
  ),
);

const databaseLayer = Layer.unwrap(
  Effect.map(VisibilityCluster, (cluster) =>
    DatabaseLive({
      url: Redacted.make(cluster.url),
      maxConnections: 4,
      applicationName: "content-workspace-visibility-test",
      startupOptions: NativeDatabaseStartupOptions,
    }).pipe(Layer.provide(TestPlatform)),
  ),
).pipe(Layer.provideMerge(clusterLayer));

const contentLayer = ContentManagementLive.pipe(
  Layer.provideMerge(
    ProfileLive.pipe(Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(databaseLayer)))),
  ),
);

layer(contentLayer, { excludeTestServices: true, timeout: "120 seconds" })(
  "content workspace visibility on PostgreSQL",
  (it) => {
    it.effect(
      "does not disclose another department's unpublished working copy to a scoped editor",
      () =>
        Effect.gen(function* () {
          const sql = yield* Database;
          const content = yield* ContentManagement;
          yield* sql`
          INSERT INTO person_profiles (person_id, first_name, last_name) VALUES
            (${editorId}, 'Eira', 'Editor'),
            (${publisherId}, 'Pia', 'Publisher'),
            (${administratorId}, 'Ada', 'Administrator')
        `;
          yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city, independent) VALUES
            (${departmentA}, 'Department A', 'A', 'department-a@example.invalid', 'Oslo', TRUE),
            (${departmentB}, 'Department B', 'B', 'department-b@example.invalid', 'Bergen', TRUE)
        `;
          yield* sql`
          INSERT INTO organization_teams (team_id, department_id, name, kind) VALUES
            ('visibility-team-a', ${departmentA}, 'Team A', 'Team'),
            ('visibility-board-b', ${departmentB}, 'Board B', 'DepartmentBoard')
        `;
          yield* sql`
          INSERT INTO organization_memberships
            (membership_id, person_id, team_id, start_at, is_team_leader) VALUES
            ('visibility-editor-membership', ${editorId}, 'visibility-team-a', '2028-01-01T00:00:00.000Z', FALSE),
            ('visibility-publisher-membership', ${publisherId}, 'visibility-board-b', '2028-01-01T00:00:00.000Z', TRUE)
        `;
          yield* sql`
          INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at)
          VALUES ('visibility-admin-grant', ${administratorId}, '2028-01-01T00:00:00.000Z')
        `;

          const editor = { personId: editorId, authorizationInstant };
          const publisher = { personId: publisherId, authorizationInstant };
          const administrator = { personId: administratorId, authorizationInstant };

          const own = yield* content.createDraft(
            CreateArticleDraftInputSchema.make({
              commandId: ContentCommandId.make("visibility-own-draft"),
              title: "Department A own draft",
              bodyHtml: "<p>Department A draft</p>",
              departmentIds: [departmentA],
            }),
            editor,
          );

          const foreign = yield* content.createDraft(
            CreateArticleDraftInputSchema.make({
              commandId: ContentCommandId.make("visibility-published-b"),
              title: "Department B public title",
              bodyHtml: "<p>Department B public body</p>",
              departmentIds: [departmentB],
            }),
            publisher,
          );

          const foreignDraft = yield* content.createDraft(
            CreateArticleDraftInputSchema.make({
              commandId: ContentCommandId.make("visibility-draft-b"),
              title: "Department B draft",
              bodyHtml: "<p>Department B draft body</p>",
              departmentIds: [departmentB],
            }),
            publisher,
          );

          const published = yield* content.publish(
            PublishArticleInputSchema.make({
              commandId: ContentCommandId.make("visibility-publish-b"),
              articleId: foreign.articleId,
            }),
            publisher,
          );

          const revised = yield* content.reviseDraft(
            ReviseArticleDraftInputSchema.make({
              commandId: ContentCommandId.make("visibility-revise-b"),
              articleId: foreign.articleId,
              expectedRevision: foreign.revision + 1,
              title: "Department B PRIVATE working title",
              bodyHtml: "<p>Department B PRIVATE working body</p>",
              departmentIds: [departmentB],
            }),
            publisher,
          );

          expect(published.versionNumber).toBe(1);
          expect(revised.currentVersionNumber).toBe(1);

          const publisherWorkspace = yield* content.readWorkspace(publisher, {});
          expect(
            publisherWorkspace.entries.map((entry) => entry.articleId).sort((a, b) => a - b),
          ).toEqual([foreign.articleId, foreignDraft.articleId].sort((a, b) => a - b));
          expect(
            publisherWorkspace.entries.find((entry) => entry.articleId === foreign.articleId),
          ).toMatchObject({
            status: "Published",
            title: "Department B PRIVATE working title",
            canRevise: true,
            canPublish: true,
          });

          const administratorWorkspace = yield* content.readWorkspace(administrator, {});
          expect(
            administratorWorkspace.entries.map((entry) => entry.articleId).sort((a, b) => a - b),
          ).toEqual(
            [own.articleId, foreign.articleId, foreignDraft.articleId].sort((a, b) => a - b),
          );

          const publisherDetail = yield* content.readArticleDetail(foreign.articleId, publisher);

          const administratorDetail = yield* content.readArticleDetail(
            foreign.articleId,
            administrator,
          );

          expect(publisherDetail.bodyHtml).toBe("<p>Department B PRIVATE working body</p>");
          expect(administratorDetail.bodyHtml).toBe(publisherDetail.bodyHtml);

          const publicVersion = yield* readPublishedArticlePostgres(foreign.slug);
          expect(publicVersion.title).toBe("Department B public title");
          expect(publicVersion.bodyHtml).toBe("<p>Department B public body</p>");

          const ownDetail = yield* content.readArticleDetail(own.articleId, editor);
          expect(ownDetail.bodyHtml).toBe("<p>Department A draft</p>");

          const deniedDetail = yield* Effect.flip(
            content.readArticleDetail(foreign.articleId, editor),
          );

          expect(deniedDetail._tag).toBe("DraftNotOwned");

          const ownDepartmentWorkspace = yield* content.readWorkspace(editor, {
            departmentId: departmentA,
          });

          expect(ownDepartmentWorkspace.entries.map((entry) => entry.articleId)).toEqual([
            own.articleId,
          ]);

          const editorWorkspace = yield* content.readWorkspace(editor, {});
          expect(editorWorkspace.entries.map((entry) => entry.title)).toEqual([
            "Department A own draft",
          ]);
        }),
      120_000,
    );
  },
);
