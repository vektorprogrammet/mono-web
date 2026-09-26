/**
 * The invariants of the migration registry and of its checksum manifest.
 *
 * The registry test and `just migration-hashes` share these checks; run the recipe after you
 * add a migration, and `just migration-hashes write` to record it.
 *
 * Definition `n` has the id `<n>_<name>` and reads `migrations/<n, four digits>-<name>.sql`.
 * `migrationFileExceptions` lists the definitions that predate the file rule, each with its file.
 * Every SQL file directly in `migrations` belongs to a definition; `migrations/tutor` holds the
 * tutor event store, which this registry does not apply.
 *
 * `migrations/checksums.json` maps each migration id to the SHA-256 of its file. An applied
 * migration is immutable, so a digest that differs from its entry is a finding that `write` does
 * not repair. `write` only appends the registered migrations that have no entry.
 */
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";

export interface RegisteredMigration {
  readonly id: string;
  readonly name: string;
  readonly url: URL;
}

export interface MigrationFinding {
  /** `unrecorded` findings are the only ones that `write` resolves. */
  readonly kind: "registry" | "changed" | "unrecorded" | "unregistered";
  readonly id: string;
  readonly message: string;
}

/** Migration id to the lowercase hex SHA-256 of its file. */
export type MigrationManifest = Readonly<Record<string, string>>;

export const migrationsDirectory = new URL("../migrations/", import.meta.url);

export const migrationManifestUrl = new URL("checksums.json", migrationsDirectory);

/** The definitions whose file breaks the `<number>-<name>.sql` rule, by id, with their file. */
const migrationFileExceptions = {
  "4_receipt-authority-upgrade-replay": {
    file: "0001-receipt-authority.sql",
    reason: "It applies migration 1 again to upgrade databases that ran its earlier text.",
  },
  "47_native-school-survey-operations": {
    file: "0045-native-school-survey-operations.sql",
    reason: "Two branches numbered their files 0045; the registry applies this one as 47.",
  },
} satisfies Readonly<Record<string, { readonly file: string; readonly reason: string }>>;

const idPattern = /^([1-9]\d*)_([a-z0-9]+(?:-[a-z0-9]+)*)$/u;

const MigrationManifestJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String), {
  space: 2,
});

/** The file name of a migration URL, percent-decoded as a file path is. */
const migrationFile = (url: URL) =>
  decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));

/** Findings for ids, names, and files that break the registry rules. */
export const registryFindings = (
  definitions: ReadonlyArray<RegisteredMigration>,
  files: ReadonlyArray<string>,
): ReadonlyArray<MigrationFinding> => {
  const findings: MigrationFinding[] = [];
  const finding = (id: string, message: string) => findings.push({ kind: "registry", id, message });
  const seen = new Set<string>();

  for (const [index, { id, name, url }] of definitions.entries()) {
    if (seen.has(id)) finding(id, "The id is registered more than once.");
    seen.add(id);

    const match = idPattern.exec(id);

    if (match === null) {
      finding(id, "The id is not `<number>_<kebab-case name>`.");
      continue;
    }

    const [, number = "", suffix = ""] = match;

    if (Number(number) !== index + 1)
      finding(id, `The id is at position ${index + 1}; ids count up from 1 without gaps.`);

    if (name !== suffix) finding(id, `The name ${JSON.stringify(name)} is not the id's suffix.`);

    const exception = Object.entries(migrationFileExceptions).find(([except]) => except === id);
    const expected = exception?.[1].file ?? `${number.padStart(4, "0")}-${suffix}.sql`;

    const file = migrationFile(url);

    if (file !== expected) finding(id, `The file is ${file}; the registry expects ${expected}.`);
  }

  const referenced = new Set(definitions.map(({ url }) => migrationFile(url)));

  for (const file of files)
    if (!referenced.has(file)) finding(file, "No registered migration reads this file.");

  return findings;
};

/** Findings for manifest entries that differ from the files or from the registry. */
export const manifestFindings = (
  definitions: ReadonlyArray<RegisteredMigration>,
  manifest: MigrationManifest,
  digests: ReadonlyMap<string, string>,
): ReadonlyArray<MigrationFinding> => [
  ...definitions.flatMap(({ id }): MigrationFinding[] => {
    const recorded = manifest[id];

    if (recorded === undefined)
      return [
        {
          kind: "unrecorded",
          id,
          message:
            "The checksum manifest has no entry for this migration; run `just migration-hashes write`.",
        },
      ];

    return recorded === digests.get(id)
      ? []
      : [
          {
            kind: "changed",
            id,
            message:
              "The file differs from its recorded checksum. An applied migration is immutable; add a new migration instead.",
          },
        ];
  }),
  ...Object.keys(manifest)
    .filter((id) => !definitions.some((definition) => definition.id === id))
    .map(
      (id): MigrationFinding => ({
        kind: "unregistered",
        id,
        message:
          "The checksum manifest records a migration that the registry does not define. An applied migration stays registered.",
      }),
    ),
];

/** The manifest in registry order with an entry for every registered migration; existing entries stay. */
export const appendToManifest = (
  definitions: ReadonlyArray<RegisteredMigration>,
  manifest: MigrationManifest,
  digests: ReadonlyMap<string, string>,
): MigrationManifest =>
  Object.fromEntries(definitions.map(({ id }) => [id, manifest[id] ?? digests.get(id)!]));

/** The SHA-256 of every definition's file, by id. */
export const digestMigrations = Effect.fn("digestMigrations")(function* (
  definitions: ReadonlyArray<RegisteredMigration>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const digests = yield* Effect.forEach(
    definitions,
    ({ id, url }) =>
      path.fromFileUrl(url).pipe(
        Effect.flatMap((file) => fs.readFile(file)),
        Effect.map((bytes) => [id, createHash("sha256").update(bytes).digest("hex")] as const),
      ),
    { concurrency: "unbounded" },
  );

  return new Map(digests);
});

/** The SQL files directly in `migrations`. */
export const readMigrationFiles = Effect.fn("readMigrationFiles")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(migrationsDirectory);

  const files = yield* Effect.filter(
    (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".sql")),
    (name) => fs.stat(path.join(directory, name)).pipe(Effect.map(({ type }) => type === "File")),
  );

  return files.sort();
});

export const readMigrationManifest = Effect.fn("readMigrationManifest")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(migrationManifestUrl));

  return yield* Schema.decodeEffect(MigrationManifestJson)(text);
});

/** Writes `manifest` as `migrations/checksums.json`: two-space JSON and a final newline. */
export const writeMigrationManifest = Effect.fn("writeMigrationManifest")(function* (
  manifest: MigrationManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* Schema.encodeEffect(MigrationManifestJson)(manifest);

  yield* fs.writeFileString(yield* path.fromFileUrl(migrationManifestUrl), `${text}\n`);
});
