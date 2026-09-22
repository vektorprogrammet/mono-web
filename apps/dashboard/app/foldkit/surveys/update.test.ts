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
import { makeInitialModel } from "./model";
import { makeUpdate } from "./update";

const issued: Array<string> = [];
const createdCommandIds: Array<string> = [];
const closedCommandIds: Array<string> = [];
const commands: SchoolSurveysCommandFactories = {
  LoadCatalog: ({ requestId }) => {
    issued.push(`catalog:${requestId}`);
    return {
      name: "LoadSchoolSurveyAdminCatalog",
      args: { requestId },
      effect: undefined as never,
    };
  },
  LoadList: ({ requestId }) => {
    issued.push(`list:${requestId}`);
    return { name: "ListSchoolSurveys", args: { requestId }, effect: undefined as never };
  },
  Create: ({ requestId, command }) => {
    issued.push(`create:${requestId}`);
    createdCommandIds.push(command.commandId);
    return { name: "CreateSchoolSurvey", args: { requestId }, effect: undefined as never };
  },
  Close: ({ requestId, command }) => {
    issued.push(`close:${requestId}`);
    closedCommandIds.push(command.commandId);
    return { name: "CloseSchoolSurvey", args: { requestId }, effect: undefined as never };
  },
  LoadResults: ({ requestId }) => {
    issued.push(`results:${requestId}`);
    return { name: "ReadSchoolSurveyResults", args: { requestId }, effect: undefined as never };
  },
};
const update = makeUpdate(commands);

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
    const scoped = update(makeInitialModel(), LoadedCatalog({ requestId: 1, catalog }));
    expect(issued).toEqual(["list:2"]);

    const loaded = update(scoped[0], LoadedList({ requestId: 2, list: emptyList }));
    const ready = {
      ...loaded[0],
      draft: {
        ...loaded[0].draft,
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
    expect(submitted[0].pendingCommand).toBe("Create");
    expect(issued).toEqual(["list:2", "create:3"]);

    const afterCreate = update(submitted[0], SucceededCreate({ requestId: 3, survey }));
    expect(afterCreate[0].detail).toEqual(survey);
    expect(afterCreate[0].list._tag).toBe("Loading");
    expect(afterCreate[0].draft.questions).toEqual([]);
    expect(issued).toEqual(["list:2", "create:3", "list:4"]);

    const stale = update(afterCreate[0], LoadedList({ requestId: 2, list: listedSurvey }));
    expect(stale).toEqual([afterCreate[0], []]);

    const refreshed = update(afterCreate[0], LoadedList({ requestId: 4, list: listedSurvey }));
    expect(refreshed[0].list).toEqual({ _tag: "Success", data: listedSurvey });
    expect(refreshed[0].detail).toEqual(survey);
  });

  it("reuses an uncertain create command ID only while its intent is unchanged", () => {
    issued.length = 0;
    createdCommandIds.length = 0;
    const scoped = update(makeInitialModel(), LoadedCatalog({ requestId: 1, catalog }));
    const loaded = update(scoped[0], LoadedList({ requestId: 2, list: emptyList }));
    const ready = {
      ...loaded[0],
      commandSeed: "survey-retry-seed",
      draft: {
        ...loaded[0].draft,
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
    expect(submitted[0].commandSequence).toBe(2);

    const failed = update(
      submitted[0],
      FailedCreate({
        requestId: 3,
        commandId: firstCommandId,
        failure: { _tag: "Failed", tag: "Network", message: "Tjenesten er utilgjengelig." },
      }),
    );
    const retried = update(failed[0], SubmittedCreate());
    expect(createdCommandIds).toEqual([firstCommandId, firstCommandId]);
    expect(retried[0].commandSequence).toBe(2);

    const edited = update(failed[0], ChangedTitle({ value: "En annen undersøkelse" }));
    const replaced = update(edited[0], SubmittedCreate());
    expect(createdCommandIds).toEqual([
      firstCommandId,
      firstCommandId,
      "school-surveys-create-survey-retry-seed-2",
    ]);
    expect(replaced[0].commandSequence).toBe(3);
  });

  it("keeps the visible revision after a rejected close and discards stale results", () => {
    issued.length = 0;
    const scoped = update(makeInitialModel(), LoadedCatalog({ requestId: 1, catalog }));
    const listed = update(scoped[0], LoadedList({ requestId: 2, list: listedSurvey }));
    const selected = update(listed[0], SelectedSurvey({ surveyId }));

    closedCommandIds.length = 0;
    const closing = update(
      { ...selected[0], commandSeed: "survey-close-seed" },
      SubmittedClose({
        surveyId,
        expectedRevision: 7,
      }),
    );
    expect(closing[0].pendingCommand).toBe("Close");
    expect(issued).toEqual(["list:2", "close:3"]);

    const rejected = update(
      closing[0],
      FailedClose({
        requestId: 3,
        commandId: IdempotencyKey.make(closedCommandIds[0]!),
        surveyId,
        expectedRevision: 7,
        failure: {
          _tag: "Failed",
          tag: "CommandConflict",
          message: "Undersøkelsen ble endret av en annen.",
        },
      }),
    );
    expect(rejected[0].pendingCommand).toBeNull();
    expect(rejected[0].detail?.revision).toBe(7);
    expect(rejected[0].banner?.tag).toBe("CommandConflict");

    const loadingResults = update(rejected[0], RequestedResults({ surveyId }));
    expect(issued).toEqual(["list:2", "close:3", "results:4"]);
    const stale = update(
      loadingResults[0],
      LoadedResults({
        requestId: 3,
        surveyId,
        results: { survey, responseCount: 0, responses: [] },
      }),
    );
    expect(stale).toEqual([loadingResults[0], []]);
  });

  it("keeps newer results when an older list request finishes later", () => {
    issued.length = 0;
    const scoped = update(makeInitialModel(), LoadedCatalog({ requestId: 1, catalog }));
    const listed = update(scoped[0], LoadedList({ requestId: 2, list: listedSurvey }));
    const selected = update(listed[0], SelectedSurvey({ surveyId }));
    const overlapping = {
      ...selected[0],
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
      loadingResults[0],
      LoadedResults({
        requestId: 4,
        surveyId,
        results: { survey: closedSurvey, responseCount: 0, responses: [] },
      }),
    );
    const delayedList = update(refreshed[0], LoadedList({ requestId: 3, list: listedSurvey }));
    const reselected = update(delayedList[0], SelectedSurvey({ surveyId }));

    expect(reselected[0].detail).toEqual(closedSurvey);
    expect(reselected[0].list).toEqual({
      _tag: "Success",
      data: { ...listedSurvey, surveys: [closedSurvey] },
    });
  });
});
