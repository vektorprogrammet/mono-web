import { Effect } from "effect";
import {
  DepartmentId,
  IdempotencyKey,
  PersonId,
  SemesterId,
  SurveyId,
  SurveyQuestionId,
} from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import type { SchoolSurveysCommandFactories } from "./command";
import {
  ChangedTitle,
  FailedClose,
  FailedCreate,
  LoadedCatalog,
  LoadedList,
  LoadedResults,
  RequestedResults,
  SelectedSurvey,
  SubmittedClose,
  SubmittedCreate,
  SucceededCreate,
} from "./message";
import { ListState, init, SchoolSurveysFailure } from "./model";
import { updateFor } from "./update";

const issued: Array<string> = [];

const createdCommandIds: Array<string> = [];

const closedCommandIds: Array<string> = [];

const commands: SchoolSurveysCommandFactories = {
  LoadCatalog: ({ requestId }) => {
    issued.push(`catalog:${requestId}`);

    return {
      name: "LoadSchoolSurveyAdminCatalog",
      args: { requestId },
      effect: Effect.die("Transition tests must not execute commands"),
    };
  },
  LoadList: ({ requestId }) => {
    issued.push(`list:${requestId}`);

    return { name: "ListSchoolSurveys", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
  Create: ({ requestId, command }) => {
    issued.push(`create:${requestId}`);
    createdCommandIds.push(command.commandId);

    return { name: "CreateSchoolSurvey", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
  Close: ({ requestId, command }) => {
    issued.push(`close:${requestId}`);
    closedCommandIds.push(command.commandId);

    return { name: "CloseSchoolSurvey", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
  LoadResults: ({ requestId }) => {
    issued.push(`results:${requestId}`);

    return { name: "ReadSchoolSurveyResults", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
};

const update = updateFor(commands);

const departmentId = DepartmentId.make("survey-test-department");

const semesterId = SemesterId.make("survey-test-semester");

const surveyId = SurveyId.make("survey-test-id");

const questionId = SurveyQuestionId.make("survey-test-question");

const catalog = {
  departments: [{ departmentId, name: "Trondheim" }],
  semesters: [
    {
      semesterId,
      startAt: "2030-01-01T00:00:00.000Z",
      endAt: "2030-06-30T23:59:59.000Z",
    },
  ],
} as const;

const survey = {
  surveyId,
  departmentId,
  semesterId,
  semesterLabel: "Vår 2030",
  title: "Skoleundersøkelse",
  completionText: "Takk for svaret.",
  resultsVisibility: "DepartmentManagers" as const,
  state: "Open" as const,
  revision: 7,
  createdAt: null,
  createdByPersonId: null,
  closedAt: null,
  closedByPersonId: null,
  responseCount: 0,
  questions: [
    {
      kind: "Text" as const,
      questionId,
      label: "Hva fungerte?",
      help: null,
      required: true,
    },
  ],
} as const;

const emptyList = {
  departmentId,
  semesterId,
  surveys: [],
} as const;

const listedSurvey = {
  departmentId,
  semesterId,
  surveys: [survey],
} as const;

describe("school-survey Foldkit transitions", () => {
  it("creates a four-kind survey, rejects stale list data, and reloads the scoped list", () => {
    issued.length = 0;
    const scoped = update(init(), LoadedCatalog({ requestId: 1, catalog }));
    expect(issued).toEqual(["list:2"]);

    const loaded = update(scoped.model, LoadedList({ requestId: 2, list: emptyList }));

    const ready = {
      ...loaded.model,
      draft: {
        ...loaded.model.draft,
        title: survey.title,
        completionText: survey.completionText,
        questions: [
          {
            draftId: 1,
            kind: "Text" as const,
            label: "Tekst",
            help: "",
            required: true,
            alternatives: [],
          },
          {
            draftId: 2,
            kind: "List" as const,
            label: "Liste",
            help: "",
            required: true,
            alternatives: ["Ja", "Nei"],
          },
          {
            draftId: 3,
            kind: "Radio" as const,
            label: "Radio",
            help: "",
            required: true,
            alternatives: ["Første", "Andre"],
          },
          {
            draftId: 4,
            kind: "Check" as const,
            label: "Check",
            help: "",
            required: false,
            alternatives: ["A", "B"],
          },
        ],
      },
    };

    const submitted = update(ready, SubmittedCreate());
    expect(submitted.model.pendingCommand).toBe("Create");
    expect(issued).toEqual(["list:2", "create:3"]);

    const afterCreate = update(submitted.model, SucceededCreate({ requestId: 3, survey }));
    expect(afterCreate.model.detail).toEqual(survey);
    expect(afterCreate.model.list._tag).toBe("Loading");
    expect(afterCreate.model.draft.questions).toEqual([]);
    expect(issued).toEqual(["list:2", "create:3", "list:4"]);

    const stale = update(afterCreate.model, LoadedList({ requestId: 2, list: listedSurvey }));
    expect(stale).toEqual({ model: afterCreate.model, commands: [] });

    const refreshed = update(afterCreate.model, LoadedList({ requestId: 4, list: listedSurvey }));
    expect(refreshed.model.list).toEqual(ListState.cases.Success.make({ data: listedSurvey }));
    expect(refreshed.model.detail).toEqual(survey);
  });

  it("reuses an uncertain create command ID only while its intent is unchanged", () => {
    issued.length = 0;
    createdCommandIds.length = 0;
    const scoped = update(init(), LoadedCatalog({ requestId: 1, catalog }));
    const loaded = update(scoped.model, LoadedList({ requestId: 2, list: emptyList }));

    const ready = {
      ...loaded.model,
      commandSeed: "survey-retry-seed",
      draft: {
        ...loaded.model.draft,
        title: survey.title,
        completionText: survey.completionText,
        questions: [
          {
            draftId: 1,
            kind: "Text" as const,
            label: "Tekst",
            help: "",
            required: true,
            alternatives: [],
          },
        ],
      },
    };

    const submitted = update(ready, SubmittedCreate());
    const firstCommandId = IdempotencyKey.make("school-surveys-create-survey-retry-seed-1");
    expect(createdCommandIds).toEqual([firstCommandId]);
    expect(submitted.model.commandSequence).toBe(2);

    const failed = update(
      submitted.model,
      FailedCreate({
        requestId: 3,
        commandId: firstCommandId,
        failure: SchoolSurveysFailure.cases.Failed.make({ tag: "Network", message: "Tjenesten er utilgjengelig." }),
      }),
    );

    const retried = update(failed.model, SubmittedCreate());
    expect(createdCommandIds).toEqual([firstCommandId, firstCommandId]);
    expect(retried.model.commandSequence).toBe(2);

    const edited = update(failed.model, ChangedTitle({ value: "En annen undersøkelse" }));
    const replaced = update(edited.model, SubmittedCreate());
    expect(createdCommandIds).toEqual([
      firstCommandId,
      firstCommandId,
      "school-surveys-create-survey-retry-seed-2",
    ]);
    expect(replaced.model.commandSequence).toBe(3);
  });

  it("keeps the visible revision after a rejected close and discards stale results", () => {
    issued.length = 0;
    const scoped = update(init(), LoadedCatalog({ requestId: 1, catalog }));
    const listed = update(scoped.model, LoadedList({ requestId: 2, list: listedSurvey }));
    const selected = update(listed.model, SelectedSurvey({ surveyId }));

    closedCommandIds.length = 0;

    const closing = update(
      { ...selected.model, commandSeed: "survey-close-seed" },
      SubmittedClose({
        surveyId,
        expectedRevision: 7,
      }),
    );

    expect(closing.model.pendingCommand).toBe("Close");
    expect(issued).toEqual(["list:2", "close:3"]);

    const rejected = update(
      closing.model,
      FailedClose({
        requestId: 3,
        commandId: IdempotencyKey.make(closedCommandIds[0]!),
        surveyId,
        expectedRevision: 7,
        failure: SchoolSurveysFailure.cases.Failed.make({
          tag: "CommandConflict",
          message: "Undersøkelsen ble endret av en annen.",
        }),
      }),
    );

    expect(rejected.model.pendingCommand).toBeNull();
    expect(rejected.model.detail?.revision).toBe(7);
    expect(rejected.model.banner?.tag).toBe("CommandConflict");

    const loadingResults = update(rejected.model, RequestedResults({ surveyId }));
    expect(issued).toEqual(["list:2", "close:3", "results:4"]);

    const stale = update(
      loadingResults.model,
      LoadedResults({
        requestId: 3,
        surveyId,
        results: { survey, responseCount: 0, responses: [] },
      }),
    );

    expect(stale).toEqual({ model: loadingResults.model, commands: [] });
  });

  it("keeps newer results when an older list request finishes later", () => {
    issued.length = 0;
    const scoped = update(init(), LoadedCatalog({ requestId: 1, catalog }));
    const listed = update(scoped.model, LoadedList({ requestId: 2, list: listedSurvey }));
    const selected = update(listed.model, SelectedSurvey({ surveyId }));

    const overlapping = {
      ...selected.model,
      requestSequence: 3,
      list: { _tag: "Loading" as const, requestId: 3 },
    };

    const loadingResults = update(overlapping, RequestedResults({ surveyId }));

    const closedSurvey = {
      ...survey,
      state: "Closed" as const,
      revision: 8,
      closedAt: "2032-04-01T13:00:00.000Z",
      closedByPersonId: PersonId.make("survey-closing-person"),
    };

    const refreshed = update(
      loadingResults.model,
      LoadedResults({
        requestId: 4,
        surveyId,
        results: { survey: closedSurvey, responseCount: 0, responses: [] },
      }),
    );

    const delayedList = update(refreshed.model, LoadedList({ requestId: 3, list: listedSurvey }));
    const reselected = update(delayedList.model, SelectedSurvey({ surveyId }));

    expect(reselected.model.detail).toEqual(closedSurvey);
    expect(reselected.model.list).toEqual(ListState.cases.Success.make({ data: { ...listedSurvey, surveys: [closedSurvey] } }));
  });
});
