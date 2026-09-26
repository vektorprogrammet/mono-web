import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  DepartmentId,
  Organization,
  OrganizationAuthorityInstantSchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { SchoolsLive } from "./postgres-layer.js";
import { readSchoolsDirectory } from "./directory.js";

const personId = PersonId.make("schools-journey-person");

const inactivePersonId = PersonId.make("schools-inactive-person");

const absentPersonId = PersonId.make("schools-absent-person");

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2032-03-01T12:00:00.000Z");

const otherInstant = OrganizationAuthorityInstantSchema.make("2032-03-01T12:00:00.001Z");

const departmentA = DepartmentId.make("schools-journey-a");

const departmentB = DepartmentId.make("schools-journey-b");

const outsideDepartmentId = DepartmentId.make("schools-journey-outside");

const suiteLayer = SchoolsLive.pipe(
  Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
);

const suiteSeed = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql`
INSERT INTO person_profiles (person_id, first_name, last_name)
VALUES (${personId}, 'School', 'Member'),
  (${inactivePersonId}, 'Inactive', 'Administrator'),
  (${absentPersonId}, 'Unappointed', 'Person')
    `;
    yield* sql`
INSERT INTO organization_departments (department_id, name, short_name, email, city)
VALUES (${departmentA}, 'Department A', 'DA', 'a@example.invalid', 'Oslo'),
  (${departmentB}, 'Department B', 'DB', 'b@example.invalid', 'Bergen'),
  (${outsideDepartmentId}, 'Outside', 'OUT', 'out@example.invalid', 'Trondheim')
    `;
    yield* sql`
INSERT INTO organization_teams (team_id, department_id, name)
VALUES ('schools-team-a', ${departmentA}, 'Team A'),
  ('schools-team-b', ${departmentB}, 'Team B')
    `;
    yield* sql`
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, start_at, end_at, is_team_leader
) VALUES ('schools-membership-a', ${personId}, 'schools-team-a',
    '2030-01-01T00:00:00.000Z', ${otherInstant}, TRUE),
  ('schools-membership-b', ${personId}, 'schools-team-b',
    '2030-01-01T00:00:00.000Z', NULL, FALSE)
    `;
    yield* sql`
INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at)
VALUES ('schools-expired-grant', ${inactivePersonId},
  '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z')
    `;
    yield* sql`
INSERT INTO schools_directory_schools (
  name, contact_person, email, phone, language, active
) VALUES ('A School', 'Contact A', 'a@school.invalid', '+4700000001', 'Norwegian', TRUE),
  ('B School', 'Contact B', 'b@school.invalid', '+4700000002', 'Norwegian', TRUE),
  ('Outside School', 'Contact C', 'c@school.invalid', '+4700000003', 'Norwegian', TRUE)
    `;
    yield* sql`
INSERT INTO schools_directory_departments (school_id, department_id)
SELECT school_id, CASE name WHEN 'A School' THEN ${departmentA}
  WHEN 'B School' THEN ${departmentB} ELSE ${outsideDepartmentId} END
FROM schools_directory_schools
    `;
  }),
);

layer(suiteSeed.pipe(Layer.provideMerge(suiteLayer)), {
  excludeTestServices: true,
  timeout: "30 seconds",
})((it) => {
  it.effect("unions memberships at the supplied instant and excludes an expired membership", () =>
    Effect.gen(function* () {
      const visible = yield* readSchoolsDirectory(personId, authorizationInstant, {});

      const afterExpiry = yield* readSchoolsDirectory(personId, otherInstant, {});

      expect(visible.activeSchools.map((school) => school.name)).toEqual(["A School", "B School"]);
      expect(visible.activeSchools.flatMap((school) => school.departments)).toEqual([
        { departmentId: departmentA, name: "Department A" },
        { departmentId: departmentB, name: "Department B" },
      ]);
      expect(afterExpiry.activeSchools.map((school) => school.name)).toEqual(["B School"]);
    }),
  );

  it.effect("maps inactive and absent Organization projections to distinct typed denials", () =>
    Effect.gen(function* () {
      const inactive = yield* Effect.flip(
        readSchoolsDirectory(inactivePersonId, authorizationInstant, {}),
      );

      const absent = yield* Effect.flip(
        readSchoolsDirectory(absentPersonId, authorizationInstant, {}),
      );

      expect(inactive._tag).toBe("AuthorityInactive");
      expect(absent._tag).toBe("NotInScope");
    }),
  );

  it.effect("checks that a narrowing department exists before rejecting an out-of-scope one", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.flip(
        readSchoolsDirectory(personId, authorizationInstant, { departmentId: outsideDepartmentId }),
      );

      const unknown = yield* Effect.flip(
        readSchoolsDirectory(personId, authorizationInstant, {
          departmentId: DepartmentId.make("schools-unknown-department"),
        }),
      );

      expect(outside._tag).toBe("SchoolsDepartmentOutOfScope");
      expect(unknown._tag).toBe("SchoolsDepartmentNotFound");
    }),
  );

  it.effect("rejects an Organization projection evaluated at another instant", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.gen(function* () {
        const organization = yield* Organization;

        const wrongInstant = Organization.of({
          ...organization,
          resolvePersonAuthorityForRead: (resolvedPersonId, instant) =>
            organization
              .resolvePersonAuthorityForRead(resolvedPersonId, instant)
              .pipe(Effect.map((projection) => ({ ...projection, evaluatedAt: otherInstant }))),
        });

        return yield* Effect.flip(
          readSchoolsDirectory(personId, authorizationInstant, {}).pipe(
            Effect.provideService(Organization, wrongInstant),
          ),
        );
      });

      expect(failure._tag).toBe("SchoolsDecodeError");
    }),
  );
});
