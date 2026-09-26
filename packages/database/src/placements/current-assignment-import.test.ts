import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { databaseHealth } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { importPersonCohort as importPersonCohortEffect, PersonMapping } from "../person-cohort.js";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, flow, ManagedRuntime, Schema } from "effect";
import { Pool, type PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import {
  importCurrentAssignmentCohort as importCurrentAssignmentCohortEffect,
  importReconciledCurrentAssignmentCohort as importReconciledCurrentAssignmentCohortEffect,
} from "./current-assignment-cohort.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const importCurrentAssignmentCohort = flow(importCurrentAssignmentCohortEffect, Effect.runPromise);

const importReconciledCurrentAssignmentCohort = flow(
  importReconciledCurrentAssignmentCohortEffect,
  Effect.runPromise,
);

const digest = flow(Schema.decodeUnknownSync(Schema.Json), (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex"),
);

const withAssignmentDatabase = async (
  action: (database: PGlite, pool: Pool) => Promise<void>,
): Promise<void> => {
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
    await action(database, pool);
  } finally {
    await pool.end();
    await runtime.dispose();
    await database.close();
  }
};

it(
  "imports the active candidate when inactive and invalid-digest rows name the same target",
  () =>
    withAssignmentDatabase(async (database, pool) => {
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
        (await database.query("SELECT person_id, active, day, block FROM assistant_placements"))
          .rows,
      ).toEqual([{ person_id: "person", active: true, day: "Monday", block: "1" }]);
    }),
  15_000,
);

const personSnapshot = (
  snapshotId: string,
  users: ReadonlyArray<{ user: string; occurrence: string }>,
) => ({
  sourceRepository: "review-source",
  sourceRevision: snapshotId,
  snapshotId,
  transformationRevision: "test",
  sourceKind: "LegacyBackup" as const,
  occurrences: users.map(({ user, occurrence }) => {
    const row = {
      sourceUserId: user,
      active: true,
      firstName: "Ada",
      lastName: "Volunteer",
      email: user + "@example.invalid",
      phone: "12345678",
    };

    return { occurrenceId: occurrence, row, sourceRowDigest: digest(row) };
  }),
  mappings: users.map(({ user }) =>
    PersonMapping.cases.CreatePerson.make({
      sourceUserId: user,
      personId: PersonId.make("person-" + user),
      emailOwnership: {
        email: user + "@example.invalid",
        attestedBy: "reviewer",
        evidenceRef: "person-evidence",
      },
    }),
  ),
});

interface ReviewedFixtureRow {
  readonly id: string;
  readonly user: string;
  readonly school: 1 | 2;
  readonly active: boolean;
  readonly day: string | null;
}

const reviewedSnapshot = async (
  database: PGlite,
  snapshotId: string,
  personSnapshotKey: string,
  assignments: ReadonlyArray<ReviewedFixtureRow>,
) => {
  const referenceMappings = {
    departments: [{ sourceDepartmentId: "source-department", departmentId: "department" }],
    semesters: [{ sourceSemesterId: "source-semester", semesterId: "semester" }],
    schools: [
      { sourceSchoolId: "school-1", schoolId: 1 },
      { sourceSchoolId: "school-2", schoolId: 2 },
    ],
    relationships: [
      {
        sourceDepartmentId: "source-department",
        departmentId: "department",
        sourceSchoolId: "school-1",
        schoolId: 1,
      },
    ],
  };

  const referenceDigest = digest(referenceMappings);
  await database.query(
    `INSERT INTO historical_service_reference_provenance
       (source_repository, source_revision, snapshot_id, reference_digest, source_id_mappings)
     VALUES ('review-source',$1,$1,$2,$3::jsonb)`,
    [snapshotId, referenceDigest, JSON.stringify(referenceMappings)],
  );

  const rows = assignments.map(({ id, user, school, active, day }) => ({
    sourceAssignmentId: id,
    sourceUserId: user,
    sourceDepartmentId: "source-department",
    sourceSemesterId: "source-semester",
    sourceSchoolId: "school-" + school,
    affiliationEvidenceRef: "affiliation",
    placementEvidenceRef: "placement",
    day,
    workdays: 4,
    block: "1",
    active,
  }));

  const review = {
    sourceRevision: snapshotId,
    sourceWatermark: "watermark",
    sourceSemesterId: "source-semester",
    asOf: "2026-09-24",
    attestedBy: "reviewer",
    evidenceRef: "review-evidence",
    assignments: rows.map(
      ({ sourceAssignmentId, active, affiliationEvidenceRef, placementEvidenceRef }) => ({
        sourceAssignmentId,
        active,
        affiliationEvidenceRef,
        placementEvidenceRef,
        sourceRowDigest: digest({ legacyId: sourceAssignmentId }),
      }),
    ),
  };

  const snapshot = {
    sourceRepository: "review-source",
    sourceRevision: snapshotId,
    snapshotId,
    sourceWatermark: "watermark",
    transformationRevision: "test",
    synthetic: false as const,
    review,
    referenceDigest,
    personSnapshotKey,
    occurrences: rows.map((row) => ({
      occurrenceId: row.sourceAssignmentId,
      row: { ...row, sourceRowDigest: digest(row) },
    })),
    mappings: rows.map((row, index) => ({
      sourceAssignmentId: row.sourceAssignmentId,
      sourceUserId: row.sourceUserId,
      sourceDepartmentId: row.sourceDepartmentId,
      sourceSemesterId: row.sourceSemesterId,
      sourceSchoolId: row.sourceSchoolId,
      personId: "person-" + row.sourceUserId,
      departmentId: "department",
      semesterId: "semester",
      schoolId: assignments[index]!.school,
    })),
  };

  return { ...snapshot, snapshotDigest: digest(snapshot) };
};

