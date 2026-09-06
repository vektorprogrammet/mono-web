import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  FinalizeInterviewCommandSchema,
  InterviewRecommendationSchema,
  RecruitmentInterviewConduct,
  interviewRecommendations,
} from "./schema.js";

describe("0101 explicit interviewer recommendation", () => {
  const command = {
    commandId: "recommendation-command",
    interviewId: "recommendation-interview",
    expectedRevision: 1,
    answers: [],
    score: { explanatoryPower: 10, roleModel: 10, suitability: 10 },
  };
  it("requires an explicit choice even with maximum numeric scores", () => {
    for (const recommendation of [undefined, null, "", "Maybe", 9]) {
      expect(Schema.is(FinalizeInterviewCommandSchema)({ ...command, recommendation })).toBe(false);
    }
    for (const recommendation of interviewRecommendations) {
      expect(Schema.is(FinalizeInterviewCommandSchema)({ ...command, recommendation })).toBe(true);
    }
  });
  it("allows absent historical observations but never absent new inserts", () => {
    expect(Schema.is(RecruitmentInterviewConduct.json.fields.recommendation)(null)).toBe(true);
    expect(Schema.is(RecruitmentInterviewConduct.insert.fields.recommendation)(null)).toBe(false);
    for (const recommendation of interviewRecommendations) {
      expect(Schema.is(InterviewRecommendationSchema)(recommendation)).toBe(true);
    }
  });
});
