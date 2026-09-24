import type { SchoolSurveyResultsResource } from "./schema.js";

/** Stable in-cell separator for ordered Check-question selections. */
export const SCHOOL_SURVEY_CSV_CHECK_SEPARATOR = "; ";

const encodeCsvCell = (value: string): string => {
  const formulaSafe = /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
  const escaped = formulaSafe.replaceAll('"', '""');

  return /[",\r\n]/u.test(escaped) ? `"${escaped}"` : escaped;
};

/**
 * Encodes only the already authorized result projection. It performs no lookup,
 * filtering, or inference, so an exported row always corresponds to one result row.
 */
export const encodeSchoolSurveyResultsCsv = (results: SchoolSurveyResultsResource): string => {
  const rows: Array<ReadonlyArray<string>> = [
    ["submittedAt", "school", ...results.survey.questions.map((question) => question.label)],
    ...results.responses.map((response) => {
      const answersByQuestion = new Map(
        response.answers.map((answer) => [String(answer.questionId), answer]),
      );

      return [
        response.submittedAt,
        response.school.name,
        ...results.survey.questions.map((question) => {
          const answer = answersByQuestion.get(String(question.questionId));

          if (answer === undefined) return "";

          return answer.kind === "Check"
            ? answer.values.join(SCHOOL_SURVEY_CSV_CHECK_SEPARATOR)
            : (answer.value ?? "");
        }),
      ];
    }),
  ];

  return `${rows.map((row) => row.map(encodeCsvCell).join(",")).join("\r\n")}\r\n`;
};
