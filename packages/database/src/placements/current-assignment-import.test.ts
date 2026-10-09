/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { importPersonCohort, PersonMapping } from "../person-cohort.js";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Cause, Context, Deferred, Effect, Exit, Fiber, flow, Layer, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import {
  importCurrentAssignmentCohort,
  importReconciledCurrentAssignmentCohort,
} from "./current-assignment-cohort.js";

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const digest = flow(canonicalJsonBytes, sha256Hex);

/** One migrated native client owns each test; its layer closes on every exit. */
const withAssignmentDatabase = <A, E, R>(
  action: (database: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(DatabaseTestLive());
      const database = Context.get(services, Database);
      yield* database.health;
      yield* database.unsafe(`INSERT INTO organization_departments(department_id,name,short_name,email,city)
    VALUES('department','Department','D','d@example.invalid','Trondheim')`);
      yield* database.unsafe(`INSERT INTO admission_period_semesters(semester_id,start_at,end_at)
    VALUES('semester','2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`);
      yield* database.unsafe(`INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active)
    OVERRIDING SYSTEM VALUE VALUES(1,'School','Contact','school@example.invalid','12345678','Norwegian',true)`);
      yield* database.unsafe(
        `INSERT INTO schools_directory_departments(school_id,department_id) VALUES(1,'department')`,
      );

      return yield* action(database);
    }),
  );

it.live(
  "imports the active candidate when inactive and invalid-digest rows name the same target",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        yield* importPersonCohort(database, {
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

        const report = yield* importCurrentAssignmentCohort(database, {
          ...snapshot,
          snapshotDigest: digest(snapshot),
        });

        expect(report.occurrences).toEqual([
          { occurrenceId: "active", disposition: "Accepted", reason: "Imported" },
          { occurrenceId: "inactive", disposition: "Quarantined", reason: "Inactive" },
          { occurrenceId: "invalid", disposition: "Quarantined", reason: "InvalidRow" },
        ]);
        expect(
          yield* database.unsafe("SELECT person_id, active, day, block FROM assistant_placements"),
        ).toEqual([{ person_id: "person", active: true, day: "Monday", block: "1" }]);
      }),
    ),
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

const reviewedSnapshot = (
  database: SqlClient.SqlClient,
  snapshotId: string,
  personSnapshotKey: string,
  assignments: ReadonlyArray<ReviewedFixtureRow>,
) =>
  Effect.gen(function* () {
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
    const referenceMappingsJson = yield* jsonText(referenceMappings);
    yield* database.unsafe(
      `INSERT INTO historical_service_reference_provenance
     (source_repository, source_revision, snapshot_id, reference_digest, source_id_mappings)
           VALUES ('review-source',$1,$1,$2,$3::jsonb)`,
      [snapshotId, referenceDigest, referenceMappingsJson],
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
  });

it.live(
  "binds each accepted Person to its own snapshot and supports later-snapshot exact replay",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        yield* importPersonCohort(
          database,
          personSnapshot("old", [{ user: "user-a", occurrence: "row-1" }]),
        );

        const currentPeople = yield* importPersonCohort(
          database,
          personSnapshot("current", [{ user: "user-b", occurrence: "row-1" }]),
        );

        const current = yield* reviewedSnapshot(database, "current", currentPeople.snapshotKey, [
          { id: "assignment-a", user: "user-a", school: 1, active: true, day: "Monday" },
          { id: "assignment-b", user: "user-b", school: 1, active: true, day: "Monday" },
        ]);

        expect(
          (yield* importReconciledCurrentAssignmentCohort(database, current)).occurrences,
        ).toEqual([
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

        const laterPeople = yield* importPersonCohort(database, laterPeopleSnapshot);
        expect(laterPeople.occurrences).toEqual([
          { occurrenceId: "row-2", disposition: "Accepted", reason: "ExactReplay" },
        ]);

        const later = yield* reviewedSnapshot(database, "later", laterPeople.snapshotKey, [
          { id: "assignment-a", user: "user-a", school: 1, active: true, day: "Monday" },
        ]);

        expect(
          (yield* importReconciledCurrentAssignmentCohort(database, later)).occurrences,
        ).toEqual([{ occurrenceId: "assignment-a", disposition: "Accepted", reason: "Imported" }]);
        yield* database.unsafe(
          "UPDATE assistant_placements SET active=false WHERE person_id='person-user-a'",
        );
        yield* importPersonCohort(database, laterPeopleSnapshot);
        yield* importReconciledCurrentAssignmentCohort(database, later);
        expect(
          yield* database.unsafe(
            "SELECT active FROM assistant_placements WHERE person_id='person-user-a'",
          ),
        ).toEqual([{ active: false }]);
      }),
    ),
  15_000,
);

