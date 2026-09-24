import {
  DepartmentId,
  IdempotencyKey,
  SemesterId,
  SurveyId,
  SurveyQuestionId,
} from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSchoolSurveysClient, schoolSurveyResultsCsvUrl } from "./browser-client";

const departmentId = DepartmentId.make("department-survey-browser-test");

const semesterId = SemesterId.make("semester-survey-browser-test");

const surveyId = SurveyId.make("survey-browser-test");

const questionId = SurveyQuestionId.make("question-browser-test");

const createCommandId = IdempotencyKey.make("school-survey-browser-create-command");

const closeCommandId = IdempotencyKey.make("school-survey-browser-close-command");

const catalog = {
  departments: [{ departmentId, name: "Trondheim" }],
  semesters: [
    {
      semesterId,
      startAt: "2030-01-01T00:00:00.000Z",
      endAt: "2030-06-30T23:59:59.000Z",
    },
  ],
};

const survey = {
  surveyId,
  departmentId,
  semesterId,
  semesterLabel: "Vår 2030",
  title: "Skoleundersøkelse",
  completionText: "Takk for svaret.",
  resultsVisibility: "DepartmentManagers" as const,
  state: "Open" as const,
  revision: 0,
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
};



describe("School surveys browser bridge client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the single authenticated bridge for catalog, scoped list, create, close, and results", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json({ departmentId, semesterId, surveys: [survey] }))
      .mockResolvedValueOnce(Response.json(survey, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({
          ...survey,
          state: "Closed",
          revision: 1,
          closedAt: "2030-01-02T00:00:00.000Z",
          closedByPersonId: "person-browser-test",
        }),
      )
      .mockResolvedValueOnce(Response.json({ survey, responseCount: 0, responses: [] }));

    const client = createBrowserSchoolSurveysClient().surveys;
    await Effect.runPromise(client.readAdminCatalog());
    await Effect.runPromise(client.listAdminSurveys({ departmentId, semesterId }));
    await Effect.runPromise(
      client.createAdminSurvey({
        commandId: createCommandId,
        departmentId,
        semesterId,
        title: survey.title,
        completionText: survey.completionText,
        resultsVisibility: "DepartmentManagers",
        questions: [
          {
            kind: "Text",
            label: "Hva fungerte?",
            help: null,
            required: true,
          },
        ],
      }),
    );
    await Effect.runPromise(
      client.closeAdminSurvey({ commandId: closeCommandId, surveyId, expectedRevision: 0 }),
    );
    await Effect.runPromise(client.readAdminResults({ surveyId }));

    expect(fetchMock).toHaveBeenCalledTimes(5);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("/surveys");
      expect(init?.credentials).toBe("same-origin");
    }

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      operation: "list",
      query: { departmentId, semesterId },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      operation: "create",
      commandId: createCommandId,
      departmentId,
      semesterId,
      questions: [{ kind: "Text", label: "Hva fungerte?", help: null, required: true }],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      operation: "close",
      commandId: closeCommandId,
      surveyId,
      expectedRevision: 0,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      operation: "results",
      surveyId,
    });
  });

  it("keeps denial typed and rejects a response that is not the declared survey resource", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: { tag: "NotInScope" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ...catalog, staleLegacyField: true }));

    const client = createBrowserSchoolSurveysClient().surveys;
    const denied = await Effect.runPromise(client.readAdminCatalog().pipe(Effect.flip));
    expect(denied.error.tag).toBe("NotInScope");

    const malformed = await Effect.runPromise(client.readAdminCatalog().pipe(Effect.flip));
    expect(malformed.error.tag).toBe("SurveyDecodeError");
  });

  it("uses the route-safe bridge export URL instead of an API endpoint from the browser", () => {
    expect(schoolSurveyResultsCsvUrl(surveyId)).toBe(`/surveys?export=${encodeURIComponent(surveyId)}`);
  });
});
