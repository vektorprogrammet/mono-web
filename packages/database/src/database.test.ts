import { afterAll, describe, expect, it } from "vitest";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { Database } from "@vektorprogrammet/domain/database";
import { Effect, Layer, ManagedRuntime } from "effect";
import { DatabaseTest } from "./layers.js";

const databaseLayer = DatabaseTest();
const runtime = ManagedRuntime.make(
  Layer.merge(databaseLayer, EconomyLive.pipe(Layer.provide(databaseLayer))),
);

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

  it("runs the Economy authority contract against PGlite", async () => {
    const command = {
      _tag: "SubmitReceipt" as const,
      commandId: "pglite-command-submit",
      actor: {
        personId: "pglite-owner",
        departmentId: "pglite-department",
        active: true,
        approvalScope: { _tag: "None" as const },
      },
      departmentId: "pglite-department",
      paymentAccountCiphertext: "ciphertext:v1:pglite-account",
      description: "PGlite authority contract",
      amountOre: 12_345,
      receiptDate: "2026-08-23",
      file: {
        fileRef: "pglite-file",
        objectKey: "temporary/pglite-file",
        contentType: "application/pdf",
        byteLength: 256,
        sha256: "c".repeat(64),
      },
    };
    const context = {
      receiptId: "pglite-receipt",
      visualId: "PGLITE-0001",
      now: "2026-08-23T12:00:00.000Z",
    };
    const execute = Economy.use(({ executeReceipt }) => executeReceipt(command, context));

    const first = await runtime.runPromise(execute);
    const replay = await runtime.runPromise(execute);

    expect(first.observation.status).toBe("Pending");
    expect(first.observation.replayed).toBe(false);
    expect(first.replayed).toBe(false);
    expect(replay.observation).toEqual({ ...first.observation, replayed: true });
    expect(replay.replayed).toBe(true);
  });
});
