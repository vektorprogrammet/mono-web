import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutatePlacementBoard,
  readOwnAffiliation,
  readPlacementBoard,
} from "@vektorprogrammet/domain/placements";
import { Effect } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";
const runtime = makeControlledTestRuntime(DatabaseTest());
afterAll(() => runtime.dispose());
const scope = {
  departmentId: DepartmentId.make("placement-department"),
  semesterId: SemesterId.make("placement-semester"),
};
const volunteer = PersonId.make("placement-volunteer");
const coordinator = PersonId.make("placement-coordinator");
const now = "2026-09-06T00:00:00.000Z";
describe("canonical placement persistence", () => {
  it("retains audited parent, distinct blocks and person across create/edit/remove and affiliation revocation", async () => {
    const observed = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Placement department','PD','placement@example.invalid','Trondheim')`;
            yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2024-08-01T00:00:00Z','2024-12-31T00:00:00Z')`;
            yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${volunteer},'Vera','Volunteer'),(${coordinator},'Cora','Coordinator')`;
            const schools = yield* sql<{
              schoolId: number;
            }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Placement school','Contact','school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;
            const schoolId = SchoolId.make(schools[0]!.schoolId);
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${scope.departmentId})`;
            yield* lockPlacementDepartment(scope.departmentId);
            const absent = yield* readOwnAffiliation(volunteer, scope.departmentId);
            const pending = yield* mutateAffiliation(absent, "Request", volunteer, now);
            const active = yield* mutateAffiliation(pending, "Establish", coordinator, now);
            const one = `placement-${"1".repeat(64)}`;
            const two = `placement-${"2".repeat(64)}`;
            const values = { schoolId, day: "Monday" as const, workdays: 4, block: "1" as const };
            yield* mutatePlacementBoard(
              scope,
              { action: "Create", personId: volunteer, ...values },
              coordinator,
              now,
              one,
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Create", personId: volunteer, ...values, block: "2" },
              coordinator,
              now,
              two,
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Edit", placementId: one, ...values, day: "Friday", workdays: 8 },
              coordinator,
              now,
              "unused",
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Remove", placementId: one },
              coordinator,
              now,
              "unused",
            );
            yield* mutateAffiliation(active, "Revoke", coordinator, now);
            const board = yield* readPlacementBoard(scope);
            const audit =
              yield* sql`SELECT placement_id AS "placementId",revision,action,snapshot->>'active' AS active FROM assistant_placement_audit ORDER BY placement_id,revision`;
            const people =
              yield* sql`SELECT person_id,first_name,last_name FROM person_profiles WHERE person_id=${volunteer}`;
            const inactive = yield* Effect.flip(
              mutatePlacementBoard(
                scope,
                { action: "Create", personId: volunteer, ...values },
                coordinator,
                now,
                `placement-${"3".repeat(64)}`,
              ),
            );
            return { board, audit, people, inactive };
          }),
        ),
      ),
    );
    expect(observed.board.placements).toMatchObject([
      { active: false, revision: 3, day: "Friday", workdays: 8, block: "1" },
      { active: true, revision: 1, day: "Monday", workdays: 4, block: "2" },
    ]);
    expect(observed.audit.map((row) => [row.revision, row.action, row.active])).toEqual([
      [1, "Create", "true"],
      [2, "Edit", "true"],
      [3, "Remove", "false"],
      [1, "Create", "true"],
    ]);
    expect(observed.board.affiliations[0]?.status).toBe("Inactive");
    expect(observed.people).toEqual([
      { person_id: volunteer, first_name: "Vera", last_name: "Volunteer" },
    ]);
    expect(observed.inactive).toMatchObject({ code: "affiliation.inactive" });
  }, 15000);
});
