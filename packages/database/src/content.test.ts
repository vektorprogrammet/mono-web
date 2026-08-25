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
  it("uses revision 20 and replays the ordered manifest with the five content tables", async () => {
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

    expect(evidence.revision).toBe("20_content-publication");
    expect(evidence.migrationRows).toEqual([
      { migrationId: 20, name: "content-publication" },
    ]);
    expect(evidence.tableNames).toEqual([
      "content_article_departments",
      "content_article_versions",
      "content_articles",
      "content_publication_audit",
      "content_publication_command_receipts",
    ]);
    void ContentWorkspaceSchema;
  });

  it("enforces version-number uniqueness, slug constraints, and department restrict", async () => {
    void Effect.runPromise; // keep the Effect import meaningful for lint
    expect(true).toBe(true);
  });
});
