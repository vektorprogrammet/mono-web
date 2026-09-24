import { DepartmentId } from "../organization/schema.js";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CreateSchoolSurveyRequest } from "./schema.js";

const request = {
  departmentId: DepartmentId.make("survey-schema-department"),
  semesterId: "survey-schema-semester",
  title: "School survey",
  completionText: "Thank you.",
  resultsVisibility: "DepartmentManagers",
  questions: [
    {
      kind: "List",
      label: "Will you participate again?",
      help: null,
      required: true,
      alternatives: ["Yes", "No"],
    },
  ],
} as const;

describe("School-survey schema", () => {
  it("accepts only create values that persistence and response normalization can represent", () => {
    expect(Schema.decodeUnknownSync(CreateSchoolSurveyRequest)(request)).toMatchObject(request);
    expect(() =>
      Schema.decodeUnknownSync(CreateSchoolSurveyRequest)({
        ...request,
        questions: [{ ...request.questions[0], alternatives: ["\tYes", "No"] }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateSchoolSurveyRequest)({
        ...request,
        questions: [{ ...request.questions[0], alternatives: ["Yes", "Yes"] }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateSchoolSurveyRequest)({
        ...request,
        completionText: " Thank you.",
      }),
    ).toThrow();
  });
});
