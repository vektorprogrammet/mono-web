import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "@vektorprogrammet/domain/database";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const inventory = [
  "organization_global_administrator_grants",
  "economy_payment_authorities",
  "economy_receipt_approval_grants",
  "organization_team_interest_registrations",
  "schools_directory_schools",
  "schools_directory_departments",
  "content_articles",
  "content_article_versions",
  "content_article_departments",
  "content_publication_command_receipts",
  "content_publication_audit",
  "recruitment_interview_schema_questions",
  "recruitment_interview_question_snapshots",
  "recruitment_interview_conducts",
  "recruitment_interview_cancellations",
  "recruitment_interview_lifecycle_command_receipts",
  "recruitment_interview_lifecycle_audit",
] as const;

const checkedSourceUrls = [
  new URL("../migrations/0016-person-keyed-organization-authority.sql", import.meta.url),
  new URL("../migrations/0017-person-keyed-receipt-authority.sql", import.meta.url),
  new URL("../migrations/0018-organization-team-interest.sql", import.meta.url),
  new URL("../../domain/src/schools/migrations/0001-schools-directory.sql", import.meta.url),
  new URL("../../domain/src/content/migrations/0001-content-publication.sql", import.meta.url),
  new URL("../migrations/0021-native-recruitment-interview-conduct.sql", import.meta.url),
];

const runtime = makeControlledTestRuntime(DatabaseTest());

afterAll(async () => {
  await runtime.dispose();
});

describe("native domain schema boundary", () => {
  it("matches the checked inventory against all post-identity CREATE TABLE sources", async () => {
    const sourceTables = (await Promise.all(checkedSourceUrls.map((url) => readFile(url, "utf8"))))
      .flatMap((source) =>
        [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)].map(
          (match) => match[1]!,
        ),
      )
      .sort();

    expect(sourceTables).toEqual([...inventory].sort());
  });

  it("places the complete post-identity inventory in public on fresh replay", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const relations = yield* database<{
          readonly tableName: string;
          readonly schemaName: string;
        }>`
          SELECT relation.relname AS "tableName", namespace.nspname AS "schemaName"
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE ${database.in("relation.relname", [...inventory])}
            AND namespace.nspname IN ('auth', 'public')
            AND relation.relkind IN ('r', 'p', 'f')
          ORDER BY relation.relname, namespace.nspname
        `;
        const authTables = yield* database<{ readonly tableName: string }>`
          SELECT relation.relname AS "tableName"
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'auth'
            AND relation.relname IN ('user', 'session', 'account', 'verification')
            AND relation.relkind IN ('r', 'p', 'f')
          ORDER BY relation.relname
        `;
        const triggerFunctions = yield* database<{
          readonly functionName: string;
          readonly schemaName: string;
        }>`
          SELECT procedure.proname AS "functionName", namespace.nspname AS "schemaName"
          FROM pg_catalog.pg_proc AS procedure
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          WHERE procedure.proname IN (
            'prevent_content_publication_audit_mutation',
            'prevent_recruitment_interview_question_snapshot_mutation',
            'prevent_recruitment_interview_lifecycle_mutation'
          )
            AND procedure.pronargs = 0
          ORDER BY procedure.proname
        `;
        return { relations, authTables, triggerFunctions };
      }),
    );

    expect(evidence.relations).toEqual(
      [...inventory].sort().map((tableName) => ({ tableName, schemaName: "public" })),
    );
    expect(evidence.authTables).toEqual(
      ["account", "session", "user", "verification"].map((tableName) => ({ tableName })),
    );
    expect(evidence.triggerFunctions).toEqual([
      { functionName: "prevent_content_publication_audit_mutation", schemaName: "public" },
      {
        functionName: "prevent_recruitment_interview_lifecycle_mutation",
        schemaName: "public",
      },
      {
        functionName: "prevent_recruitment_interview_question_snapshot_mutation",
        schemaName: "public",
      },
    ]);
  });
});
