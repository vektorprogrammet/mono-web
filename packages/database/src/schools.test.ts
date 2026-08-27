import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { databaseSchemaRevision } from "./migrations.js";
import {
  DepartmentId,
  OrganizationAuthorityInstantSchema,
  OrganizationLive,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { readSchoolsDirectory, Schools, SchoolsLive } from "@vektorprogrammet/domain/schools";
import { Effect, Layer } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const databaseLayer = DatabaseTest();
const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
const schoolsLayer = SchoolsLive.pipe(Layer.provide(databaseLayer));
const runtime = makeControlledTestRuntime(
  Layer.mergeAll(databaseLayer, organizationLayer, schoolsLayer),
);

afterAll(async () => {
  await runtime.dispose();
});

describe("Schools application migration in PGlite", () => {
  it("replays the ordered application manifest through the final revision without changing rows", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO public.schools_directory_schools (
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
          FROM public.schools_directory_schools AS school
          WHERE school.name = 'Replay School'
        `;
        yield* database`
          DELETE FROM public.schools_directory_schools AS school
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
      revision: databaseSchemaRevision,
      migrationRows: [{ migrationId: 19, name: "schools-directory" }],
      schoolCount: "1",
    });
  }, 15_000);

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
          INSERT INTO public.schools_directory_schools (
            name, contact_person, email, phone, language, active
          ) VALUES (
            'Foreign Key School', 'FK Contact', 'fk@example.invalid', '+47 900 00 002',
            'International', FALSE
          )
          RETURNING school_id::text AS "schoolId"
        `;
        const schoolId = schools[0]!.schoolId;
        yield* database`
          INSERT INTO public.schools_directory_departments (school_id, department_id)
          VALUES (${schoolId}::bigint, 'schools-fk-department')
        `;

        const missingSchoolFailure = yield* Effect.flip(
          database`
            INSERT INTO public.schools_directory_departments (school_id, department_id)
            VALUES (9007199254740991, 'schools-fk-department')
          `,
        );
        const missingDepartmentFailure = yield* Effect.flip(
          database`
            INSERT INTO public.schools_directory_departments (school_id, department_id)
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
          DELETE FROM public.schools_directory_schools AS school
          WHERE school.school_id = ${schoolId}::bigint
        `;
        const associations = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS "count"
          FROM public.schools_directory_departments AS association
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

  it("runs the named journey against the canonical non-locking Organization projection", async () => {
    const directory = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const departmentId = DepartmentId.make("schools-journey-pglite");
        const personId = PersonId.make("schools-journey-pglite-person");
        yield* database`
          INSERT INTO organization_departments (
            department_id, name, short_name, email, city
          ) VALUES (
            ${departmentId}, 'Journey Department', 'SJP',
            'schools-journey-pglite@example.invalid', 'Oslo'
          )
        `;
        yield* database`
          INSERT INTO organization_teams (team_id, department_id, name)
          VALUES ('schools-journey-pglite-team', ${departmentId}, 'Journey Team')
        `;
        yield* database`
          INSERT INTO organization_memberships (
            membership_id, person_id, team_id, start_at, position_id
          ) VALUES (
            'schools-journey-pglite-membership',
            ${personId},
            'schools-journey-pglite-team',
            '2031-01-01T00:00:00.000Z',
            'member'
          )
        `;
        const inserted = yield* database<{ readonly schoolId: string }>`
          INSERT INTO public.schools_directory_schools (
            name, contact_person, email, phone, language, active
          ) VALUES (
            'Journey School', 'Journey Contact', 'journey-school@example.invalid',
            '+47 900 00 030', 'Norwegian', TRUE
          )
          RETURNING school_id::text AS "schoolId"
        `;
        yield* database`
          INSERT INTO public.schools_directory_departments (school_id, department_id)
          VALUES (${inserted[0]!.schoolId}::bigint, ${departmentId})
        `;
        const directory = yield* readSchoolsDirectory(
          personId,
          OrganizationAuthorityInstantSchema.make("2032-01-01T00:00:00.000Z"),
          {},
        );
        yield* database`
          DELETE FROM public.schools_directory_schools AS school
          WHERE school.school_id = ${inserted[0]!.schoolId}::bigint
        `;
        yield* database`
          DELETE FROM organization_memberships AS membership
          WHERE membership.membership_id = 'schools-journey-pglite-membership'
        `;
        yield* database`
          DELETE FROM organization_teams AS team
          WHERE team.team_id = 'schools-journey-pglite-team'
        `;
        yield* database`
          DELETE FROM organization_departments AS department
          WHERE department.department_id = ${departmentId}
        `;
        return directory;
      }),
    );

    expect(directory).toEqual({
      activeSchools: [
        {
          schoolId: directory.activeSchools[0]?.schoolId,
          name: "Journey School",
          contactPerson: "Journey Contact",
          email: "journey-school@example.invalid",
          phone: "+47 900 00 030",
          language: "Norwegian",
          departments: [
            {
              departmentId: "schools-journey-pglite",
              name: "Journey Department",
            },
          ],
          isActive: true,
        },
      ],
      inactiveSchools: [],
    });
  });

  it("returns one deterministic full directory and intersects visible departments", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const schools = yield* Schools;
        const departmentA = DepartmentId.make("schools-full-a");
        const departmentB = DepartmentId.make("schools-full-b");
        yield* database`
          INSERT INTO organization_departments (
            department_id, name, short_name, email, city
          ) VALUES
            (
              ${departmentA}, 'Department A', 'SA',
              'schools-full-a@example.invalid', 'Bergen'
            ),
            (
              ${departmentB}, 'Department B', 'SB',
              'schools-full-b@example.invalid', 'Trondheim'
            )
        `;
        const inserted = yield* database<{
          readonly schoolId: string;
          readonly email: string;
          readonly name: string;
        }>`
          INSERT INTO public.schools_directory_schools (
            name, contact_person, email, phone, language, active
          ) VALUES
            (
              'Admin only', 'Admin Contact', 'admin-only@example.invalid',
              '+47 900 00 010', 'Norwegian', TRUE
            ),
            (
              'Alpha', 'Alpha A Contact', 'alpha-a@example.invalid',
              '+47 900 00 011', 'Norwegian', TRUE
            ),
            (
              'Alpha', 'Alpha B Contact', 'alpha-b@example.invalid',
              '+47 900 00 012', 'International', TRUE
            ),
            (
              'Shared', 'Shared Contact', 'shared@example.invalid',
              '+47 900 00 013', 'Norwegian', TRUE
            ),
            (
              'Zulu inactive', 'Zulu Contact', 'zulu@example.invalid',
              '+47 900 00 014', 'International', FALSE
            )
          RETURNING
            school_id::text AS "schoolId",
            email AS "email",
            name AS "name"
        `;
        const idByEmail = new Map(
          inserted.map((row) => [row.email, Number(row.schoolId)] as const),
        );
        yield* database`
          INSERT INTO public.schools_directory_departments (school_id, department_id)
          VALUES
            (${idByEmail.get("alpha-a@example.invalid")}::bigint, ${departmentA}),
            (${idByEmail.get("alpha-b@example.invalid")}::bigint, ${departmentB}),
            (${idByEmail.get("shared@example.invalid")}::bigint, ${departmentA}),
            (${idByEmail.get("shared@example.invalid")}::bigint, ${departmentB}),
            (${idByEmail.get("zulu@example.invalid")}::bigint, ${departmentA})
        `;

        const directory = yield* schools.listDirectory({
          scope: { _tag: "All" },
        });
        const scoped = yield* schools.listDirectory({
          scope: { _tag: "DepartmentIds", departmentIds: [departmentA, departmentB] },
        });
        const shared = scoped.activeSchools.find(
          (school) => school.email === "shared@example.invalid",
        );
        const narrowed = yield* schools.listDirectory({
          scope: { _tag: "DepartmentIds", departmentIds: [departmentA, departmentB] },
          departmentId: departmentA,
        });
        const narrowedShared = narrowed.activeSchools.find(
          (school) => school.email === "shared@example.invalid",
        );
        const exceededScopeTag = yield* Effect.flip(
          schools.listDirectory({
            scope: { _tag: "DepartmentIds", departmentIds: [departmentA] },
            departmentId: departmentB,
          }),
        ).pipe(Effect.map((failure) => failure._tag));
        const fullSchoolIds = [
          ...directory.activeSchools.map((school) => school.schoolId),
          ...directory.inactiveSchools.map((school) => school.schoolId),
        ];

        return {
          fullActiveEmails: directory.activeSchools.map((school) => school.email),
          fullInactiveEmails: directory.inactiveSchools.map((school) => school.email),
          fullSchoolCount: fullSchoolIds.length,
          uniqueFullSchoolIds: new Set(fullSchoolIds).size,
          sharedDepartments: shared?.departments,
          narrowedSharedDepartments: narrowedShared?.departments,
          scopedActiveEmails: scoped.activeSchools.map((school) => school.email),
          scopedInactiveEmails: scoped.inactiveSchools.map((school) => school.email),
          adminOnlyDepartments: directory.activeSchools.find(
            (school) => school.email === "admin-only@example.invalid",
          )?.departments,
          exceededScopeTag,
        };
      }),
    );

    expect(evidence).toEqual({
      fullActiveEmails: [
        "admin-only@example.invalid",
        "alpha-a@example.invalid",
        "alpha-b@example.invalid",
        "shared@example.invalid",
      ],
      fullInactiveEmails: ["zulu@example.invalid"],
      fullSchoolCount: 5,
      uniqueFullSchoolIds: 5,
      sharedDepartments: [
        { departmentId: "schools-full-a", name: "Department A" },
        { departmentId: "schools-full-b", name: "Department B" },
      ],
      narrowedSharedDepartments: [{ departmentId: "schools-full-a", name: "Department A" }],
      scopedActiveEmails: [
        "alpha-a@example.invalid",
        "alpha-b@example.invalid",
        "shared@example.invalid",
      ],
      scopedInactiveEmails: ["zulu@example.invalid"],
      adminOnlyDepartments: [],
      exceededScopeTag: "SchoolsDecodeError",
    });
  });
});