it.live(
  "quarantines missing source associations per row even when a stale native association exists",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        yield* database.unsafe(`INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active)
          OVERRIDING SYSTEM VALUE VALUES(2,'Stale school','Contact','school2@example.invalid','12345678','Norwegian',true)`);
        yield* database.unsafe(
          `INSERT INTO schools_directory_departments(school_id,department_id) VALUES(2,'department')`,
        );

        const people = yield* importPersonCohort(
          database,
          personSnapshot("associations", [{ user: "user-a", occurrence: "row-1" }]),
        );

        const snapshot = yield* reviewedSnapshot(database, "associations", people.snapshotKey, [
          { id: "active-missing", user: "user-a", school: 2, active: true, day: "Monday" },
          { id: "inactive-missing", user: "user-a", school: 2, active: false, day: "Monday" },
          { id: "invalid-missing", user: "user-a", school: 2, active: true, day: null },
          { id: "valid", user: "user-a", school: 1, active: true, day: "Monday" },
        ]);

        expect(
          (yield* importReconciledCurrentAssignmentCohort(database, snapshot)).occurrences,
        ).toEqual([
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
          yield* database.unsafe("SELECT school_id::integer AS school FROM assistant_placements"),
        ).toEqual([{ school: 1 }]);
      }),
    ),
  15_000,
);

class AssignmentTestRollback extends Schema.TaggedError<AssignmentTestRollback>()(
  "AssignmentTestRollback",
  {},
) {}

const snapshotWithoutMappings = (snapshotId: string) => {
  const row = {
    sourceAssignmentId: snapshotId,
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

  const snapshot = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId,
    sourceWatermark: "watermark",
    transformationRevision: "test",
    synthetic: true as const,
    occurrences: [{ occurrenceId: "row", row: { ...row, sourceRowDigest: digest(row) } }],
    mappings: [],
  };

  return { ...snapshot, snapshotDigest: digest(snapshot) };
};

it.live(
  "empty mappings import and replay without binding an empty PostgreSQL array",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        const snapshot = snapshotWithoutMappings("empty");
        const first = yield* importCurrentAssignmentCohort(database, snapshot);
        expect(first.input).toBe(1);
        expect(first.accepted).toBe(0);
        expect(first.occurrences).toEqual([
          { occurrenceId: "row", disposition: "Quarantined", reason: "MappingMissing" },
        ]);
        expect(yield* importCurrentAssignmentCohort(database, snapshot)).toEqual(first);
      }),
    ),
  15_000,
);

it.live(
  "a caller failure rolls back a completed nested import and leaves its client reusable",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.flip(
          database.withTransaction(
            Effect.gen(function* () {
              yield* importCurrentAssignmentCohort(database, snapshotWithoutMappings("failed"));

              return yield* new AssignmentTestRollback();
            }),
          ),
        );

        expect(Schema.is(AssignmentTestRollback)(outcome)).toBe(true);

        const rows = yield* database.unsafe(
          "SELECT snapshot_key FROM current_assignment_snapshots WHERE snapshot_id='failed'",
        );

        expect(rows).toEqual([]);
        expect(
          (yield* importCurrentAssignmentCohort(database, snapshotWithoutMappings("after-failure")))
            .input,
        ).toBe(1);
      }),
    ),
  15_000,
);

it.live(
  "interrupting a caller rolls back nested provenance before releasing the native client",
  () =>
    withAssignmentDatabase((database) =>
      Effect.gen(function* () {
        const imported = yield* Deferred.make<void>();

        const fiber = yield* Effect.forkChild(
          database.withTransaction(
            Effect.gen(function* () {
              yield* importCurrentAssignmentCohort(
                database,
                snapshotWithoutMappings("interrupted"),
              );
              yield* Deferred.succeed(imported, undefined);

              return yield* Effect.never;
            }),
          ),
        );

        yield* Deferred.await(imported);
        yield* Fiber.interrupt(fiber);
        const outcome = yield* Fiber.await(fiber);
        expect(Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)).toBe(true);
        expect(
          yield* database.unsafe(
            "SELECT snapshot_key FROM current_assignment_snapshots WHERE snapshot_id='interrupted'",
          ),
        ).toEqual([]);
        expect(
          (yield* importCurrentAssignmentCohort(
            database,
            snapshotWithoutMappings("after-interruption"),
          )).input,
        ).toBe(1);
      }),
    ),
  15_000,
);
