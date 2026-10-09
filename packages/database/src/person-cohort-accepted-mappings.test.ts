import { expect, layer } from "@effect/vitest";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Exit, FileSystem, flow, Path, Redacted } from "effect";
import { selectDatabaseMigration } from "./migrations.js";
import { decodePersonCohort, importPersonCohort, PersonMapping } from "./person-cohort.js";
import { TestPlatform } from "./test-support/platform.js";
import {
  pgliteSocketDatabase,
  postgresTestClient,
  refusingRejectedStatements,
} from "./test-support/postgres.js";

const digest = flow(canonicalJsonBytes, sha256Hex);

const readMigrationSource = Effect.fnUntraced(function* (url: URL) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  return yield* fileSystem.readFileString(yield* path.fromFileUrl(url));
});

layer(TestPlatform, { excludeTestServices: true })((it) => {
  it.effect(
    "backfills only original Person bindings and requires matching input to recover an older replay",
    () =>
      Effect.gen(function* () {
        // Released in reverse: the native client ends, the socket server stops, then PGlite closes.
        const socket = yield* pgliteSocketDatabase();
        const { database, server } = socket;

        for (const migration of selectDatabaseMigration("65_person-cohort-accepted-mappings")
          .preceding) {
          const source = yield* readMigrationSource(migration.url);

          yield* Effect.promise(() => database.exec(source));
        }

        const row = {
          sourceUserId: "user",
          active: true,
          firstName: "Ada",
          lastName: "Volunteer",
          email: "ada@example.invalid",
          phone: "12345678",
        };

        const mapping = PersonMapping.cases.CreatePerson.make({
          sourceUserId: "user",
          personId: PersonId.make("person"),
          emailOwnership: {
            email: row.email,
            attestedBy: "reviewer",
            evidenceRef: "person-evidence",
          },
        });

        const olderReplay = decodePersonCohort({
          sourceRepository: "legacy",
          sourceRevision: "revision",
          snapshotId: "later",
          transformationRevision: "test",
          sourceKind: "Synthetic",
          occurrences: [{ occurrenceId: "reused-row", row }],
          mappings: [mapping],
        });

        const originalKey = digest(["legacy", "original"]);
        const laterKey = digest(["legacy", "later"]);

        yield* Effect.promise(() =>
          database.exec(
            "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('person','Native','Edited')",
          ),
        );
        yield* Effect.promise(() =>
          database.query(
            `INSERT INTO person_cohort_snapshots
               (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
             VALUES ($1,'legacy','original','revision','test',$3,1),($2,'legacy','later','revision','test',$4,1)`,
            [originalKey, laterKey, digest({ original: true }), digest(olderReplay)],
          ),
        );
        yield* Effect.promise(() =>
          database.query(
            `INSERT INTO person_cohort_occurrences(snapshot_key,occurrence_id,disposition,reason)
             VALUES ($1,'reused-row','Accepted','CreatedPerson'),($2,'reused-row','Accepted','ExactReplay')`,
            [originalKey, laterKey],
          ),
        );
        yield* Effect.promise(() =>
          database.query(
            `INSERT INTO person_cohort_imports
               (source_repository,source_user_id,person_id,mapping_action,source_digest,evidence_ref,snapshot_key,occurrence_id)
             VALUES ('legacy','user','person','CreatePerson',$1,'person-evidence',$2,'reused-row')`,
            [digest({ row, mapping }), originalKey],
          ),
        );

        const acceptedMappingsMigration = yield* readMigrationSource(
          new URL("../migrations/0065-person-cohort-accepted-mappings.sql", import.meta.url),
        );

        yield* Effect.promise(() => database.exec(acceptedMappingsMigration));
        expect(
          (yield* Effect.promise(() =>
            database.query(
              "SELECT snapshot_key, source_user_id FROM person_cohort_accepted_mappings",
            ),
          )).rows,
        ).toEqual([{ snapshot_key: originalKey, source_user_id: "user" }]);

        return yield* refusingRejectedStatements(
          socket,
          Effect.gen(function* () {
            yield* Effect.promise(() => server.start());

            const sql = yield* postgresTestClient({
              url: Redacted.make(`postgres://postgres@${server.getServerConn()}/postgres`),
              maxConnections: 1,
              minConnections: 0,
              idleTimeout: "10 seconds",
              connectionTTL: undefined,
              prepare: false,
            });

            expect(
              yield* Effect.flip(importPersonCohort(sql, { ...olderReplay, mappings: [] })),
            ).toMatchObject({ code: "SnapshotConflict" });
            expect((yield* importPersonCohort(sql, olderReplay)).occurrences).toEqual([
              { occurrenceId: "reused-row", disposition: "Accepted", reason: "ExactReplay" },
            ]);
            expect(
              (yield* Effect.promise(() =>
                database.query(
                  "SELECT source_user_id FROM person_cohort_accepted_mappings WHERE snapshot_key=$1",
                  [laterKey],
                ),
              )).rows,
            ).toEqual([{ source_user_id: "user" }]);
            expect(
              (yield* Effect.promise(() =>
                database.query("SELECT first_name FROM person_profiles WHERE person_id='person'"),
              )).rows,
            ).toEqual([{ first_name: "Native" }]);

            for (const mutation of [
              "UPDATE person_cohort_accepted_mappings SET source_user_id='changed'",
              "DELETE FROM person_cohort_accepted_mappings",
              "TRUNCATE person_cohort_accepted_mappings",
            ]) {
              const rejected = yield* Effect.exit(Effect.tryPromise(() => database.exec(mutation)));

              expect(Exit.isFailure(rejected)).toBe(true);
            }
          }),
        );
      }),
    15_000,
  );
});
