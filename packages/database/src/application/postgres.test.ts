import { afterAll, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { listPublicApplicationCatalog } from "./postgres.js";

const runtime = makeControlledTestRuntime(DatabaseTestLive());

afterAll(() => runtime.dispose());

it("derives catalog validators from persisted revisions and admission boundaries", async () => {
  const observed = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql`INSERT INTO admission_period_departments (department_id, name, revision)
      VALUES ('department-1', 'Realfag', 13)`;
      yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at, revision)
      VALUES ('semester-1', '2031-01-01T00:00:00.000Z', '2031-07-01T00:00:00.000Z', 11)`;
      yield* sql`INSERT INTO admission_periods
      (admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id)
      VALUES ('period-1', 'department-1', 'semester-1', '2031-01-01T00:00:00.000Z', '2031-02-01T00:00:00.000Z', 7, 'seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name, active, revision)
      VALUES ('field-1', 'department-1', 'Matematikk', TRUE, 17)`;
      const before = yield* listPublicApplicationCatalog({ now: "2031-01-15T12:00:00.000Z" });
      const unchanged = yield* listPublicApplicationCatalog({ now: "2031-01-15T12:00:00.000Z" });
      yield* sql`UPDATE admission_period_fields_of_study SET revision = revision + 1 WHERE field_of_study_id = 'field-1'`;
      const revised = yield* listPublicApplicationCatalog({ now: "2031-01-15T12:00:00.000Z" });
      const closed = yield* listPublicApplicationCatalog({ now: "2031-02-01T00:00:00.000Z" });

      return { before, unchanged, revised, closed };
    }),
  );

  expect(observed.before.catalog).toEqual({
    departments: [
      {
        departmentId: "department-1",
        name: "Realfag",
        closesAt: "2031-02-01T00:00:00.000Z",
        fieldsOfStudy: [{ fieldOfStudyId: "field-1", name: "Matematikk" }],
      },
    ],
  });
  expect(observed.before.validatorSource).toEqual({
    intervalIdentity: "2031-01-01T00:00:00.000Z/2031-02-01T00:00:00.000Z",
    itemRevisions: [
      ["admission-department:department-1", 13],
      ["admission-field-of-study:field-1", 17],
      ["admission-period:period-1", 7],
      ["admission-semester:semester-1", 11],
    ],
  });
  expect(observed.unchanged).toEqual(observed.before);
  expect(observed.revised.catalog).toEqual(observed.before.catalog);
  expect(observed.revised.validatorSource).not.toEqual(observed.before.validatorSource);
  expect(observed.closed.catalog.departments).toEqual([]);
  expect(observed.closed.validatorSource.intervalIdentity).not.toBe(
    observed.before.validatorSource.intervalIdentity,
  );
}, 15_000);
