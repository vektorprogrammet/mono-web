import { afterAll, describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "@vektorprogrammet/domain/database";
import { DatabaseTest } from "./layers.js";

const runtime = ManagedRuntime.make(DatabaseTest());

afterAll(async () => {
  await runtime.dispose();
});

describe("DatabaseTest", () => {
  it("constructs the complete schema before it exposes the capability", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.health;
        const migrations = yield* database<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM vektorprogrammet_schema_migrations
          ORDER BY migration_id
        `;
        const tables = yield* database<{ readonly table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'economy_receipts',
              'admission_periods',
              'admission_applications'
            )
          ORDER BY table_name
        `;
        return {
          revision: database.schemaRevision,
          migrations,
          tables: tables.map((row) => row.table_name),
        };
      }),
    );

    expect(evidence).toEqual({
      revision: "3_public-applicant-admission",
      migrations: [
        { migration_id: 1, name: "receipt-authority" },
        { migration_id: 2, name: "admission-period-authority" },
        { migration_id: 3, name: "public-applicant-admission" },
      ],
      tables: ["admission_applications", "admission_periods", "economy_receipts"],
    });
  });

  it("reuses one capability and reruns the manifest without duplicate migrations", async () => {
    const first = await runtime.runPromise(Database);
    await runtime.runPromise(Database.use((database) => database.migrate));
    const second = await runtime.runPromise(Database);
    const rows = await runtime.runPromise(
      Database.use(
        (database) =>
          database<{ readonly migration_count: string }>`
          SELECT count(*)::text AS migration_count
          FROM vektorprogrammet_schema_migrations
        `,
      ),
    );

    expect(second).toBe(first);
    expect(rows).toEqual([{ migration_count: "3" }]);
  });
});
