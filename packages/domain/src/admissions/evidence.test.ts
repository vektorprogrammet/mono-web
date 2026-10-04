import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { ApplicationAdmissionEvidence } from "./evidence.js";
import { admissionStanding } from "./standing.js";

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

describe("canonical evidence standing", () => {
  for (const changes of [
    { basis: "Ja", outcome: "Admitted", decisionClosed: false },
    { basis: "Nei", outcome: "Rejected", decisionClosed: false },
    { basis: "Kanskje", outcome: null, decisionClosed: false },
    { basis: "Kanskje", outcome: "Rejected", decisionClosed: true },
    {
      basis: "Returning",
      outcome: "Admitted",
      returningRegistered: true,
      interviewCompleted: false,
    },
    { basis: "Unreviewed", outcome: "Rejected", interviewCompleted: false },
  ]) {
    it.effect("uses canonical outcome for " + changes.basis, () =>
      Effect.gen(function* () {
        const evidence = yield* decode({ ...encoded, ...changes });
        const at = DateTime.makeUnsafe("2031-09-15T12:00:00.000Z");

        expect(admissionStanding(evidence, at)).toBe(changes.outcome);
      }),
    );
  }

  for (const changes of [
    { interviewCompleted: false },
    { interviewCancelled: true },
    { basis: "Returning", returningRegistered: false },
    { basis: "Unreviewed" },
  ]) {
    it.effect(
      "refuses unclosed ineligible evidence " +
        Schema.encodeSync(Schema.UnknownFromJsonString)(changes),
      () =>
        Effect.gen(function* () {
          const evidence = yield* decode({ ...encoded, decisionClosed: false, ...changes });

          expect(
            admissionStanding(evidence, DateTime.makeUnsafe("2031-09-15T12:00:00.000Z")),
          ).toBeNull();
        }),
    );
  }

  for (const at of [
    "2031-08-31T23:59:59.999Z",
    "2031-10-01T00:00:00.000Z",
    "2031-07-31T23:59:59.999Z",
    "2032-01-01T00:00:00.000Z",
  ]) {
    it.effect("own period and semester bounds refuse " + at, () =>
      Effect.gen(function* () {
        const evidence = yield* decode(encoded);

        expect(admissionStanding(evidence, DateTime.makeUnsafe(at))).toBeNull();
      }),
    );
  }
});
