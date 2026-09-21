import {
  SchoolId,
  type SchoolSurveyFormResource,
  type SubmitSchoolSurveyResponseRequest,
  type SurveyId,
} from "@vektorprogrammet/domain";
import {
  IdempotencyKey,
  type IdempotencyKey as IdempotencyKeyValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { createServerClient } from "./api.server";
import { nativeProblemFrom } from "./native-problem";

export type SchoolSurveyBridgeFailure = "NotFound" | "Validation" | "Conflict" | "Unavailable";

const bridgeFailureFrom = (error: unknown): SchoolSurveyBridgeFailure => {
  const problem = nativeProblemFrom(error);
  if (problem?.status === 404) return "NotFound";
  if (problem?.code === "validation.failed") return "Validation";
  if (problem?.status === 409) return "Conflict";
  return "Unavailable";
};

export const loadSchoolSurvey = async (
  surveyId: SurveyId,
): Promise<
  | { readonly _tag: "Loaded"; readonly form: SchoolSurveyFormResource }
  | { readonly _tag: "Failed"; readonly failure: SchoolSurveyBridgeFailure }
> => {
  try {
    const result = await createServerClient().surveys.readSchoolSurvey({ params: { surveyId } });
    if (result.body === undefined) return { _tag: "Failed", failure: "Unavailable" };
    return { _tag: "Loaded", form: result.body };
  } catch (error) {
    return { _tag: "Failed", failure: bridgeFailureFrom(error) };
  }
};

export const submitSchoolSurveyResponse = async (input: {
  readonly surveyId: SurveyId;
  readonly commandId: IdempotencyKeyValue;
  readonly payload: SubmitSchoolSurveyResponseRequest;
}): Promise<
  | { readonly _tag: "Submitted"; readonly completionText: string }
  | { readonly _tag: "Failed"; readonly failure: SchoolSurveyBridgeFailure }
> => {
  try {
    const result = await createServerClient().surveys.submitSchoolSurveyResponse({
      params: { surveyId: input.surveyId },
      headers: { "idempotency-key": input.commandId },
      payload: input.payload,
    });
    if (result.body === undefined) return { _tag: "Failed", failure: "Unavailable" };
    return { _tag: "Submitted", completionText: result.body.completionText };
  } catch (error) {
    return { _tag: "Failed", failure: bridgeFailureFrom(error) };
  }
};

export interface SchoolSurveyDraft {
  readonly schoolId: string;
  readonly commandId: string;
  readonly answers: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface ParsedSchoolSurveySubmission {
  readonly draft: SchoolSurveyDraft;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly commandId?: IdempotencyKeyValue;
  readonly payload?: SubmitSchoolSurveyResponseRequest;
}

export const schoolSurveyDraftFromForm = (form: FormData): SchoolSurveyDraft => {
  const answers: Record<string, Array<string>> = {};
  for (const [field, value] of form.entries()) {
    if (!field.startsWith("question:")) continue;
    const questionId = field.slice("question:".length);
    if (questionId === "") continue;
    const values = answers[questionId] ?? [];
    values.push(typeof value === "string" ? value : "");
    answers[questionId] = values;
  }
  return {
    schoolId: String(form.get("schoolId") ?? ""),
    commandId: String(form.get("commandId") ?? ""),
    answers,
  };
};

/** Parses browser-owned controls against the current server-side survey definition. */
export const parseSchoolSurveySubmission = (
  form: FormData,
  survey: SchoolSurveyFormResource,
): ParsedSchoolSurveySubmission => {
  const draft = schoolSurveyDraftFromForm(form);
  const { schoolId, commandId, answers } = draft;
  const fieldErrors: Record<string, string> = {};
  const parsedSchoolId = Schema.decodeUnknownOption(SchoolId)(Number(schoolId));
  if (parsedSchoolId._tag === "None") {
    fieldErrors.schoolId = "Velg en skole.";
  }
  const parsedCommandId = Schema.decodeUnknownOption(IdempotencyKey)(commandId);
  if (parsedCommandId._tag === "None") {
    fieldErrors.commandId = "Skjemaet må lastes på nytt før det kan sendes.";
  }
  const payloadAnswers: Array<SubmitSchoolSurveyResponseRequest["answers"][number]> = [];
  for (const question of survey.questions) {
    const values = answers[String(question.questionId)] ?? [];
    if (question.kind === "Text") {
      const value = values[0] ?? "";
      if (question.required && value.trim() === "") {
        fieldErrors[String(question.questionId)] = "Dette spørsmålet må besvares.";
      }
      payloadAnswers.push({ kind: "Text", questionId: question.questionId, value });
      continue;
    }
    if (question.kind === "Check") {
      if (question.required && values.length === 0) {
        fieldErrors[String(question.questionId)] = "Velg minst ett alternativ.";
      }
      if (values.some((value) => !question.alternatives.includes(value))) {
        fieldErrors[String(question.questionId)] = "Velg et gyldig alternativ.";
      }
      if (values.length > 0) {
        payloadAnswers.push({ kind: "Check", questionId: question.questionId, values });
      }
      continue;
    }
    const value = values[0] ?? "";
    if (question.required && value.trim() === "") {
      fieldErrors[String(question.questionId)] = "Dette spørsmålet må besvares.";
    }
    if (value !== "" && !question.alternatives.includes(value.trim())) {
      fieldErrors[String(question.questionId)] = "Velg et gyldig alternativ.";
    }
    if (value !== "") {
      payloadAnswers.push({ kind: question.kind, questionId: question.questionId, value });
    }
  }
  if (
    Object.keys(fieldErrors).length > 0 ||
    parsedSchoolId._tag === "None" ||
    parsedCommandId._tag === "None"
  ) {
    return { draft, fieldErrors };
  }
  return {
    draft,
    fieldErrors,
    commandId: parsedCommandId.value,
    payload: {
      schoolId: parsedSchoolId.value,
      answers: payloadAnswers,
    },
  };
};
