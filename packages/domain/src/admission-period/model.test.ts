import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  AdmissionDepartment,
  AdmissionFieldOfStudy,
  AdmissionPeriod,
  AdmissionPeriodProjectionSchema,
  AdmissionSemester,
} from "./schema.js";

const keys = (fields: object): ReadonlyArray<string> => Object.keys(fields).sort();

it("derives admission reference and period variants from one Model declaration", () => {
  expect(keys(AdmissionDepartment.fields)).toEqual(["departmentId", "name"]);
  expect(keys(AdmissionDepartment.insert.fields)).toEqual(["departmentId", "name"]);
  expect(keys(AdmissionDepartment.update.fields)).toEqual([]);
  expect(keys(AdmissionDepartment.json.fields)).toEqual(["departmentId", "name"]);

  expect(keys(AdmissionSemester.fields)).toEqual(["endAt", "semesterId", "startAt"]);
  expect(keys(AdmissionSemester.insert.fields)).toEqual(["endAt", "semesterId", "startAt"]);
  expect(keys(AdmissionSemester.update.fields)).toEqual([]);
  expect(keys(AdmissionSemester.json.fields)).toEqual(["endAt", "semesterId", "startAt"]);

  expect(keys(AdmissionFieldOfStudy.fields)).toEqual([
    "active",
    "departmentId",
    "fieldOfStudyId",
    "name",
  ]);
  expect(keys(AdmissionFieldOfStudy.insert.fields)).toEqual([
    "active",
    "departmentId",
    "fieldOfStudyId",
    "name",
  ]);
  expect(keys(AdmissionFieldOfStudy.update.fields)).toEqual([]);

  expect(keys(AdmissionPeriod.fields)).toEqual([
    "departmentId",
    "endAt",
    "id",
    "lastCommandId",
    "revision",
    "semesterId",
    "startAt",
  ]);
  expect(keys(AdmissionPeriod.insert.fields)).toEqual([
    "departmentId",
    "endAt",
    "id",
    "lastCommandId",
    "revision",
    "semesterId",
    "startAt",
  ]);
  expect(keys(AdmissionPeriod.update.fields)).toEqual([
    "endAt",
    "lastCommandId",
    "revision",
    "startAt",
  ]);
  expect(keys(AdmissionPeriod.json.fields)).toEqual([
    "departmentId",
    "endAt",
    "id",
    "lastCommandId",
    "revision",
    "semesterId",
    "startAt",
  ]);
  expect(keys(AdmissionPeriod.jsonCreate.fields)).toEqual([
    "departmentId",
    "endAt",
    "semesterId",
    "startAt",
  ]);
  expect(keys(AdmissionPeriod.jsonUpdate.fields)).toEqual(["endAt", "startAt"]);
});

it.effect("decodes selected rows strictly and leaves source values immutable", () => {
  const selected = {
    id: "period-model-1",
    departmentId: "department-1",
    semesterId: "semester-1",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-12-01T00:00:00.000Z",
    revision: 0,
    lastCommandId: "command-1",
  };

  return Effect.gen(function* () {
    const period = yield* Schema.decodeUnknownEffect(AdmissionPeriod)(selected, {
      onExcessProperty: "error",
    });
    expect(period).not.toBe(selected);
    expect(period.id).toBe("period-model-1");
    selected.id = "changed-after-decode";
    expect(period.id).toBe("period-model-1");

    const excess = yield* Effect.flip(
      Schema.decodeUnknownEffect(AdmissionPeriod)(
        { ...selected, id: "period-model-1", duplicateAuthority: true },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(excess)).toContain("duplicateAuthority");

    const invalidInstant = yield* Effect.flip(
      Schema.decodeUnknownEffect(AdmissionPeriod)(
        { ...selected, id: "period-model-1", startAt: "2026-02-30T00:00:00.000Z" },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(invalidInstant)).toContain("startAt");

    const invalidRevision = yield* Effect.flip(
      Schema.decodeUnknownEffect(AdmissionPeriod)(
        { ...selected, id: "period-model-1", revision: 1.5 },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(invalidRevision)).toContain("revision");

    const projection = yield* Schema.decodeUnknownEffect(AdmissionPeriodProjectionSchema)(
      { ...selected, id: "period-model-1", eligible: true },
      { onExcessProperty: "error" },
    );
    expect(projection.eligible).toBe(true);
  });
});
