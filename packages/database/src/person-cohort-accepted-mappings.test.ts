import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, flow, Schema } from "effect";
import { selectDatabaseMigration } from "./migrations.js";
import {
  decodePersonCohort,
  importPersonCohort as importPersonCohortEffect,
  PersonMapping,
} from "./person-cohort.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const digest = flow(Schema.decodeUnknownSync(Schema.Json), (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex"),
);

it("backfills only original Person bindings and requires matching input to recover an older replay", async () => {
  const database = await PGlite.create({ extensions: { btree_gist } });

  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });

  let pool: Pool | undefined;

  try {
    for (const migration of selectDatabaseMigration("65_person-cohort-accepted-mappings")
      .preceding) {
      await database.exec(await readFile(migration.url, "utf8"));
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
      emailOwnership: { email: row.email, attestedBy: "reviewer", evidenceRef: "person-evidence" },
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
    await database.exec(
      "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('person','Native','Edited')",
    );
    await database.query(
      `INSERT INTO person_cohort_snapshots
         (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
       VALUES ($1,'legacy','original','revision','test',$3,1),($2,'legacy','later','revision','test',$4,1)`,
      [originalKey, laterKey, digest({ original: true }), digest(olderReplay)],
    );
    await database.query(
      `INSERT INTO person_cohort_occurrences(snapshot_key,occurrence_id,disposition,reason)
       VALUES ($1,'reused-row','Accepted','CreatedPerson'),($2,'reused-row','Accepted','ExactReplay')`,
      [originalKey, laterKey],
    );
    await database.query(
      `INSERT INTO person_cohort_imports
         (source_repository,source_user_id,person_id,mapping_action,source_digest,evidence_ref,snapshot_key,occurrence_id)
       VALUES ('legacy','user','person','CreatePerson',$1,'person-evidence',$2,'reused-row')`,
      [digest({ row, mapping }), originalKey],
    );
    await database.exec(
      await readFile(
        new URL("../migrations/0065-person-cohort-accepted-mappings.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (
        await database.query(
          "SELECT snapshot_key, source_user_id FROM person_cohort_accepted_mappings",
        )
      ).rows,
    ).toEqual([{ snapshot_key: originalKey, source_user_id: "user" }]);
    await server.start();
    pool = new Pool({
      connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
      max: 1,
    });
    await expect(importPersonCohort(pool, { ...olderReplay, mappings: [] })).rejects.toMatchObject({
      code: "SnapshotConflict",
    });
    expect((await importPersonCohort(pool, olderReplay)).occurrences).toEqual([
      { occurrenceId: "reused-row", disposition: "Accepted", reason: "ExactReplay" },
    ]);
    expect(
      (
        await database.query(
          "SELECT source_user_id FROM person_cohort_accepted_mappings WHERE snapshot_key=$1",
          [laterKey],
        )
      ).rows,
    ).toEqual([{ source_user_id: "user" }]);
    expect(
      (await database.query("SELECT first_name FROM person_profiles WHERE person_id='person'"))
        .rows,
    ).toEqual([{ first_name: "Native" }]);

    for (const mutation of [
      "UPDATE person_cohort_accepted_mappings SET source_user_id='changed'",
      "DELETE FROM person_cohort_accepted_mappings",
      "TRUNCATE person_cohort_accepted_mappings",
    ])
      await expect(database.exec(mutation)).rejects.toThrow();
  } finally {
    await pool?.end();
    await server.stop();
    await database.close();
  }
}, 15_000);
