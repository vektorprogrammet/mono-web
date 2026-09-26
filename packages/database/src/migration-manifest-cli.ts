/**
 * Checks the migration registry and its checksum manifest. `just migration-hashes` runs `check`,
 * which prints every finding and exits 1 when there is one. `write` appends the registered
 * migrations that have no entry to `migrations/checksums.json`; it writes nothing and exits 1
 * when any other finding exists, so it never changes an existing entry.
 */
import { writeFile } from "node:fs/promises";
import { databaseMigrationDefinitions } from "./migrations.js";
import {
  appendToManifest,
  digestMigrations,
  manifestFindings,
  migrationManifestUrl,
  readMigrationFiles,
  readMigrationManifest,
  registryFindings,
} from "./migration-registry.js";

const [command = "check", ...rest] = process.argv.slice(2);

if (!(command === "check" || command === "write") || rest.length > 0) {
  process.stderr.write("Usage: just migration-hashes [check | write]\n");
  process.exit(2);
}

const manifest = await readMigrationManifest();

const digests = await digestMigrations(databaseMigrationDefinitions);

const findings = [
  ...registryFindings(databaseMigrationDefinitions, await readMigrationFiles()),
  ...manifestFindings(databaseMigrationDefinitions, manifest, digests),
];

const blocking =
  command === "write" ? findings.filter(({ kind }) => kind !== "unrecorded") : findings;

for (const { id, message } of blocking) process.stderr.write(`${id}: ${message}\n`);

if (command === "write" && blocking.length === 0) {
  const appended = findings.length;

  if (appended > 0)
    await writeFile(
      migrationManifestUrl,
      `${JSON.stringify(appendToManifest(databaseMigrationDefinitions, manifest, digests), null, 2)}\n`,
    );

  process.stdout.write(`migration-hashes: appended ${appended} migrations\n`);
} else
  process.stdout.write(
    `migration-hashes: ${databaseMigrationDefinitions.length} migrations, ${blocking.length} findings${command === "write" ? "; wrote nothing" : ""}\n`,
  );

process.exitCode = blocking.length === 0 ? 0 : 1;
