import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { ContentWorkspaceSchema } from "@vektorprogrammet/domain/content";
import { Effect } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const databaseLayer = DatabaseTest();
const runtime = makeControlledTestRuntime(databaseLayer);

afterAll(async () => {
  await runtime.dispose();
});

describe("Content publication migration in PGlite (spec 0062)", () => {
  it("uses the final revision and replays the ordered manifest with the five content tables", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.migrate;
        const migrationRows = yield* database<{
          readonly migrationId: number;
          readonly name: string;
        }>`
          SELECT
            migration.migration_id AS "migrationId",
            migration.name AS "name"
          FROM vektorprogrammet_schema_migrations AS migration
          WHERE migration.migration_id = 20
        `;
        const tableRows = yield* database<{ readonly tableName: string }>`
          SELECT table_name AS "tableName"
          FROM information_schema.tables
          WHERE table_name IN (
            'content_articles',
            'content_article_versions',
            'content_article_departments',
            'content_publication_command_receipts',
            'content_publication_audit'
          )
          ORDER BY table_name
        `;
        return {
          revision: database.schemaRevision,
          migrationRows,
          tableNames: tableRows.map((row) => row.tableName),
        };
      }),
    );

    expect(evidence.revision).toBe("23_declarative-authorization-rules");
    expect(evidence.migrationRows).toEqual([{ migrationId: 20, name: "content-publication" }]);
    expect(evidence.tableNames).toEqual([
      "content_article_departments",
      "content_article_versions",
      "content_articles",
      "content_publication_audit",
      "content_publication_command_receipts",
    ]);
    void ContentWorkspaceSchema;
  }, 15_000);

  it("enforces version-number uniqueness, slug constraints, and department restrict", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO organization_departments (
            department_id, name, short_name, email, city
          ) VALUES ('content-test-dep', 'Testavdeling', 'TAV', 'tav@example.invalid', 'Oslo')
        `;
        const insertDraft = (slug: string) =>
          database`
            INSERT INTO public.content_articles (title, slug, body_html, sticky, created_by_person_id)
            VALUES (${`Tittel ${slug}`}, ${slug}, '<p>x</p>', FALSE, 'person-1')
          `;
        yield* insertDraft("unikt-lenkenavn");
        const idRows = yield* database<{ readonly articleId: number }>`
          SELECT article_id AS "articleId" FROM public.content_articles WHERE slug = 'unikt-lenkenavn'
        `;
        const articleId = Number(idRows[0]!.articleId);

        // A duplicate slug across drafts is rejected.
        const duplicateSlug = yield* Effect.exit(insertDraft("unikt-lenkenavn"));
        const duplicateSlugRejected = duplicateSlug._tag === "Failure";

        yield* database`
          INSERT INTO public.content_article_departments (article_id, department_id)
          VALUES (${articleId}, 'content-test-dep')
        `;

        const insertVersion = (version: number) =>
          database`
            INSERT INTO public.content_article_versions (
              article_id, version_number, title, slug, body_html, sticky,
              published_at, published_by_person_id
            ) VALUES (
              ${articleId}, ${version}, 'T', 'unikt-lenkenavn', '<p>x</p>',
              FALSE, '2030-01-01T00:00:00.000Z', 'person-1'
            )
          `.pipe(Effect.asVoid);
        yield* insertVersion(1);
        // The same (article, version) pair is a PK violation.
        const duplicateVersion = yield* Effect.exit(insertVersion(1));
        const duplicateVersionRejected = duplicateVersion._tag === "Failure";

        // Historical versions may share listing-order keys.
        const sameListingOrder = yield* Effect.exit(insertVersion(2));
        const sameListingOrderAccepted = sameListingOrder._tag === "Success";
        const listingIndexRows = yield* database<{ readonly isUnique: boolean }>`
          SELECT index.indisunique AS "isUnique"
          FROM pg_index AS index
          WHERE index.indexrelid = 'content_article_versions_current_listing_order'::regclass
        `;
        const listingIndexIsNonUnique = listingIndexRows[0]?.isUnique === false;

        yield* database`
          INSERT INTO public.content_publication_command_receipts (
            command_id, article_id, kind, payload_sha256, result_json, committed_at
          ) VALUES (
            'content-audit-protection-command', ${articleId}, 'CreateDraft',
            repeat('0', 64), '{}'::jsonb, '2030-01-01T00:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO public.content_publication_audit (
            command_id, article_id, actor_person_id, action, version_number, occurred_at
          ) VALUES (
            'content-audit-protection-command', ${articleId}, 'person-1',
            'CreateDraft', NULL, '2030-01-01T00:00:00.000Z'
          )
        `;
        const auditRows = yield* database<{ readonly auditId: number }>`
          SELECT audit_id AS "auditId"
          FROM public.content_publication_audit
          WHERE command_id = 'content-audit-protection-command'
        `;
        const auditInsertWorked = auditRows.length === 1;
        const auditUpdate = yield* Effect.exit(
          database`
            UPDATE public.content_publication_audit
            SET action = 'Publish'
            WHERE command_id = 'content-audit-protection-command'
          `.pipe(Effect.asVoid),
        );
        const auditUpdateRejected = auditUpdate._tag === "Failure";
        const auditDelete = yield* Effect.exit(
          database`
            DELETE FROM public.content_publication_audit
            WHERE command_id = 'content-audit-protection-command'
          `.pipe(Effect.asVoid),
        );
        const auditDeleteRejected = auditDelete._tag === "Failure";

        // FK RESTRICT blocks deleting a department still referenced.
        const restrict = yield* Effect.exit(
          database`DELETE FROM organization_departments WHERE department_id = 'content-test-dep'`.pipe(
            Effect.asVoid,
          ),
        );
        const restrictBlocked = restrict._tag === "Failure";

        return {
          duplicateSlugRejected,
          duplicateVersionRejected,
          sameListingOrderAccepted,
          listingIndexIsNonUnique,
          auditInsertWorked,
          auditUpdateRejected,
          auditDeleteRejected,
          restrictBlocked,
        };
      }),
    );
    expect(outcome).toEqual({
      duplicateSlugRejected: true,
      duplicateVersionRejected: true,
      sameListingOrderAccepted: true,
      listingIndexIsNonUnique: true,
      auditInsertWorked: true,
      auditUpdateRejected: true,
      auditDeleteRejected: true,
      restrictBlocked: true,
    });
  });
});
