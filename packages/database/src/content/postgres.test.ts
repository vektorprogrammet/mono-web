import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";
import {
  ArticleId,
  ContentCommandId,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  UnpublishArticleInputSchema,
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
import { readPublishedArticlePostgres } from "./news.js";
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailPostgres,
  readWorkspacePostgres,
  unpublishPostgres,
} from "./postgres.js";

const personId = PersonId.make("workspace-editor");

const administratorId = PersonId.make("workspace-administrator");

const ownDepartmentId = DepartmentId.make("department-own");

const outsideDepartmentId = DepartmentId.make("department-outside");

const unknownDepartmentId = DepartmentId.make("department-unknown");

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2030-01-01T00:00:00.000Z");

const articleId = ArticleId.make(71);

const createCommand = CreateArticleDraftInputSchema.make({
  commandId: ContentCommandId.make("content-create-replay"),
  title: "Replay article",
  bodyHtml: "<p>Stored body</p>",
  departmentIds: [ownDepartmentId],
  sticky: false,
});

const createInput = { command: createCommand, personId, authorizationInstant };

const seed = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`
      INSERT INTO person_profiles (person_id, first_name, last_name)
      VALUES (${personId}, 'Erik', 'Redaktør'),
        (${administratorId}, 'Ada', 'Administrator'), ('another-editor', 'Another', 'Editor')
    `;
  yield* sql`
      INSERT INTO organization_departments (department_id, name, short_name, email, city, independent)
      VALUES (${ownDepartmentId}, 'Own Department', 'OWN', 'own@example.invalid', 'Oslo', TRUE),
        (${outsideDepartmentId}, 'Outside Department', 'OUT', 'outside@example.invalid', 'Bergen', TRUE)
    `;
  // The own team is its department's board: its leader publishes in the department.
  yield* sql`
      INSERT INTO organization_teams (team_id, department_id, name, kind)
      VALUES ('workspace-team', ${ownDepartmentId}, 'Own Board', 'DepartmentBoard'),
        ('outside-team', ${outsideDepartmentId}, 'Outside Team', 'Team')
    `;
  yield* sql`
      INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at)
      VALUES ('workspace-membership', ${personId}, 'workspace-team', '2028-01-01T00:00:00.000Z')
    `;
  yield* sql`
      INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at)
      VALUES ('content-administrator-grant', ${administratorId}, '2028-01-01T00:00:00.000Z')
    `;
});

const reset = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`
      TRUNCATE content_publication_audit, content_publication_command_receipts,
        content_article_departments, content_article_versions, content_articles RESTART IDENTITY
    `;
  yield* sql`DELETE FROM organization_memberships WHERE membership_id = 'outside-membership'`;
  yield* sql`
      UPDATE organization_memberships SET end_at = NULL, is_team_leader = FALSE
      WHERE membership_id = 'workspace-membership'
    `;
  yield* sql`
      INSERT INTO content_articles (
        article_id, title, slug, body_html, sticky, created_by_person_id,
        created_at, updated_at, revision
      ) OVERRIDING SYSTEM VALUE VALUES (
        ${articleId}, 'Eksakt kladd', 'eksakt-kladd', '<p>Private arbeidskopibytes</p>', FALSE,
        ${personId}, '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z', 3
      )
    `;
  yield* sql`
      INSERT INTO content_article_departments (article_id, department_id)
      VALUES (${articleId}, ${ownDepartmentId})
    `;
});

const contentLayer = Layer.effectDiscard(seed).pipe(
  Layer.provideMerge(
    ProfileLive.pipe(
      Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
    ),
  ),
);