it(
  "binds each accepted Person to its own snapshot and supports later-snapshot exact replay",
  () =>
    withAssignmentDatabase(async (database, pool) => {
      await importPersonCohort(
        pool,
        personSnapshot("old", [{ user: "user-a", occurrence: "row-1" }]),
      );

      const currentPeople = await importPersonCohort(
        pool,
        personSnapshot("current", [{ user: "user-b", occurrence: "row-1" }]),
      );

      const current = await reviewedSnapshot(database, "current", currentPeople.snapshotKey, [
        { id: "assignment-a", user: "user-a", school: 1, active: true, day: "Monday" },
        { id: "assignment-b", user: "user-b", school: 1, active: true, day: "Monday" },
      ]);

      expect((await importReconciledCurrentAssignmentCohort(pool, current)).occurrences).toEqual([
        {
          occurrenceId: "assignment-a",
          disposition: "Quarantined",
          reason: "PersonReconciliationMissing",
        },
        { occurrenceId: "assignment-b", disposition: "Accepted", reason: "Imported" },
      ]);

      const laterPeopleSnapshot = personSnapshot("later", [
        { user: "user-a", occurrence: "row-2" },
      ]);

      const laterPeople = await importPersonCohort(pool, laterPeopleSnapshot);
      expect(laterPeople.occurrences).toEqual([
        { occurrenceId: "row-2", disposition: "Accepted", reason: "ExactReplay" },
      ]);

      const later = await reviewedSnapshot(database, "later", laterPeople.snapshotKey, [
        { id: "assignment-a", user: "user-a", school: 1, active: true, day: "Monday" },
      ]);

      expect((await importReconciledCurrentAssignmentCohort(pool, later)).occurrences).toEqual([
        { occurrenceId: "assignment-a", disposition: "Accepted", reason: "Imported" },
      ]);
      await database.query(
        "UPDATE assistant_placements SET active=false WHERE person_id='person-user-a'",
      );
      await importPersonCohort(pool, laterPeopleSnapshot);
      await importReconciledCurrentAssignmentCohort(pool, later);
      expect(
        (
          await database.query(
            "SELECT active FROM assistant_placements WHERE person_id='person-user-a'",
          )
        ).rows,
      ).toEqual([{ active: false }]);
    }),
  15_000,
);

it(
  "quarantines missing source associations per row even when a stale native association exists",
  () =>
    withAssignmentDatabase(async (database, pool) => {
      await database.exec(`
      INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active)
        OVERRIDING SYSTEM VALUE VALUES(2,'Stale school','Contact','school2@example.invalid','12345678','Norwegian',true);
      INSERT INTO schools_directory_departments(school_id,department_id) VALUES(2,'department');
    `);

      const people = await importPersonCohort(
        pool,
        personSnapshot("associations", [{ user: "user-a", occurrence: "row-1" }]),
      );

      const snapshot = await reviewedSnapshot(database, "associations", people.snapshotKey, [
        { id: "active-missing", user: "user-a", school: 2, active: true, day: "Monday" },
        { id: "inactive-missing", user: "user-a", school: 2, active: false, day: "Monday" },
        { id: "invalid-missing", user: "user-a", school: 2, active: true, day: null },
        { id: "valid", user: "user-a", school: 1, active: true, day: "Monday" },
      ]);

      expect((await importReconciledCurrentAssignmentCohort(pool, snapshot)).occurrences).toEqual([
        {
          occurrenceId: "active-missing",
          disposition: "Quarantined",
          reason: "SchoolDepartmentMismatch",
        },
        { occurrenceId: "inactive-missing", disposition: "Quarantined", reason: "Inactive" },
        { occurrenceId: "invalid-missing", disposition: "Quarantined", reason: "InvalidRow" },
        { occurrenceId: "valid", disposition: "Accepted", reason: "Imported" },
      ]);
      expect(
        (await database.query("SELECT school_id::integer AS school FROM assistant_placements"))
          .rows,
      ).toEqual([{ school: 1 }]);
    }),
  15_000,
);
