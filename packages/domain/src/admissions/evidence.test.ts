import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { ApplicationAdmissionEvidence } from "./evidence.js";

const encoded = {
  applicationId: "evidence-application",
  admissionPeriodId: "evidence-period",
  departmentId: "evidence-department",
  semesterId: "evidence-semester",
  periodOpensAt: "2031-09-01T00:00:00.000Z",
  periodClosesAt: "2031-10-01T00:00:00.000Z",
  semesterStartsAt: "2031-08-01T00:00:00.000Z",
  semesterEndsAt: "2032-01-01T00:00:00.000Z",
  basis: "Ja",
  outcome: "Admitted",
  decisionClosed: true,
  interviewCompleted: true,
  interviewCancelled: false,
  returningRegistered: false,
  linkedPersonId: null,
};

const decode = Schema.decodeUnknownEffect(ApplicationAdmissionEvidence);

const encode = Schema.encodeEffect(ApplicationAdmissionEvidence);

describe("canonical application admission evidence boundary", () => {
  it.effect("canonical encoded evidence round-trips with domain Instants", () =>
    Effect.gen(function* () {
      const evidence = yield* decode(encoded);

      expect(DateTime.isUtc(evidence.periodOpensAt)).toBe(true);
      expect(yield* encode(evidence)).toEqual(encoded);
    }),
  );

  it.effect("normalizes offset instants once, not at standing evaluation", () =>
    Effect.gen(function* () {
      const evidence = yield* decode({
        ...encoded,
        periodOpensAt: "2031-09-01T02:00:00.000+02:00",
      });

      expect((yield* encode(evidence)).periodOpensAt).toBe(encoded.periodOpensAt);
    }),
  );

  it.effect(
    "historical Unreviewed preserves an immutable outcome without claiming a live interview",
    () =>
      Effect.gen(function* () {
        const historical = {
          ...encoded,
          basis: "Unreviewed",
          outcome: "Rejected",
          interviewCompleted: false,
        };

        const evidence = yield* decode(historical);

        expect(yield* encode(evidence)).toEqual(historical);
      }),
  );

  for (const invalid of [
    { ...encoded, outcome: "Substitute" },
    { ...encoded, basis: "Accepted" },
    { ...encoded, decisionClosed: "true" },
    { ...encoded, interviewCompleted: null },
    { ...encoded, semesterEndsAt: "2031-02-30T00:00:00.000Z" },
    { ...encoded, linkedPersonId: 42 },
  ]) {
    it.effect(
      "rejects malformed evidence " + Schema.encodeSync(Schema.UnknownFromJsonString)(invalid),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(decode(invalid));

          expect(error._tag).toBe("SchemaError");
        }),
    );
  }
});
