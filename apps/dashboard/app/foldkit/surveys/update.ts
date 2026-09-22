import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Match as M, Schema as S } from "effect";
import { Command } from "foldkit";
import {
  SchoolSurveyCloseCommand,
  SchoolSurveyCreateCommand,
  type SchoolSurveyListInput,
} from "./bridge";
import type { SchoolSurveysCommandFactories } from "./command";
import { RequestedResults, type Message } from "./message";
import {
  makeDraft,
  makeQuestionDraft,
  type Model,
  type QuestionDraft,
  type SchoolSurveysFailure,
  type SurveyDraft,
} from "./model";

export type UpdateResult = readonly [Model, ReadonlyArray<Command.Command<Message>>];

const invalidDraftFailure: SchoolSurveysFailure = {
  _tag: "Failed",
  tag: "InvalidDraft",
  message: "Fyll ut avdeling, semester, tittel, avslutningstekst og minst ett gyldig spørsmål.",
};

const listQuery = (draft: SurveyDraft): SchoolSurveyListInput | null =>
  draft.departmentId === null || draft.semesterId === null
    ? null
    : { departmentId: draft.departmentId, semesterId: draft.semesterId };

const nextRequestId = (model: Model): number => model.requestSequence + 1;

const loadSelectedList = (
  model: Model,
  commands: SchoolSurveysCommandFactories,
  draft: SurveyDraft = model.draft,
  preserveSelection = false,
): UpdateResult => {
  const query = listQuery(draft);
  if (query === null) {
    return [
      {
        ...model,
        draft,
        list: { _tag: "Idle" },
        detail: null,
        selectedSurveyId: null,
        results: { _tag: "Idle" },
      },
      [],
    ];
  }
  const requestId = nextRequestId(model);
  return [
    {
      ...model,
      draft,
      requestSequence: requestId,
      list: { _tag: "Loading", requestId },
      detail: preserveSelection ? model.detail : null,
      selectedSurveyId: preserveSelection ? model.selectedSurveyId : null,
      results: { _tag: "Idle" },
    },
    [commands.LoadList({ requestId, query })],
  ];
};

const createQuestionPayload = (question: QuestionDraft) => {
  const common = {
    kind: question.kind,
    label: question.label,
    help: question.help.trim() === "" ? null : question.help,
    required: question.required,
  };
  return question.kind === "Text" ? common : { ...common, alternatives: question.alternatives };
};

const createCommand = (
  draft: SurveyDraft,
  commandId: string,
): S.Schema.Type<typeof SchoolSurveyCreateCommand> | null => {
  const query = listQuery(draft);
  if (query === null) return null;
  try {
    return S.decodeUnknownSync(SchoolSurveyCreateCommand)(
      {
        commandId,
        ...query,
        title: draft.title,
        completionText: draft.completionText,
        resultsVisibility: draft.resultsVisibility,
        questions: draft.questions.map(createQuestionPayload),
      },
      { onExcessProperty: "error" },
    );
  } catch {
    return null;
  }
};

const sameDraft = (left: SurveyDraft, right: SurveyDraft): boolean =>
  left.departmentId === right.departmentId &&
  left.semesterId === right.semesterId &&
  left.title === right.title &&
  left.completionText === right.completionText &&
  left.resultsVisibility === right.resultsVisibility &&
  left.questions.length === right.questions.length &&
  left.questions.every((question, index) => {
    const other = right.questions[index];
    return (
      other !== undefined &&
      question.draftId === other.draftId &&
      question.kind === other.kind &&
      question.label === other.label &&
      question.help === other.help &&
      question.required === other.required &&
      question.alternatives.length === other.alternatives.length &&
      question.alternatives.every(
        (alternative, alternativeIndex) => alternative === other.alternatives[alternativeIndex],
      )
    );
  });

const generatedCommandId = (model: Model, operation: "create" | "close") =>
  IdempotencyKey.make(`school-surveys-${operation}-${model.commandSeed}-${model.commandSequence}`);

const updateQuestion = (
  model: Model,
  draftId: number,
  transform: (question: QuestionDraft) => QuestionDraft,
): Model => {
  const question = model.draft.questions.find((candidate) => candidate.draftId === draftId);
  if (question === undefined) return model;
  return {
    ...model,
    draft: {
      ...model.draft,
      questions: model.draft.questions.map((candidate) =>
        candidate.draftId === draftId ? transform(candidate) : candidate,
      ),
    },
    banner: null,
    successMessage: null,
  };
};

