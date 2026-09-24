import { Predicate } from "effect";
import { SurveyId } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { useEffect, useRef } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  loadSchoolSurvey,
  parseSchoolSurveySubmission,
  schoolSurveyDraftFromForm,
  submitSchoolSurveyResponse,
} from "../lib/school-survey.server";
import { schoolSurveyIdFromPathSegment } from "../lib/school-survey-path";
import type { Route } from "./+types/undersokelse.$surveyId";

const invalidSurveyResponse = () => new Response(null, { status: 404 });

const surveyIdFrom = (value: string | undefined) => {
  const routeValue = value === undefined ? undefined : schoolSurveyIdFromPathSegment(value);
  const decoded = Schema.decodeUnknownOption(SurveyId)(routeValue);

  if (Predicate.isTagged(decoded, "None")) throw invalidSurveyResponse();

  return decoded.value;
};

const failureMessage = (failure: "Validation" | "Conflict" | "Unavailable") => {
  switch (failure) {
    case "Validation":
      return "Svarene kunne ikke sendes. Kontroller feltene og prøv igjen.";
    case "Conflict":
      return "Dette svaret kunne ikke sendes. Prøv igjen med skjemaet som vises.";
    case "Unavailable":
      return "Skjemaet kunne ikke sendes nå. Prøv igjen senere.";
  }
};

export async function loader({ params }: Route.LoaderArgs) {
  const surveyId = surveyIdFrom(params.surveyId);
  const result = await loadSchoolSurvey(surveyId);

  if (Predicate.isTagged(result, "Failed")) {
    throw new Response(null, { status: result.failure === "NotFound" ? 404 : 503 });
  }

  return { surveyId, form: result.form, commandId: crypto.randomUUID() };
}

export async function action({ params, request }: Route.ActionArgs) {
  const surveyId = surveyIdFrom(params.surveyId);
  const submittedForm = await request.formData();
  const loaded = await loadSchoolSurvey(surveyId);

  if (Predicate.isTagged(loaded, "Failed")) {
    return {
      success: false as const,
      draft: schoolSurveyDraftFromForm(submittedForm),
      fieldErrors: {},
      message:
        loaded.failure === "NotFound"
          ? "Skjemaet finnes ikke lenger."
          : failureMessage("Unavailable"),
    };
  }

  const parsed = parseSchoolSurveySubmission(submittedForm, loaded.form);

  if (parsed.payload === undefined || parsed.commandId === undefined) {
    return {
      success: false as const,
      draft: parsed.draft,
      fieldErrors: parsed.fieldErrors,
      message: "Kontroller feltene som er markert.",
    };
  }

  const result = await submitSchoolSurveyResponse({
    surveyId,
    commandId: parsed.commandId,
    payload: parsed.payload,
  });

  if (Predicate.isTagged(result, "Submitted")) {
    return { success: true as const, completionText: result.completionText };
  }

  return {
    success: false as const,
    draft: parsed.draft,
    fieldErrors:
      result.failure === "Validation"
        ? { ...parsed.fieldErrors, schoolId: parsed.fieldErrors.schoolId ?? "Kontroller skolen." }
        : parsed.fieldErrors,
    message: failureMessage(result.failure === "NotFound" ? "Unavailable" : result.failure),
  };
}

