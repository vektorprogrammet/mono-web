import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseTest } from "@vektorprogrammet/database/live";
import { importPersonCohort, PersonMapping } from "@vektorprogrammet/database/person-cohort";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { flow, ManagedRuntime, Schema } from "effect";
import { Pool, type PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import { importCurrentAssignmentCohort } from "./current-assignment-cohort.js";

const digest = flow(Schema.decodeUnknownSync(Schema.Json), (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex"),
);

it("imports the active candidate when inactive and invalid-digest rows name the same target", async () => {
  const database = new PGlite({ extensions: { btree_gist } });
  const runtime = ManagedRuntime.make(DatabaseTest({ liveClient: database }));

  const client = {
    query: async (text: string, values?: unknown[]) => {
      const result = await database.query(text, values);

      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows };
    },
    release: () => {},
  };

  const pool = new Pool();
  // SAFETY: The import boundary uses query and release only; queries execute against the migrated PGlite database.
  vi.spyOn(pool, "connect").mockImplementation(async () => client as PoolClient);

  try {
    await runtime.runPromise(databaseHealth);
    await database.exec(`
      INSERT INTO organization_departments(department_id,name,short_name,email,city)
        VALUES('department','Department','D','d@example.invalid','Trondheim');
      INSERT INTO admission_period_semesters(semester_id,start_at,end_at)
        VALUES('semester','2026-08-01T00:00:00Z','2026-12-31T00:00:00Z');
      INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active)
        OVERRIDING SYSTEM VALUE VALUES(1,'School','Contact','school@example.invalid','12345678','Norwegian',true);
      INSERT INTO schools_directory_departments(school_id,department_id) VALUES(1,'department');
    `);
    await importPersonCohort(pool, {
      sourceRepository: "synthetic",
      sourceRevision: "revision",
      snapshotId: "people",
      transformationRevision: "test",
      sourceKind: "Synthetic",
      occurrences: [
        {
          occurrenceId: "person-row",
          row: {
            sourceUserId: "user",
            active: true,
            firstName: "Ada",
            lastName: "Volunteer",
            email: "ada@example.invalid",
            phone: "12345678",
          },
        },
      ],
      mappings: [
        PersonMapping.cases.CreatePerson.make({
          sourceUserId: "user",
          personId: PersonId.make("person"),
          emailOwnership: {
            email: "ada@example.invalid",
            attestedBy: "reviewer",
            evidenceRef: "person-evidence",
          },
        }),
      ],
    });

    const row = {
      sourceAssignmentId: "active",
      sourceUserId: "user",
      sourceDepartmentId: "source-department",
      sourceSemesterId: "source-semester",
      sourceSchoolId: "source-school",
      affiliationEvidenceRef: "affiliation",
      placementEvidenceRef: "placement",
      day: "Monday",
      workdays: 4,
      block: "1",
      active: true,
    };

    const inactive = { ...row, sourceAssignmentId: "inactive", active: false };
    const invalid = { ...row, sourceAssignmentId: "invalid" };

    const snapshot = {
      sourceRepository: "synthetic",
      sourceRevision: "revision",
      snapshotId: "assignments",
      sourceWatermark: "watermark",
      transformationRevision: "test",
      synthetic: true as const,
      occurrences: [
        { occurrenceId: "active", row: { ...row, sourceRowDigest: digest(row) } },
        { occurrenceId: "inactive", row: { ...inactive, sourceRowDigest: digest(inactive) } },
        { occurrenceId: "invalid", row: { ...invalid, sourceRowDigest: "0".repeat(64) } },
      ],
      mappings: [row, inactive, invalid].map(({ sourceAssignmentId }) => ({
        sourceAssignmentId,
        sourceUserId: "user",
        sourceDepartmentId: "source-department",
        sourceSemesterId: "source-semester",
        sourceSchoolId: "source-school",
        personId: "person",
        departmentId: "department",
        semesterId: "semester",
        schoolId: 1,
      })),
    };

    const report = await importCurrentAssignmentCohort(pool, {
      ...snapshot,
      snapshotDigest: digest(snapshot),
    });

    expect(report.occurrences).toEqual([
      { occurrenceId: "active", disposition: "Accepted", reason: "Imported" },
      { occurrenceId: "inactive", disposition: "Quarantined", reason: "Inactive" },
      { occurrenceId: "invalid", disposition: "Quarantined", reason: "InvalidRow" },
    ]);
    expect(
      (await database.query("SELECT person_id, active, day, block FROM assistant_placements")).rows,
    ).toEqual([{ person_id: "person", active: true, day: "Monday", block: "1" }]);
  } finally {
    await runtime.dispose();
    await database.close();
  }
}, 15_000);
