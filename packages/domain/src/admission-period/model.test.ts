import { SemesterId, DepartmentId } from "../organization/schema.js";
import { expect, it } from "@effect/vitest";
import { Struct, Result, Effect, Schema } from "effect";
import {
  AdmissionPeriodCommandId,
  AdmissionPeriod,
  AdmissionPeriodProjectionSchema,
  AdmissionPeriodCommandSchema,
} from "./schema.js";

it("requires the semester identity on create commands", () => {
  const valid = AdmissionPeriodCommandSchema.cases.CreateAdmissionPeriod.make({
    commandId: AdmissionPeriodCommandId.make("command-missing-semester"),
    semesterId: SemesterId.make("semester-model"),
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-12-01T00:00:00.000Z",
  });

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(AdmissionPeriodCommandSchema)(Struct.omit(valid, ["semesterId"])),
    ),
  ).toBe(true);
});

it.effect("decodes selected rows strictly and leaves source values immutable", () => {
  const selected = {
    id: "period-model-1",
    departmentId: DepartmentId.make("department-1"),
    semesterId: "semester-1",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-12-01T00:00:00.000Z",
    revision: 0,
    lastCommandId: "command-1",
  };

  return Effect.gen(function* () {
    const period = yield* Schema.decodeEffect(AdmissionPeriod)(selected, {
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
      Schema.decodeEffect(AdmissionPeriod)(
        { ...selected, id: "period-model-1", startAt: "2026-02-30T00:00:00.000Z" },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(invalidInstant)).toContain("startAt");

    const invalidRevision = yield* Effect.flip(
      Schema.decodeEffect(AdmissionPeriod)(
        { ...selected, id: "period-model-1", revision: 1.5 },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(invalidRevision)).toContain("revision");

    const projection = yield* Schema.decodeEffect(AdmissionPeriodProjectionSchema)(
      { ...selected, id: "period-model-1", eligible: true },
      { onExcessProperty: "error" },
    );

    expect(projection.eligible).toBe(true);
  });
});