const FieldError = ({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) =>
  message === undefined ? null : (
    <p id={id} className="mt-2 text-sm font-medium text-red-700" role="alert">
      {message}
    </p>
  );

const questionControlId = (questionId: string) =>
  `survey-question-${encodeURIComponent(questionId)}`;

const questionErrorId = (questionId: string) => `${questionControlId(questionId)}-error`;

const questionHelpId = (questionId: string) => `${questionControlId(questionId)}-help`;

const questionField = (questionId: string) => `question:${questionId}`;

const fieldErrorFor = (
  fieldErrors: Readonly<Record<string, string>> | undefined,
  field: string,
): string | undefined =>
  fieldErrors !== undefined && Object.hasOwn(fieldErrors, field) ? fieldErrors[field] : undefined;

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function SchoolSurveyRoute() {
  const { form, commandId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const failed = actionData?.success === false ? actionData : undefined;
  const submitted = actionData?.success === true ? actionData : undefined;
  const submitting = navigation.state === "submitting";
  const errorSummaryRef = useRef<HTMLElement>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (submitted !== undefined) {
      completionHeadingRef.current?.focus();
    } else if (failed !== undefined) {
      errorSummaryRef.current?.focus();
    }
  }, [failed, submitted]);

  if (submitted) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-6 px-4 py-8 sm:px-6">
        <h1 ref={completionHeadingRef} className="font-semibold text-3xl" tabIndex={-1}>
          Takk for svaret
        </h1>
        <p className="max-w-prose whitespace-pre-wrap break-words text-base leading-7">
          {submitted.completionText}
        </p>
        <a
          className="w-fit text-blue-700 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/"
        >
          Til forsiden
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <header className="max-w-prose">
        <p className="text-sm font-medium text-muted-foreground">{form.semesterLabel}</p>
        <h1 className="mt-2 break-words font-semibold text-3xl leading-tight">{form.title}</h1>
      </header>

      {failed === undefined ? null : (
        <section
          ref={errorSummaryRef}
          className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-red-900"
          role="alert"
          tabIndex={-1}
          aria-labelledby="survey-error-summary"
        >
          <h2 id="survey-error-summary" className="font-semibold">
            Skjemaet har feil
          </h2>
          <p className="mt-1 text-sm">{failed.message}</p>
        </section>
      )}

      <Form method="post" reloadDocument className="mt-8 flex min-w-0 flex-col gap-8" noValidate>
        <input type="hidden" name="commandId" value={failed?.draft.commandId ?? commandId} />
        <section className="min-w-0">
          <label className="block font-medium" htmlFor="survey-school">
            Skole <span aria-hidden="true">*</span>
            <span className="sr-only"> (påkrevd)</span>
          </label>
          <select
            id="survey-school"
            name="schoolId"
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
            defaultValue={failed?.draft.schoolId ?? ""}
            required
            aria-invalid={failed?.fieldErrors.schoolId === undefined ? undefined : true}
            aria-describedby={
              failed?.fieldErrors.schoolId === undefined ? undefined : "survey-school-error"
            }
          >
            <option value="">Velg skole</option>
            {form.schools.map((school) => (
              <option key={school.schoolId} value={school.schoolId}>
                {school.name}
              </option>
            ))}
          </select>
          <FieldError id="survey-school-error" message={failed?.fieldErrors.schoolId} />
        </section>

        {form.questions.map((question) => {
          const questionId = String(question.questionId);
          const controlId = questionControlId(questionId);
          const errorId = questionErrorId(questionId);
          const helpId = questionHelpId(questionId);
          const error = fieldErrorFor(failed?.fieldErrors, questionId);
          const values = failed?.draft.answers[questionId] ?? [];

          const describedBy = [
            question.help === null ? undefined : helpId,
            error === undefined ? undefined : errorId,
          ]
            .filter((value): value is string => value !== undefined)
            .join(" ");

          return (
            <fieldset
              key={questionId}
              className="min-w-0 border-t border-border pt-6"
              aria-describedby={describedBy === "" ? undefined : describedBy}
            >
              <legend className="max-w-prose break-words font-medium">
                {question.label}
                {question.required ? <span aria-hidden="true"> *</span> : null}
                <span className="sr-only"> ({question.required ? "påkrevd" : "valgfritt"})</span>
              </legend>
              {question.help === null ? null : (
                <p
                  id={helpId}
                  className="mt-1 max-w-prose break-words text-sm text-muted-foreground"
                >
                  {question.help}
                </p>
              )}

              {question.kind === "Text" ? (
                <>
                  <label className="sr-only" htmlFor={controlId}>
                    {question.label}
                  </label>
                  <textarea
                    id={controlId}
                    name={questionField(questionId)}
                    className="mt-3 min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
                    defaultValue={values[0] ?? ""}
                    required={question.required}
                    aria-invalid={error === undefined ? undefined : true}
                    aria-describedby={describedBy === "" ? undefined : describedBy}
                  />
                </>
              ) : null}

              {question.kind === "List" ? (
                <>
                  <label className="sr-only" htmlFor={controlId}>
                    {question.label}
                  </label>
                  <select
                    id={controlId}
                    name={questionField(questionId)}
                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
                    defaultValue={values[0] ?? ""}
                    required={question.required}
                    aria-invalid={error === undefined ? undefined : true}
                    aria-describedby={describedBy === "" ? undefined : describedBy}
                  >
                    <option value="">Velg alternativ</option>
                    {question.alternatives.map((alternative) => (
                      <option key={alternative} value={alternative}>
                        {alternative}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}

              {question.kind === "Radio" ? (
                <div
                  className="mt-3 grid gap-3"
                  role="radiogroup"
                  aria-required={question.required || undefined}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-describedby={describedBy === "" ? undefined : describedBy}
                >
                  {question.alternatives.map((alternative, index) => {
                    const alternativeId = `${controlId}-${index}`;

                    return (
                      <label
                        key={alternative}
                        className="flex min-w-0 items-start gap-3"
                        htmlFor={alternativeId}
                      >
                        <input
                          id={alternativeId}
                          type="radio"
                          name={questionField(questionId)}
                          value={alternative}
                          defaultChecked={values[0] === alternative}
                          required={question.required && index === 0}
                          aria-describedby={describedBy === "" ? undefined : describedBy}
                        />
                        <span className="min-w-0 break-words">{alternative}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}

              {question.kind === "Check" ? (
                <div
                  className="mt-3 grid gap-3"
                  aria-invalid={error === undefined ? undefined : true}
                  aria-describedby={describedBy === "" ? undefined : describedBy}
                >
                  {question.alternatives.map((alternative, index) => {
                    const alternativeId = `${controlId}-${index}`;

                    return (
                      <label
                        key={alternative}
                        className="flex min-w-0 items-start gap-3"
                        htmlFor={alternativeId}
                      >
                        <input
                          id={alternativeId}
                          type="checkbox"
                          name={questionField(questionId)}
                          value={alternative}
                          defaultChecked={values.includes(alternative)}
                          aria-describedby={describedBy === "" ? undefined : describedBy}
                        />
                        <span className="min-w-0 break-words">{alternative}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              <FieldError id={errorId} message={error} />
            </fieldset>
          );
        })}

        <div className="flex flex-col items-start gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          <button
            type="submit"
            className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
          >
            Send inn
          </button>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {submitting ? "Sender inn …" : ""}
          </p>
        </div>
      </Form>
    </main>
  );
}
