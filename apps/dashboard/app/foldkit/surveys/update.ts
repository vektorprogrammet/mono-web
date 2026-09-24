import { Predicate } from "effect";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Match as M, Schema as S } from "effect";
import { Update } from "foldkit";
import {
  SchoolSurveyCloseCommand,
  SchoolSurveyCreateCommand,
  type SchoolSurveyListInput,
} from "./bridge";
import type { SchoolSurveysCommandFactories } from "./command";
import { RequestedResults, type Message } from "./message";
import { emptyDraft, questionDraft, type Model, type QuestionDraft, SchoolSurveysFailure, type SurveyDraft, ListState, ResultsState, CatalogState } from "./model";

export type UpdateResult = Update.Return<Model, Message>;

const invalidDraftFailure: SchoolSurveysFailure = SchoolSurveysFailure.cases.Failed.make({
  tag: "InvalidDraft",
  message: "Fyll ut avdeling, semester, tittel, avslutningstekst og minst ett gyldig spørsmål.",
});

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
    return ({ model: 
      {
        ...model,
        draft,
        list: ListState.cases.Idle.make({}),
        detail: null,
        selectedSurveyId: null,
        results: ResultsState.cases.Idle.make({}),
      }, commands: [] });
  }

  const requestId = nextRequestId(model);

  return ({ model: 
    {
      ...model,
      draft,
      requestSequence: requestId,
      list: ListState.cases.Loading.make({ requestId }),
      detail: preserveSelection ? model.detail : null,
      selectedSurveyId: preserveSelection ? model.selectedSurveyId : null,
      results: ResultsState.cases.Idle.make({}),
    }, commands: [commands.LoadList({ requestId, query })] });
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
  Predicate.isTagged(model.list, "Success")
    ? model.list.data.surveys.find((candidate) => candidate.surveyId === surveyId)
    : undefined;

const canEditDraft = (model: Model): boolean => model.pendingCommand === null;

