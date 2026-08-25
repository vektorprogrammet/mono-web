import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { Effect, ManagedRuntime } from "effect";
import { DatabaseTest } from "./layers.js";

const runtime = ManagedRuntime.make(DatabaseTest());

afterAll(async () => {
  await runtime.dispose();
});

describe("Schools application migration in PGlite", () => {
  it("uses revision 19 and replays the ordered application manifest without changing rows", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO schools_directory_schools (
            name, contact_person, email, phone, language, active
          ) VALUES (
            'Replay School', 'Replay Contact', 'replay@example.invalid', '+47 900 00 001',
            'Norwegian', TRUE
          )
        `;
        yield* database.migrate;
        const migrationRows = yield* database<{
          readonly migrationId: number;
          readonly name: string;
        }>`
          SELECT
            migration.migration_id AS "migrationId",
            migration.name AS "name"
          FROM vektorprogrammet_schema_migrations AS migration
          WHERE migration.migration_id = 19
        `;
        const schoolRows = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS "count"
          FROM schools_directory_schools AS school
          WHERE school.name = 'Replay School'
        `;
        return {
          revision: database.schemaRevision,
          migrationRows,
          schoolCount: schoolRows[0]?.count,
        };
      }),
    );

    expect(evidence).toEqual({
      revision: "19_schools-directory",
      migrationRows: [{ migrationId: 19, name: "schools-directory" }],
      schoolCount: "1",
    });
  });

  it("enforces both association foreign keys, restricts departments, and cascades schools", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO organization_departments (
            department_id, name, short_name, email, city
          ) VALUES (
            'schools-fk-department', 'Schools FK Department', 'SFK',
            'schools-fk@example.invalid', 'Bergen'
          )
        `;
        const schools = yield* database<{ readonly schoolId: string }>`
          INSERT INTO schools_directory_schools (
            name, contact_person, email, phone, language, active
          ) VALUES (
            'Foreign Key School', 'FK Contact', 'fk@example.invalid', '+47 900 00 002',
            'International', FALSE
          )
          RETURNING school_id::text AS "schoolId"
        `;
        const schoolId = schools[0]!.schoolId;
        yield* database`
          INSERT INTO schools_directory_departments (school_id, department_id)
          VALUES (${schoolId}::bigint, 'schools-fk-department')
        `;

        const missingSchoolFailure = yield* Effect.flip(
          database`
            INSERT INTO schools_directory_departments (school_id, department_id)
            VALUES (9007199254740991, 'schools-fk-department')
          `,
        );
        const missingDepartmentFailure = yield* Effect.flip(
          database`
            INSERT INTO schools_directory_departments (school_id, department_id)
            VALUES (${schoolId}::bigint, 'schools-missing-department')
          `,
        );
        const restrictFailure = yield* Effect.flip(
          database`
            DELETE FROM organization_departments AS department
            WHERE department.department_id = 'schools-fk-department'
          `,
        );

        yield* database`
          DELETE FROM schools_directory_schools AS school
          WHERE school.school_id = ${schoolId}::bigint
        `;
        const associations = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS "count"
          FROM schools_directory_departments AS association
          WHERE association.school_id = ${schoolId}::bigint
        `;
        yield* database`
          DELETE FROM organization_departments AS department
          WHERE department.department_id = 'schools-fk-department'
        `;

        return {
          missingSchoolTag: missingSchoolFailure._tag,
          missingDepartmentTag: missingDepartmentFailure._tag,
          restrictTag: restrictFailure._tag,
          associationCount: associations[0]?.count,
        };
      }),
    );

    expect(evidence).toEqual({
      missingSchoolTag: "SqlError",
      missingDepartmentTag: "SqlError",
      restrictTag: "SqlError",
      associationCount: "0",
    });
  });
});
