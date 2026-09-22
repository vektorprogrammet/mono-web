import { DepartmentId, IdempotencyKey, SemesterId, SurveyId, SurveyQuestionId } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import type { SchoolSurveysCommandFactories } from "./command";
import {
  FailedClose,
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
const commands: SchoolSurveysCommandFactories = {
  LoadCatalog: ({ requestId }) => {
    issued.push(`catalog:${requestId}`);
    return { name: "LoadSchoolSurveyAdminCatalog", args: { requestId }, effect: undefined as never };
  },
  LoadList: ({ requestId }) => {
    issued.push(`list:${requestId}`);
    return { name: "ListSchoolSurveys", args: { requestId }, effect: undefined as never };
  },
  Create: ({ requestId }) => {
    issued.push(`create:${requestId}`);
    return { name: "CreateSchoolSurvey", args: { requestId }, effect: undefined as never };
  },
  Close: ({ requestId }) => {
    issued.push(`close:${requestId}`);
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
          { draftId: 1, kind: "Text" as const, label: "Tekst", help: "", required: true, alternatives: [] },
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
    const submitted = update(
      ready,
      SubmittedCreate({ commandId: IdempotencyKey.make("school-survey-create-test-command") }),
    );
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

  it("keeps the visible revision after a rejected close and discards stale results", () => {
    issued.length = 0;
    const scoped = update(makeInitialModel(), LoadedCatalog({ requestId: 1, catalog }));
    const listed = update(scoped[0], LoadedList({ requestId: 2, list: listedSurvey }));
    const selected = update(listed[0], SelectedSurvey({ surveyId }));

    const closing = update(
      selected[0],
      SubmittedClose({
        commandId: IdempotencyKey.make("school-survey-close-test-command"),
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
});