export const updateFor =
  (commands: SchoolSurveysCommandFactories) =>
  (model: Model, message: Message): UpdateResult =>
    M.value(message).pipe(
      M.withReturnType<UpdateResult>(),
      M.tagsExhaustive({
        LoadedCatalog: ({ requestId, catalog }) => {
          if (!Predicate.isTagged(model.catalog, "Loading") || model.catalog.requestId !== requestId) {
            return ({ model: model, commands: [] });
          }

          const draft: SurveyDraft = {
            ...model.draft,
            departmentId: catalog.departments[0]?.departmentId ?? null,
            semesterId: catalog.semesters[0]?.semesterId ?? null,
          };

          const { model: next, commands: emitted = [] } = loadSelectedList(
            { ...model, catalog: CatalogState.cases.Success.make({ data: catalog }), banner: null },
            commands,
            draft,
          );

          return ({ model: next, commands: emitted });
        },
        FailedCatalog: ({ requestId, failure }) =>
          !Predicate.isTagged(model.catalog, "Loading") || model.catalog.requestId !== requestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                { ...model, catalog: CatalogState.cases.Failure.make({ error: failure }), list: ListState.cases.Idle.make({}) }, commands: [] }),
        RetriedCatalog: () => {
          if (!canEditDraft(model)) return ({ model: model, commands: [] });
          const requestId = nextRequestId(model);

          return ({ model: 
            {
              ...model,
              requestSequence: requestId,
              catalog: CatalogState.cases.Loading.make({ requestId }),
              list: ListState.cases.Idle.make({}),
              detail: null,
              selectedSurveyId: null,
              results: ResultsState.cases.Idle.make({}),
              banner: null,
              successMessage: null,
            }, commands: [commands.LoadCatalog({ requestId })] });
        },
        SelectedDepartment: ({ departmentId }) => {
          if (
            !canEditDraft(model) ||
            !Predicate.isTagged(model.catalog, "Success") ||
            (departmentId !== null &&
              !model.catalog.data.departments.some(
                (department) => department.departmentId === departmentId,
              )) ||
            departmentId === model.draft.departmentId
          ) {
            return ({ model: model, commands: [] });
          }

          const { model: next, commands: emitted = [] } = loadSelectedList(model, commands, {
            ...model.draft,
            departmentId,
          });

          return ({ model: { ...next, banner: null, successMessage: null }, commands: emitted });
        },
        SelectedSemester: ({ semesterId }) => {
          if (
            !canEditDraft(model) ||
            !Predicate.isTagged(model.catalog, "Success") ||
            (semesterId !== null &&
              !model.catalog.data.semesters.some(
                (semester) => semester.semesterId === semesterId,
              )) ||
            semesterId === model.draft.semesterId
          ) {
            return ({ model: model, commands: [] });
          }

          const { model: next, commands: emitted = [] } = loadSelectedList(model, commands, {
            ...model.draft,
            semesterId,
          });

          return ({ model: { ...next, banner: null, successMessage: null }, commands: emitted });
        },
        ChangedTitle: ({ value }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, title: value },
                  banner: null,
                  successMessage: null,
                }, commands: [] }),
        ChangedCompletionText: ({ value }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, completionText: value },
                  banner: null,
                  successMessage: null,
                }, commands: [] }),
        SelectedResultsVisibility: ({ resultsVisibility }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, resultsVisibility },
                  banner: null,
                  successMessage: null,
                }, commands: [] }),
        AddedQuestion: ({ kind }) => {
          if (!canEditDraft(model)) return ({ model: model, commands: [] });
          const draftId = model.questionSequence;

          return ({ model: 
            {
              ...model,
              questionSequence: draftId + 1,
              draft: {
                ...model.draft,
                questions: [...model.draft.questions, questionDraft(draftId, kind)],
              },
              banner: null,
              successMessage: null,
            }, commands: [] });
        },
        RemovedQuestion: ({ draftId }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
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
                }, commands: [] }),
        ChangedQuestionKind: ({ draftId, kind }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                updateQuestion(model, draftId, (question) => ({
                  ...question,
                  kind,
                  alternatives:
                    kind === "Text"
                      ? []
                      : question.alternatives.length === 0
                        ? ["", ""]
                        : question.alternatives,
                })), commands: [] }),
        ChangedQuestionLabel: ({ draftId, value }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: updateQuestion(model, draftId, (question) => ({ ...question, label: value })), commands: [] }),
        ChangedQuestionHelp: ({ draftId, value }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: updateQuestion(model, draftId, (question) => ({ ...question, help: value })), commands: [] }),
        ChangedQuestionRequired: ({ draftId, required }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: updateQuestion(model, draftId, (question) => ({ ...question, required })), commands: [] }),
        AddedAlternative: ({ draftId }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text"
                    ? question
                    : { ...question, alternatives: [...question.alternatives, ""] },
                ), commands: [] }),
        ChangedAlternative: ({ draftId, index, value }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text" || question.alternatives[index] === undefined
                    ? question
                    : {
                        ...question,
                        alternatives: question.alternatives.map((alternative, alternativeIndex) =>
                          alternativeIndex === index ? value : alternative,
                        ),
                      },
                ), commands: [] }),
        RemovedAlternative: ({ draftId, index }) =>
          !canEditDraft(model)
            ? ({ model: model, commands: [] })
            : ({ model: 
                updateQuestion(model, draftId, (question) =>
                  question.kind === "Text" || question.alternatives[index] === undefined
                    ? question
                    : {
                        ...question,
                        alternatives: question.alternatives.filter(
                          (_alternative, alternativeIndex) => alternativeIndex !== index,
                        ),
                      },
                ), commands: [] }),
        LoadedList: ({ requestId, list }) => {
          if (!Predicate.isTagged(model.list, "Loading") || model.list.requestId !== requestId) {
            return ({ model: model, commands: [] });
          }

          const selectedSurveyId = model.selectedSurveyId;

          const refreshedSurvey =
            selectedSurveyId !== null &&
            Predicate.isTagged(model.results, "Success") &&
            model.results.data.survey.surveyId === selectedSurveyId
              ? model.results.data.survey
              : null;

          const reconciledList =
            refreshedSurvey === null
              ? list
              : {
                  ...list,
                  surveys: list.surveys.map((survey) =>
                    survey.surveyId === refreshedSurvey.surveyId ? refreshedSurvey : survey,
                  ),
                };

          return ({ model: 
            {
              ...model,
              list: ListState.cases.Success.make({ data: reconciledList }),
              detail:
                selectedSurveyId === null
                  ? null
                  : (reconciledList.surveys.find(
                      (survey) => survey.surveyId === selectedSurveyId,
                    ) ?? null),
            }, commands: [] });
        },
        FailedList: ({ requestId, failure }) =>
          !Predicate.isTagged(model.list, "Loading") || model.list.requestId !== requestId
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, list: ListState.cases.Failure.make({ error: failure }) }, commands: [] }),
        RetriedList: () => {
          if (!canEditDraft(model)) return ({ model: model, commands: [] });

          return loadSelectedList(model, commands);
        },
        SelectedSurvey: ({ surveyId }) => {
          if (!canEditDraft(model)) return ({ model: model, commands: [] });
          const detail = selectedDetail(model, surveyId);

          if (detail === undefined) return ({ model: model, commands: [] });

          return ({ model: 
            {
              ...model,
              selectedSurveyId: surveyId,
              detail,
              results: ResultsState.cases.Idle.make({}),
              banner: null,
              successMessage: null,
            }, commands: [] });
        },
        RequestedResults: ({ surveyId }) => {
          if (!canEditDraft(model) || model.detail === null || model.detail.surveyId !== surveyId) {
            return ({ model: model, commands: [] });
          }

          const requestId = nextRequestId(model);

          return ({ model: 
            {
              ...model,
              requestSequence: requestId,
              results: ResultsState.cases.Loading.make({ requestId, surveyId }),
              banner: null,
            }, commands: [commands.LoadResults({ requestId, surveyId })] });
        },
        LoadedResults: ({ requestId, surveyId, results }) =>
          !Predicate.isTagged(model.results, "Loading") ||
          model.results.requestId !== requestId ||
          model.results.surveyId !== surveyId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  list:
                    Predicate.isTagged(model.list, "Success")
                      ? ListState.cases.Success.make({
                          data: {
                            ...model.list.data,
                            surveys: model.list.data.surveys.map((survey) =>
                              survey.surveyId === results.survey.surveyId ? results.survey : survey,
                            ),
                          },
                        })
                      : model.list,
                  detail: results.survey,
                  results: ResultsState.cases.Success.make({ data: results }),
                }, commands: [] }),
        FailedResults: ({ requestId, surveyId, failure }) =>
          !Predicate.isTagged(model.results, "Loading") ||
          model.results.requestId !== requestId ||
          model.results.surveyId !== surveyId
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, results: ResultsState.cases.Failure.make({ error: failure, surveyId }) }, commands: [] }),
        RetriedResults: () => {
          if (!canEditDraft(model) || model.detail === null) return ({ model: model, commands: [] });

          return updateFor(commands)(model, RequestedResults({ surveyId: model.detail.surveyId }));
        },
        SubmittedCreate: () => {
          if (!canEditDraft(model) || !Predicate.isTagged(model.catalog, "Success")) return ({ model: model, commands: [] });

          const retry =
            model.retryCreate !== null && sameDraft(model.retryCreate.draft, model.draft)
              ? model.retryCreate
              : null;

          const commandId = retry?.commandId ?? generatedCommandId(model, "create");
          const command = createCommand(model.draft, commandId);

          if (command === null) {
            return ({ model: { ...model, banner: invalidDraftFailure, successMessage: null }, commands: [] });
          }

          const requestId = nextRequestId(model);

          return ({ model: 
            {
              ...model,
              requestSequence: requestId,
              commandSequence: retry === null ? model.commandSequence + 1 : model.commandSequence,
              pendingCommand: "Create",
              retryCreate: null,
              banner: null,
              successMessage: null,
            }, commands: [commands.Create({ requestId, command })] });
        },
        SucceededCreate: ({ requestId, survey }) => {
          if (model.pendingCommand !== "Create" || model.requestSequence !== requestId) {
            return ({ model: model, commands: [] });
          }

          const draft = {
            ...emptyDraft(),
            departmentId: model.draft.departmentId,
            semesterId: model.draft.semesterId,
          };

          const { model: next, commands: emitted = [] } = loadSelectedList(
            {
              ...model,
              pendingCommand: null,
              retryCreate: null,
              detail: survey,
              selectedSurveyId: survey.surveyId,
              results: ResultsState.cases.Idle.make({}),
              draft,
              banner: null,
              successMessage: "Undersøkelsen er opprettet. Oversikten oppdateres fra serveren.",
            },
            commands,
            draft,
            true,
          );

          return ({ model: next, commands: emitted });
        },
        FailedCreate: ({ requestId, commandId, failure }) =>
          model.pendingCommand !== "Create" || model.requestSequence !== requestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  pendingCommand: null,
                  retryCreate: { commandId, draft: model.draft },
                  banner: failure,
                  successMessage: null,
                }, commands: [] }),
        SubmittedClose: ({ surveyId, expectedRevision }) => {
          if (
            !canEditDraft(model) ||
            model.detail === null ||
            model.detail.surveyId !== surveyId ||
            model.detail.state !== "Open"
          ) {
            return ({ model: model, commands: [] });
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
            return ({ model: { ...model, banner: invalidDraftFailure, successMessage: null }, commands: [] });
          }

          const requestId = nextRequestId(model);

          return ({ model: 
            {
              ...model,
              requestSequence: requestId,
              commandSequence: retry === null ? model.commandSequence + 1 : model.commandSequence,
              pendingCommand: "Close",
              retryClose: null,
              banner: null,
              successMessage: null,
            }, commands: [commands.Close({ requestId, command })] });
        },
        SucceededClose: ({ requestId, survey }) => {
          if (model.pendingCommand !== "Close" || model.requestSequence !== requestId) {
            return ({ model: model, commands: [] });
          }

          const { model: next, commands: emitted = [] } = loadSelectedList(
            {
              ...model,
              pendingCommand: null,
              retryClose: null,
              detail: survey,
              selectedSurveyId: survey.surveyId,
              results: ResultsState.cases.Idle.make({}),
              banner: null,
              successMessage: "Undersøkelsen er lukket. Oversikten oppdateres fra serveren.",
            },
            commands,
            model.draft,
            true,
          );

          return ({ model: next, commands: emitted });
        },
        FailedClose: ({ requestId, commandId, surveyId, expectedRevision, failure }) =>
          model.pendingCommand !== "Close" || model.requestSequence !== requestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  pendingCommand: null,
                  retryClose: { commandId, surveyId, expectedRevision },
                  banner: failure,
                  successMessage: null,
                }, commands: [] }),
        DismissedBanner: () => ({ model: { ...model, banner: null, successMessage: null }, commands: [] }),
      }),
    );
