/**
 * Checks the migration registry and its checksum manifest. `just migration-hashes` runs `check`,
 * which prints every finding and exits 1 when there is one. `write` appends the registered
 * migrations that have no entry to `migrations/checksums.json`; it writes nothing and exits 1
 * when any other finding exists, so it never changes an existing entry.
 */
import { Effect } from "effect";
import { databaseMigrationDefinitions } from "./migrations.js";
import {
  appendToManifest,
  digestMigrations,
  manifestFindings,
  readMigrationFiles,
  readMigrationManifest,
  registryFindings,
  writeMigrationManifest,
} from "./migration-registry.js";
import { TestPlatform } from "./test-support/platform.js";

const [command = "check", ...rest] = process.argv.slice(2);

if (!(command === "check" || command === "write") || rest.length > 0) {
  process.stderr.write("Usage: just migration-hashes [check | write]\n");
  process.exit(2);
}

const blocking = await Effect.runPromise(
  Effect.gen(function* () {
    const manifest = yield* readMigrationManifest();

    const digests = yield* digestMigrations(databaseMigrationDefinitions);

    const findings = [
      ...registryFindings(databaseMigrationDefinitions, yield* readMigrationFiles()),
      ...manifestFindings(databaseMigrationDefinitions, manifest, digests),
    ];

    const blocking =
      command === "write" ? findings.filter(({ kind }) => kind !== "unrecorded") : findings;

    for (const { id, message } of blocking) process.stderr.write(`${id}: ${message}\n`);

    if (command === "write" && blocking.length === 0) {
      const appended = findings.length;

      if (appended > 0)
        yield* writeMigrationManifest(
          appendToManifest(databaseMigrationDefinitions, manifest, digests),
        );

      process.stdout.write(`migration-hashes: appended ${appended} migrations\n`);
    } else
      process.stdout.write(
        `migration-hashes: ${databaseMigrationDefinitions.length} migrations, ${blocking.length} findings${command === "write" ? "; wrote nothing" : ""}\n`,
      );

    return blocking;
  }).pipe(Effect.provide(TestPlatform)),
);

process.exitCode = blocking.length === 0 ? 0 : 1;
