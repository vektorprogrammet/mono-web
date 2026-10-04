import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { assessmentCorrection } from "./conduct.js";
import { AssessmentCorrection } from "./schema.js";
import { PersonId } from "../organization/schema.js";

const reviewer = PersonId.make("correction-reviewer");

const interviewer = PersonId.make("correction-interviewer");

const at = DateTime.makeUnsafe("2031-09-15T12:00:00.000Z");

const endsAt = DateTime.add(at, { hours: 1 });

const evidence = {
  decisionClosed: true,
  completed: true,
  cancelled: false,
  semesterEndsAt: DateTime.add(at, { days: 30 }),
  sequence: 1,
  window: { openedBy: reviewer, openedAt: at, endsAt, closedAt: null },
};

const participant = { personId: interviewer, participant: true, canMaintain: false };

describe("assessment correction lifecycle construction", () => {
  it.effect(
    "permits both assigned interviewers before closure but no ordinary correction after closure",
    () =>
      Effect.sync(() => {
        expect(
          assessmentCorrection(
            { ...evidence, decisionClosed: false, window: null },
            participant,
            at,
          ).canCorrect,
        ).toBe(true);

        expect(
          assessmentCorrection({ ...evidence, window: null }, participant, at).canCorrect,
        ).toBe(false);

        expect(
          assessmentCorrection(evidence, { ...participant, participant: false }, at).canCorrect,
        ).toBe(false);
      }),
  );
  it.effect(
    "an opener cannot correct; independent participants can; end and early close are half-open",
    () =>
      Effect.sync(() => {
        expect(assessmentCorrection(evidence, participant, at).canCorrect).toBe(true);

        expect(
          assessmentCorrection(
            evidence,
            { ...participant, personId: reviewer, canMaintain: true },
            at,
          ).canCorrect,
        ).toBe(false);

        expect(assessmentCorrection(evidence, participant, endsAt)._tag).toBe("Expired");

        expect(assessmentCorrection(evidence, participant, endsAt).canCorrect).toBe(false);

        expect(
          assessmentCorrection(
            { ...evidence, window: { ...evidence.window, closedAt: at } },
            participant,
            at,
          ).canCorrect,
        ).toBe(false);
      }),
  );
  it.effect("only current scoped staffing authority can reopen or close eligible conduct", () =>
    Effect.sync(() => {
      const staff = { personId: reviewer, participant: false, canMaintain: true };

      expect(assessmentCorrection(evidence, staff, at).canClose).toBe(true);

      expect(assessmentCorrection({ ...evidence, window: null }, staff, at).canReopen).toBe(true);

      expect(assessmentCorrection({ ...evidence, window: null }, participant, at).canReopen).toBe(
        false,
      );

      for (const ineligible of [
        { ...evidence, completed: false },
        { ...evidence, cancelled: true },
        { ...evidence, semesterEndsAt: at },
      ]) {
        expect(assessmentCorrection(ineligible, staff, at).canClose).toBe(false);

        expect(assessmentCorrection(ineligible, participant, at).canCorrect).toBe(false);

        expect(assessmentCorrection({ ...ineligible, window: null }, staff, at).canReopen).toBe(
          false,
        );
      }
    }),
  );
  it.effect(
    "the schema rejects contradictory flags while accepting the server rule's observations",
    () =>
      Effect.sync(() => {
        const open = assessmentCorrection(evidence, participant, at);

        const closed = assessmentCorrection({ ...evidence, window: null }, participant, at);

        expect(Schema.is(AssessmentCorrection)(open)).toBe(true);

        expect(Schema.is(AssessmentCorrection)(closed)).toBe(true);

        expect(Schema.is(AssessmentCorrection)({ ...closed, canCorrect: true })).toBe(false);

        expect(Schema.is(AssessmentCorrection)({ ...open, canReopen: true })).toBe(false);

        expect(
          Schema.is(AssessmentCorrection)({
            ...assessmentCorrection(evidence, participant, endsAt),
            canClose: true,
          }),
        ).toBe(false);
      }),
  );
});
