import { DepartmentId } from "../organization/schema.js";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { encodeSchoolSurveyResultsCsv } from "./csv.js";
import { SchoolSurveyResultsResource } from "./schema.js";

const result = Schema.decodeSync(SchoolSurveyResultsResource)(
  {
    survey: {
      surveyId: "survey_123e4567-e89b-12d3-a456-426614174000",
      departmentId: DepartmentId.make("survey-department"),
      semesterId: "survey-semester",
      semesterLabel: "Survey semester",
      title: "School feedback",
      completionText: "Thank you",
      resultsVisibility: "DepartmentManagers",
      state: "Closed",
      revision: 1,
      createdAt: "2026-09-22T10:00:00.000Z",
      createdByPersonId: "survey-manager",
      closedAt: "2026-09-22T11:00:00.000Z",
      closedByPersonId: "survey-manager",
      responseCount: 1,
      questions: [
        {
          kind: "Text",
          questionId: "survey_123e4567-e89b-12d3-a456-426614174000_q_0",
          label: "Text, question",
          help: null,
          required: true,
        },
        {
          kind: "Check",
          questionId: "survey_123e4567-e89b-12d3-a456-426614174000_q_1",
          label: "Check question",
          help: null,
          required: false,
          alternatives: ["First", "Second"],
        },
      ],
    },
    responseCount: 1,
    responses: [
      {
        school: { schoolId: 1, name: 'Alpha "School", Oslo' },
        submittedAt: "2026-09-22T10:30:00.000Z",
        answers: [
          {
            kind: "Check",
            questionId: "survey_123e4567-e89b-12d3-a456-426614174000_q_1",
            values: ["First", "Second"],
          },
          {
            kind: "Text",
            questionId: "survey_123e4567-e89b-12d3-a456-426614174000_q_0",
            value: "line one\nline two",
          },
        ],
      },
    ],
  },
  { onExcessProperty: "error" },
);

describe("School-survey CSV", () => {
  it("uses the result projection's question order and escapes RFC 4180 cells", () => {
    expect(encodeSchoolSurveyResultsCsv(result)).toBe(
      'submittedAt,school,"Text, question",Check question\r\n' +
        '2026-09-22T10:30:00.000Z,"Alpha ""School"", Oslo","line one\nline two",First; Second\r\n',
    );
  });

  it("neutralizes spreadsheet formulas in every user-controlled cell", () => {
    const formulaResult = Schema.decodeSync(SchoolSurveyResultsResource)(
      {
        ...result,
        survey: {
          ...result.survey,
          questions: result.survey.questions.map((question) =>
            question.kind === "Text" ? { ...question, label: "=question" } : question,
          ),
        },
        responses: result.responses.map((response) => ({
          ...response,
          school: { ...response.school, name: "+school" },
          answers: response.answers.map((answer) =>
            answer.kind === "Text" ? { ...answer, value: "@answer" } : answer,
          ),
        })),
      },
      { onExcessProperty: "error" },
    );

    expect(encodeSchoolSurveyResultsCsv(formulaResult)).toBe(
      "submittedAt,school,'=question,Check question\r\n" +
        "2026-09-22T10:30:00.000Z,'+school,'@answer,First; Second\r\n",
    );
  });
});
