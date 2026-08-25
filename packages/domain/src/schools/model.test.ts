import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { School, SchoolCapacityPlan, SchoolDepartment, SchoolDirectorySchema } from "./schema.js";

it("derives the frozen School persistence and JSON variants", () => {
  expect(Object.keys(School.fields).toSorted()).toEqual([
    "active",
    "contactPerson",
    "email",
    "language",
    "name",
    "phone",
    "revision",
    "schoolId",
  ]);
  expect(Object.keys(School.insert.fields)).not.toContain("schoolId");
  expect(Object.keys(School.insert.fields)).not.toContain("revision");
  expect(Object.keys(School.update.fields)).not.toContain("schoolId");
  expect(Object.keys(School.jsonCreate.fields)).not.toContain("schoolId");
  expect(Object.keys(School.jsonCreate.fields)).not.toContain("revision");
  expect(Object.keys(School.jsonUpdate.fields)).not.toContain("schoolId");
});

it("keeps association and capacity identities canonical", () => {
  expect(Object.keys(SchoolDepartment.fields).toSorted()).toEqual([
    "departmentId",
    "revision",
    "schoolId",
  ]);
  expect(Object.keys(SchoolDepartment.insert.fields).toSorted()).toEqual([
    "departmentId",
    "schoolId",
  ]);
  expect(Object.keys(SchoolCapacityPlan.fields).toSorted()).toEqual([
    "capacityId",
    "departmentId",
    "friday",
    "monday",
    "revision",
    "schoolId",
    "semesterId",
    "thursday",
    "tuesday",
    "wednesday",
  ]);
  expect(Object.keys(SchoolCapacityPlan.jsonCreate.fields)).not.toContain("capacityId");
  expect(Object.keys(SchoolCapacityPlan.jsonCreate.fields)).not.toContain("revision");
  expect(Object.keys(SchoolCapacityPlan.fields)).not.toContain("groups");
});

it.effect("strictly decodes the exact full directory and its partition laws", () =>
  Effect.gen(function* () {
    const entry = {
      schoolId: 1,
      name: "Bergen skole",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 900 00 000",
      language: "Norwegian" as const,
      departments: [
        { departmentId: "bergen", name: "Bergen" },
        { departmentId: "trondheim", name: "Trondheim" },
      ],
      isActive: true,
    };
    const directory = yield* Schema.decodeUnknownEffect(SchoolDirectorySchema)(
      { activeSchools: [entry], inactiveSchools: [] },
      { onExcessProperty: "error" },
    );
    expect(directory.activeSchools[0]?.schoolId).toBe(1);

    const excessFailure = yield* Effect.flip(
      Schema.decodeUnknownEffect(SchoolDirectorySchema)(
        {
          activeSchools: [{ ...entry, capacity: { monday: 2 } }],
          inactiveSchools: [],
        },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(excessFailure)).toContain("capacity");

    const partitionFailure = yield* Effect.flip(
      Schema.decodeUnknownEffect(SchoolDirectorySchema)({
        activeSchools: [],
        inactiveSchools: [entry],
      }),
    );
    expect(String(partitionFailure)).toContain("partitioned");

    const departmentOrderFailure = yield* Effect.flip(
      Schema.decodeUnknownEffect(SchoolDirectorySchema)(
        {
          activeSchools: [
            {
              ...entry,
              departments: entry.departments.toReversed(),
            },
          ],
          inactiveSchools: [],
        },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(departmentOrderFailure)).toContain("departmentId");
  }),
);