layer(contentLayer, { excludeTestServices: true, timeout: "15 seconds" })(
  "content PostgreSQL adapter",
  (it) => {
    describe("content workspace department scope", () => {
      it.effect("returns typed NotInScope for a known department outside the actor authority", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.flip(
            readWorkspacePostgres({
              personId,
              authorizationInstant,
              query: { departmentId: outsideDepartmentId },
            }),
          );

          expect(failure._tag).toBe("NotInScope");
        }),
      );

      it.effect("keeps an unknown department distinct as DepartmentNotFound", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.flip(
            readWorkspacePostgres({
              personId,
              authorizationInstant,
              query: { departmentId: unknownDepartmentId },
            }),
          );

          expect(failure._tag).toBe("DepartmentNotFound");

          if (!Predicate.isTagged(failure, "DepartmentNotFound")) {
            throw new Error("Expected a missing department failure");
          }

          expect(failure.departmentId).toBe(unknownDepartmentId);
        }),
      );
    });

    describe("content article detail authority", () => {
      it.effect("returns body and revision without the private creator id", () =>
        Effect.gen(function* () {
          yield* reset;

          const detail = yield* readArticleDetailPostgres({
            articleId,
            personId,
            authorizationInstant,
          });

          expect(detail).toEqual({
            articleId,
            title: "Eksakt kladd",
            slug: "eksakt-kladd",
            status: "Draft",
            bodyHtml: "<p>Private arbeidskopibytes</p>",
            sticky: false,
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T01:00:00.000Z",
            currentVersionNumber: null,
            revision: 4,
            departmentIds: [ownDepartmentId],
            canRevise: true,
            canPublish: false,
            authorDisplayName: "Erik Redaktør",
          });
          expect("createdByPersonId" in detail).toBe(false);
        }),
      );

      it.effect("blocks the member author from revising their published article", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            yield* publishPostgres({
              command: PublishArticleInputSchema.make({
                commandId: ContentCommandId.make("publish-own-article"),
                articleId,
              }),
              personId: administratorId,
              authorizationInstant,
            });

            return yield* Effect.flip(
              readArticleDetailPostgres({ articleId, personId, authorizationInstant }),
            );
          });

          expect(failure._tag).toBe("DraftNotOwned");
        }),
      );

      it.effect("maps absence and foreign drafts to typed failures", () =>
        Effect.gen(function* () {
          yield* reset;

          const observed = yield* Effect.gen(function* () {
            const missing = yield* Effect.flip(
              readArticleDetailPostgres({
                articleId: ArticleId.make(999),
                personId,
                authorizationInstant,
              }),
            );

            const sql = yield* Database;
            yield* sql`UPDATE content_articles SET created_by_person_id = 'another-editor' WHERE article_id = ${articleId}`;

            const denied = yield* Effect.flip(
              readArticleDetailPostgres({ articleId, personId, authorizationInstant }),
            );

            return { missing, denied };
          });

          expect(observed.missing._tag).toBe("ArticleNotFound");
          expect(observed.denied._tag).toBe("DraftNotOwned");
        }),
      );
    });

    describe("content command receipts and sequencing", () => {
      it.effect(
        "returns the strict stored draft for an identical create replay after authority expires",
        () =>
          Effect.gen(function* () {
            yield* reset;

            const observed = yield* Effect.gen(function* () {
              const created = yield* createDraftPostgres(createInput);
              const sql = yield* Database;
              yield* sql`
        UPDATE organization_memberships SET end_at = '2029-01-01T00:00:00.000Z'
        WHERE membership_id = 'workspace-membership'
      `;
              const replayed = yield* createDraftPostgres(createInput);

              const counts = yield* sql<{ readonly articles: number; readonly audits: number }>`
        SELECT (SELECT count(*)::integer FROM content_articles WHERE slug = 'replay-article') AS articles,
          (SELECT count(*)::integer FROM content_publication_audit WHERE command_id = ${createCommand.commandId}) AS audits
      `;

              return { created, replayed, counts };
            });

            expect(observed.replayed).toEqual(observed.created);
            expect(observed.counts).toEqual([{ articles: 1, audits: 1 }]);
          }),
      );

      it.effect("rejects command id reuse across a different command kind", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            const created = yield* createDraftPostgres(createInput);

            return yield* Effect.flip(
              publishPostgres({
                command: PublishArticleInputSchema.make({
                  commandId: createCommand.commandId,
                  articleId: created.articleId,
                }),
                personId: administratorId,
                authorizationInstant,
              }),
            );
          });

          expect(failure._tag).toBe("CommandConflict");
        }),
      );

      it.effect("rejects command id reuse with different canonical command bytes", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            yield* createDraftPostgres(createInput);

            return yield* Effect.flip(
              createDraftPostgres({
                command: CreateArticleDraftInputSchema.make({
                  ...createCommand,
                  title: "Different canonical bytes",
                }),
                personId,
                authorizationInstant,
              }),
            );
          });

          expect(failure._tag).toBe("CommandConflict");
        }),
      );

      it.effect("rejects excess properties in a stored create observation", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            yield* createDraftPostgres(createInput);
            const sql = yield* Database;
            yield* sql`
        UPDATE content_publication_command_receipts
        SET result_json = result_json || ${sql.json({ privateLeak: "must fail closed" })}
        WHERE command_id = ${createCommand.commandId}
      `;

            return yield* Effect.flip(createDraftPostgres(createInput));
          });

          expect(failure._tag).toBe("ContentPersistenceError");
        }),
      );

      it.effect("maps a unique-slug insertion conflict to SlugConflict", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            const sql = yield* Database;
            // Force the conflict after the real slug scan, at the actual unique index.
            yield* sql.unsafe(`
        CREATE FUNCTION test_content_slug_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.slug := 'eksakt-kladd'; RETURN NEW; END;
        $$
      `);
            yield* sql.unsafe(`
        CREATE TRIGGER test_content_slug_conflict BEFORE INSERT ON content_articles
        FOR EACH ROW EXECUTE FUNCTION test_content_slug_conflict()
      `);

            try {
              return yield* Effect.flip(createDraftPostgres(createInput));
            } finally {
              yield* sql.unsafe("DROP TRIGGER test_content_slug_conflict ON content_articles");
              yield* sql.unsafe("DROP FUNCTION test_content_slug_conflict()");
            }
          });

          expect(failure._tag).toBe("SlugConflict");
        }),
      );

      it.effect(
        "continues immutable version numbering after the published pointer is cleared",
        () =>
          Effect.gen(function* () {
            yield* reset;

            const observed = yield* Effect.gen(function* () {
              for (const versionNumber of [1, 2, 3]) {
                yield* publishPostgres({
                  command: PublishArticleInputSchema.make({
                    commandId: ContentCommandId.make(`publish-version-${versionNumber}`),
                    articleId,
                  }),
                  personId: administratorId,
                  authorizationInstant,
                });
              }

              yield* unpublishPostgres({
                command: UnpublishArticleInputSchema.make({
                  commandId: ContentCommandId.make("unpublish-third-version"),
                  articleId,
                }),
                personId: administratorId,
                authorizationInstant,
              });

              const unpublished = yield* readArticleDetailPostgres({
                articleId,
                personId: administratorId,
                authorizationInstant,
              });

              const republished = yield* publishPostgres({
                command: PublishArticleInputSchema.make({
                  commandId: ContentCommandId.make("republish-fourth-version"),
                  articleId,
                }),
                personId: administratorId,
                authorizationInstant,
              });

              const sql = yield* Database;

              const versions = yield* sql<{ readonly versionNumber: number }>`
        SELECT version_number AS "versionNumber" FROM content_article_versions
        WHERE article_id = ${articleId} ORDER BY version_number
      `;

              return { unpublished, republished, versions };
            });

            expect(observed.unpublished.currentVersionNumber).toBeNull();
            expect(observed.republished.versionNumber).toBe(4);
            expect(observed.versions).toEqual([
              { versionNumber: 1 },
              { versionNumber: 2 },
              { versionNumber: 3 },
              { versionNumber: 4 },
            ]);
          }),
      );

      it.effect("sanitizes a preexisting working copy before publication", () =>
        Effect.gen(function* () {
          yield* reset;

          const published = yield* Effect.gen(function* () {
            const sql = yield* Database;
            yield* sql`
        UPDATE content_articles SET body_html = '<p>before</p><script>alert(1)</script><p>after</p>'
        WHERE article_id = ${articleId}
      `;
            yield* publishPostgres({
              command: PublishArticleInputSchema.make({
                commandId: ContentCommandId.make("publish-sanitized-body"),
                articleId,
              }),
              personId: administratorId,
              authorizationInstant,
            });

            return yield* readPublishedArticlePostgres("eksakt-kladd");
          });

          expect(published.bodyHtml).toBe("<p>before</p><p>after</p>");
        }),
      );

      it.effect("rejects an unsafe preexisting working copy without immutable writes", () =>
        Effect.gen(function* () {
          yield* reset;

          const observed = yield* Effect.gen(function* () {
            const sql = yield* Database;
            yield* sql`
        UPDATE content_articles SET body_html = ${'<p><a href="java&#x73;cript:alert(1)">unsafe</a></p>'}
        WHERE article_id = ${articleId}
      `;

            const failure = yield* Effect.flip(
              publishPostgres({
                command: PublishArticleInputSchema.make({
                  commandId: ContentCommandId.make("publish-unsafe-body"),
                  articleId,
                }),
                personId: administratorId,
                authorizationInstant,
              }),
            );

            const counts = yield* sql<{ readonly versions: number; readonly audits: number }>`
        SELECT (SELECT count(*)::integer FROM content_article_versions) AS versions,
          (SELECT count(*)::integer FROM content_publication_audit) AS audits
      `;

            return { failure, counts };
          });

          expect(observed.failure._tag).toBe("ContentDecodeError");
          expect(observed.counts).toEqual([{ versions: 0, audits: 0 }]);
        }),
      );
    });

    describe("content create department authority", () => {
      it.effect("prevents a publisher from selecting an active non-leader membership", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.gen(function* () {
            const sql = yield* Database;
            yield* sql`
        UPDATE organization_memberships SET is_team_leader = TRUE
        WHERE membership_id = 'workspace-membership'
      `;
            yield* sql`
        INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at)
        VALUES ('outside-membership', ${personId}, 'outside-team', '2028-01-01T00:00:00.000Z')
      `;

            return yield* Effect.flip(
              createDraftPostgres({
                command: CreateArticleDraftInputSchema.make({
                  ...createCommand,
                  departmentIds: [outsideDepartmentId],
                }),
                personId,
                authorizationInstant,
              }),
            );
          });

          expect(failure._tag).toBe("NotInScope");
        }),
      );

      it.effect("requires non-administrators to select at least one department", () =>
        Effect.gen(function* () {
          yield* reset;

          const failure = yield* Effect.flip(
            createDraftPostgres({
              command: CreateArticleDraftInputSchema.make({ ...createCommand, departmentIds: [] }),
              personId,
              authorizationInstant,
            }),
          );

          expect(failure._tag).toBe("NotInScope");
        }),
      );
    });
  },
);
