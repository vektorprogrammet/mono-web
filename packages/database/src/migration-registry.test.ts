import { describe, expect, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { databaseMigrationDefinitions, selectDatabaseMigration } from "./migrations.js";
import {
  appendToManifest,
  digestMigrations,
  manifestFindings,
  migrationsDirectory,
  readMigrationFiles,
  readMigrationManifest,
  registryFindings,
} from "./migration-registry.js";
import { TestPlatform } from "./test-support/platform.js";

const definition = (
  id: string,
  file = `${id.replace(/_.*$/u, "").padStart(4, "0")}-${id.replace(/^\d+_/u, "")}.sql`,
) => ({
  id,
  name: id.replace(/^\d+_/u, ""),
  url: new URL(file, migrationsDirectory),
});

layer(TestPlatform, { excludeTestServices: true })("migration registry", (it) => {
  it.effect("numbers, names, and files every registered migration by the registry rules", () =>
    Effect.gen(function* () {
      expect(registryFindings(databaseMigrationDefinitions, yield* readMigrationFiles())).toEqual(
        [],
      );
    }),
  );

  it.effect("matches every registered migration file to its recorded checksum", () =>
    Effect.gen(function* () {
      expect(
        manifestFindings(
          databaseMigrationDefinitions,
          yield* readMigrationManifest(),
          yield* digestMigrations(databaseMigrationDefinitions),
        ),
      ).toEqual([]);
    }),
  );

  it("reports duplicate ids, gaps, names, files, and unread files", () => {
    const findings = registryFindings(
      [
        definition("1_first"),
        definition("1_first"),
        definition("4_fourth"),
        { ...definition("4_renamed"), name: "other" },
        definition("5_fifth", "0006-fifth.sql"),
        definition(
          "4_receipt-authority-upgrade-replay",
          "0004-receipt-authority-upgrade-replay.sql",
        ),
      ],
      ["0001-first.sql", "0006-fifth.sql", "0009-orphan.sql"],
    );

    expect(findings.map(({ id, message }) => `${id}: ${message}`)).toEqual([
      "1_first: The id is registered more than once.",
      "1_first: The id is at position 2; ids count up from 1 without gaps.",
      "4_fourth: The id is at position 3; ids count up from 1 without gaps.",
      '4_renamed: The name "other" is not the id\'s suffix.',
      "5_fifth: The file is 0006-fifth.sql; the registry expects 0005-fifth.sql.",
      "4_receipt-authority-upgrade-replay: The id is at position 6; ids count up from 1 without gaps.",
      "4_receipt-authority-upgrade-replay: The file is 0004-receipt-authority-upgrade-replay.sql; the registry expects 0001-receipt-authority.sql.",
      "0009-orphan.sql: No registered migration reads this file.",
    ]);
  });

  it("reports changed, unrecorded, and unregistered checksums and appends only unrecorded ones", () => {
    const definitions = [definition("1_first"), definition("2_second"), definition("3_third")];

    const digests = new Map([
      ["1_first", "a"],
      ["2_second", "changed"],
      ["3_third", "c"],
    ]);

    const manifest = { "1_first": "a", "2_second": "b", "9_removed": "z" };

    expect(
      manifestFindings(definitions, manifest, digests).map(({ kind, id }) => `${kind} ${id}`),
    ).toEqual(["changed 2_second", "unrecorded 3_third", "unregistered 9_removed"]);
    expect(appendToManifest(definitions, { "1_first": "a", "2_second": "b" }, digests)).toEqual({
      "1_first": "a",
      "2_second": "b",
      "3_third": "c",
    });
  });
});

describe("selectDatabaseMigration", () => {
  it("returns the migration and the migrations that run before it", () => {
    const { migration, preceding } = selectDatabaseMigration("26_declarative-rule-reconciliation");

    expect(migration.id).toBe("26_declarative-rule-reconciliation");
    expect(preceding.map(({ id }) => id)).toHaveLength(25);
    expect(preceding.at(-1)?.id).toBe("25_principal-credential-access-algebra");
  });

  it("names the nearest registered ids when the id is absent", () => {
    // SAFETY: the id is outside the registered literal union on purpose, to reach the runtime check.
    const absent = "26_declarative-rule-reconcilation" as "26_declarative-rule-reconciliation";

    expect(() => selectDatabaseMigration(absent)).toThrow(
      'The migration registry has no migration "26_declarative-rule-reconcilation". Nearest registered ids: 25_principal-credential-access-algebra, 26_declarative-rule-reconciliation, 27_native-oauth-provider.',
    );
  });
});