const selectedDetail = (model: Model, surveyId: string) =>
  model.list._tag === "Success"
    ? model.list.data.surveys.find((candidate) => candidate.surveyId === surveyId)
    : undefined;

const canEditDraft = (model: Model): boolean => model.pendingCommand === null;

export const makeUpdate =
  (commands: SchoolSurveysCommandFactories) =>
  (model: Model, message: Message): UpdateResult =>
    M.value(message).pipe(
      M.withReturnType<UpdateResult>(),
      M.tagsExhaustive({
        LoadedCatalog: ({ requestId, catalog }) => {
          if (model.catalog._tag !== "Loading" || model.catalog.requestId !== requestId) {
            return [model, []];
          }
          const draft: SurveyDraft = {
            ...model.draft,
            departmentId: catalog.departments[0]?.departmentId ?? null,
            semesterId: catalog.semesters[0]?.semesterId ?? null,
          };
          const [next, emitted] = loadSelectedList(
            { ...model, catalog: { _tag: "Success", data: catalog }, banner: null },
            commands,
            draft,
          );
          return [next, emitted];
        },
        FailedCatalog: ({ requestId, failure }) =>
          model.catalog._tag !== "Loading" || model.catalog.requestId !== requestId
            ? [model, []]
            : [
                { ...model, catalog: { _tag: "Failure", error: failure }, list: { _tag: "Idle" } },
                [],
              ],
        RetriedCatalog: () => {
          if (!canEditDraft(model)) return [model, []];
          const requestId = nextRequestId(model);
          return [
            {
              ...model,
              requestSequence: requestId,
              catalog: { _tag: "Loading", requestId },
              list: { _tag: "Idle" },
              detail: null,
              selectedSurveyId: null,
              results: { _tag: "Idle" },
              banner: null,
              successMessage: null,
            },
            [commands.LoadCatalog({ requestId })],
          ];
        },
        SelectedDepartment: ({ departmentId }) => {
          if (
            !canEditDraft(model) ||
            model.catalog._tag !== "Success" ||
            (departmentId !== null &&
              !model.catalog.data.departments.some(
                (department) => department.departmentId === departmentId,
              )) ||
            departmentId === model.draft.departmentId
          ) {
            return [model, []];
          }
          const [next, emitted] = loadSelectedList(model, commands, {
            ...model.draft,
            departmentId,
          });
          return [{ ...next, banner: null, successMessage: null }, emitted];
        },
        SelectedSemester: ({ semesterId }) => {
          if (
            !canEditDraft(model) ||
            model.catalog._tag !== "Success" ||
            (semesterId !== null &&
              !model.catalog.data.semesters.some(
                (semester) => semester.semesterId === semesterId,
              )) ||
            semesterId === model.draft.semesterId
          ) {
            return [model, []];
          }
          const [next, emitted] = loadSelectedList(model, commands, {
            ...model.draft,
            semesterId,
          });
          return [{ ...next, banner: null, successMessage: null }, emitted];
        },
        ChangedTitle: ({ value }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, title: value },
                  banner: null,
                  successMessage: null,
                },
                [],
              ],
        ChangedCompletionText: ({ value }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, completionText: value },
                  banner: null,
                  successMessage: null,
                },
                [],
              ],
        SelectedResultsVisibility: ({ resultsVisibility }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, resultsVisibility },
                  banner: null,
                  successMessage: null,
                },
                [],
              ],
        AddedQuestion: ({ kind }) => {
          if (!canEditDraft(model)) return [model, []];
          const draftId = model.questionSequence;
          return [
            {
              ...model,
              questionSequence: draftId + 1,
              draft: {
                ...model.draft,
                questions: [...model.draft.questions, makeQuestionDraft(draftId, kind)],
              },
              banner: null,
              successMessage: null,
            },
            [],
          ];
        },
        RemovedQuestion: ({ draftId }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                {
                  ...model,
                  draft: {
                    ...model.draft,
                    questions: model.draft.questions.filter(
                      (question) => question.draftId !== draftId,
                    ),
                  },
                  banner: null,
                  successMessage: null,
                },
                [],
              ],
        ChangedQuestionKind: ({ draftId, kind }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                updateQuestion(model, draftId, (question) => ({
                  ...question,
                  kind,
                  alternatives:
                    kind === "Text"
                      ? []
                      : question.alternatives.length === 0
                        ? ["", ""]
                        : question.alternatives,
                })),
                [],
              ],
        ChangedQuestionLabel: ({ draftId, value }) =>
          !canEditDraft(model)
            ? [model, []]
            : [updateQuestion(model, draftId, (question) => ({ ...question, label: value })), []],
        ChangedQuestionHelp: ({ draftId, value }) =>
          !canEditDraft(model)
            ? [model, []]
            : [updateQuestion(model, draftId, (question) => ({ ...question, help: value })), []],
        ChangedQuestionRequired: ({ draftId, required }) =>
          !canEditDraft(model)
            ? [model, []]
            : [updateQuestion(model, draftId, (question) => ({ ...question, required })), []],
        AddedAlternative: ({ draftId }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text"
                    ? question
                    : { ...question, alternatives: [...question.alternatives, ""] },
                ),
                [],
              ],
        ChangedAlternative: ({ draftId, index, value }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text" || question.alternatives[index] === undefined
                    ? question
                    : {
                        ...question,
                        alternatives: question.alternatives.map((alternative, alternativeIndex) =>
                          alternativeIndex === index ? value : alternative,
                        ),
                      },
                ),
                [],
              ],
        RemovedAlternative: ({ draftId, index }) =>
          !canEditDraft(model)
            ? [model, []]
            : [
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text" || question.alternatives[index] === undefined
                    ? question
                    : {
                        ...question,
                        alternatives: question.alternatives.filter(
                          (_alternative, alternativeIndex) => alternativeIndex !== index,
                        ),
                      },
                ),
                [],
              ],
        LoadedList: ({ requestId, list }) =>
          model.list._tag !== "Loading" || model.list.requestId !== requestId
            ? [model, []]
            : [
                {
                  ...model,
                  list: { _tag: "Success", data: list },
                  detail:
                    model.selectedSurveyId === null
                      ? null
                      : (list.surveys.find(
                          (survey) => survey.surveyId === model.selectedSurveyId,
                        ) ?? null),
                },
                [],
              ],
        FailedList: ({ requestId, failure }) =>
          model.list._tag !== "Loading" || model.list.requestId !== requestId
            ? [model, []]
            : [{ ...model, list: { _tag: "Failure", error: failure } }, []],
        RetriedList: () => {
          if (!canEditDraft(model)) return [model, []];
          return loadSelectedList(model, commands);
        },
        SelectedSurvey: ({ surveyId }) => {
          if (!canEditDraft(model)) return [model, []];
          const detail = selectedDetail(model, surveyId);
          if (detail === undefined) return [model, []];
          return [
            {
              ...model,
              selectedSurveyId: surveyId,
              detail,
              results: { _tag: "Idle" },
              banner: null,
              successMessage: null,
            },
            [],
          ];
        },
        RequestedResults: ({ surveyId }) => {
          if (!canEditDraft(model) || model.detail === null || model.detail.surveyId !== surveyId) {
            return [model, []];
          }
          const requestId = nextRequestId(model);
          return [
            {
              ...model,
              requestSequence: requestId,
              results: { _tag: "Loading", requestId, surveyId },
              banner: null,
            },
            [commands.LoadResults({ requestId, surveyId })],
          ];
        },
        LoadedResults: ({ requestId, surveyId, results }) =>
          model.results._tag !== "Loading" ||
          model.results.requestId !== requestId ||
          model.results.surveyId !== surveyId
            ? [model, []]
            : [
                {
                  ...model,
                  list:
                    model.list._tag === "Success"
                      ? {
                          _tag: "Success",
                          data: {
                            ...model.list.data,
                            surveys: model.list.data.surveys.map((survey) =>
                              survey.surveyId === results.survey.surveyId ? results.survey : survey,
                            ),
                          },
                        }
                      : model.list,
                  detail: results.survey,
                  results: { _tag: "Success", data: results },
                },
                [],
              ],
        FailedResults: ({ requestId, surveyId, failure }) =>
          model.results._tag !== "Loading" ||
          model.results.requestId !== requestId ||
          model.results.surveyId !== surveyId
            ? [model, []]
            : [{ ...model, results: { _tag: "Failure", error: failure, surveyId } }, []],
        RetriedResults: () => {
          if (!canEditDraft(model) || model.detail === null) return [model, []];
          return makeUpdate(commands)(model, RequestedResults({ surveyId: model.detail.surveyId }));
        },
        SubmittedCreate: () => {
          if (!canEditDraft(model) || model.catalog._tag !== "Success") return [model, []];
          const retry =
            model.retryCreate !== null && sameDraft(model.retryCreate.draft, model.draft)
              ? model.retryCreate
              : null;
          const commandId = retry?.commandId ?? generatedCommandId(model, "create");
          const command = createCommand(model.draft, commandId);
          if (command === null) {
            return [{ ...model, banner: invalidDraftFailure, successMessage: null }, []];
          }
          const requestId = nextRequestId(model);
          return [
            {
              ...model,
              requestSequence: requestId,
              commandSequence: retry === null ? model.commandSequence + 1 : model.commandSequence,
              pendingCommand: "Create",
              retryCreate: null,
              banner: null,
              successMessage: null,
            },
            [commands.Create({ requestId, command })],
          ];
        },
        SucceededCreate: ({ requestId, survey }) => {
          if (model.pendingCommand !== "Create" || model.requestSequence !== requestId) {
            return [model, []];
          }
          const draft = {
            ...makeDraft(),
            departmentId: model.draft.departmentId,
            semesterId: model.draft.semesterId,
          };
          const [next, emitted] = loadSelectedList(
            {
              ...model,
              pendingCommand: null,
              retryCreate: null,
              detail: survey,
              selectedSurveyId: survey.surveyId,
              results: { _tag: "Idle" },
              draft,
              banner: null,
              successMessage: "Undersøkelsen er opprettet. Oversikten oppdateres fra serveren.",
            },
            commands,
            draft,
            true,
          );
          return [next, emitted];
        },
        FailedCreate: ({ requestId, commandId, failure }) =>
          model.pendingCommand !== "Create" || model.requestSequence !== requestId
            ? [model, []]
            : [
                {
                  ...model,
                  pendingCommand: null,
                  retryCreate: { commandId, draft: model.draft },
                  banner: failure,
                  successMessage: null,
                },
                [],
              ],
        SubmittedClose: ({ surveyId, expectedRevision }) => {
          if (
            !canEditDraft(model) ||
            model.detail === null ||
            model.detail.surveyId !== surveyId ||
            model.detail.state !== "Open"
          ) {
            return [model, []];
          }
          const retry =
            model.retryClose !== null &&
            model.retryClose.surveyId === surveyId &&
            model.retryClose.expectedRevision === expectedRevision
              ? model.retryClose
              : null;
          const commandId = retry?.commandId ?? generatedCommandId(model, "close");
          let command: S.Schema.Type<typeof SchoolSurveyCloseCommand>;
          try {
            command = S.decodeUnknownSync(SchoolSurveyCloseCommand)(
              { commandId, surveyId, expectedRevision },
              { onExcessProperty: "error" },
            );
          } catch {
            return [{ ...model, banner: invalidDraftFailure, successMessage: null }, []];
          }
          const requestId = nextRequestId(model);
          return [
            {
              ...model,
              requestSequence: requestId,
              commandSequence: retry === null ? model.commandSequence + 1 : model.commandSequence,
              pendingCommand: "Close",
              retryClose: null,
              banner: null,
              successMessage: null,
            },
            [commands.Close({ requestId, command })],
          ];
        },
        SucceededClose: ({ requestId, survey }) => {
          if (model.pendingCommand !== "Close" || model.requestSequence !== requestId) {
            return [model, []];
          }
          const [next, emitted] = loadSelectedList(
            {
              ...model,
              pendingCommand: null,
              retryClose: null,
              detail: survey,
              selectedSurveyId: survey.surveyId,
              results: { _tag: "Idle" },
              banner: null,
              successMessage: "Undersøkelsen er lukket. Oversikten oppdateres fra serveren.",
            },
            commands,
            model.draft,
            true,
          );
          return [next, emitted];
        },
        FailedClose: ({ requestId, commandId, surveyId, expectedRevision, failure }) =>
          model.pendingCommand !== "Close" || model.requestSequence !== requestId
            ? [model, []]
            : [
                {
                  ...model,
                  pendingCommand: null,
                  retryClose: { commandId, surveyId, expectedRevision },
                  banner: failure,
                  successMessage: null,
                },
                [],
              ],
        DismissedBanner: () => [{ ...model, banner: null, successMessage: null }, []],
      }),
    );
