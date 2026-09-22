import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createAuthenticatedClient: vi.fn(),
  readAdminCatalog: vi.fn(),
  listAdminSurveys: vi.fn(),
  createAdminSurvey: vi.fn(),
  closeAdminSurvey: vi.fn(),
  readAdminResults: vi.fn(),
  exportAdminResults: vi.fn(),
}));

vi.mock("../../lib/auth.server", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("../../lib/api.server", () => ({
  createAuthenticatedClient: mocks.createAuthenticatedClient,
}));

import { action, loader } from "../../routes/__foldkit.surveys";

const surveyId = "survey-route-test";
const departmentId = "department-route-test";
const semesterId = "semester-route-test";
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
      questionId: "question-route-test",
      label: "Hva fungerte?",
      help: null,
      required: true,
    },
  ],
};
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

const load = (path = "/surveys") =>
  loader({ request: new Request(`http://dashboard.test${path}`) } as never);
const post = (operation: unknown) =>
  action({
    request: new Request("http://dashboard.test/surveys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation),
    }),
  } as never);

const bridgeData = <A>(value: unknown): { readonly data: A; readonly init?: ResponseInit } => {
  if (value instanceof Response) throw new Error("Expected a Foldkit bridge data response");
  return value as { readonly data: A; readonly init?: ResponseInit };
};

describe("authenticated School-survey Foldkit bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("better-auth.session_token=survey-route-test");
    mocks.createAuthenticatedClient.mockReturnValue({
      surveys: {
        readAdminCatalog: mocks.readAdminCatalog,
        listAdminSurveys: mocks.listAdminSurveys,
        createAdminSurvey: mocks.createAdminSurvey,
        closeAdminSurvey: mocks.closeAdminSurvey,
        readAdminResults: mocks.readAdminResults,
        exportAdminResults: mocks.exportAdminResults,
      },
    });
    mocks.readAdminCatalog.mockResolvedValue({ body: catalog });
    mocks.listAdminSurveys.mockResolvedValue({
      body: { departmentId, semesterId, surveys: [survey] },
    });
    mocks.createAdminSurvey.mockResolvedValue({ body: survey });
    mocks.closeAdminSurvey.mockResolvedValue({
      body: {
        ...survey,
        state: "Closed",
        revision: 1,
        closedAt: "2030-01-02T00:00:00.000Z",
        closedByPersonId: "person-route-test",
      },
    });
    mocks.readAdminResults.mockResolvedValue({ body: { survey, responseCount: 0, responses: [] } });
    mocks.exportAdminResults.mockResolvedValue({
      body: "submittedAt,school,Hva fungerte?\n",
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="school-survey-${surveyId}-results.csv"`,
        "content-type": "text/csv; charset=utf-8",
        vary: "Origin",
      },
    });
  });

  it("reads the authorized catalog through the generated SDK client", async () => {
    const response = bridgeData<typeof catalog>(await load());

    expect(response.data).toEqual(catalog);
    expect(new Headers(response.init?.headers).get("cache-control")).toBe("no-store");
    expect(mocks.createAuthenticatedClient).toHaveBeenCalledWith(
      "better-auth.session_token=survey-route-test",
      expect.any(Request),
    );
    expect(mocks.readAdminCatalog).toHaveBeenCalledWith();
  });

  it("decodes scoped list, create, close, and results operations before calling only SDK methods", async () => {
    const list = bridgeData<{
      readonly departmentId: string;
      readonly semesterId: string;
      readonly surveys: ReadonlyArray<typeof survey>;
    }>(await post({ operation: "list", query: { departmentId, semesterId } }));
    const create = bridgeData<typeof survey>(
      await post({
        operation: "create",
        commandId: "school-survey-route-create-command",
        departmentId,
        semesterId,
        title: survey.title,
        completionText: survey.completionText,
        resultsVisibility: "DepartmentManagers",
        questions: [{ kind: "Text", label: "Hva fungerte?", help: null, required: true }],
      }),
    );
    const close = bridgeData<typeof survey>(
      await post({
        operation: "close",
        commandId: "school-survey-route-close-command",
        surveyId,
        expectedRevision: 0,
      }),
    );
    const results = bridgeData<{
      readonly survey: typeof survey;
      readonly responseCount: number;
      readonly responses: ReadonlyArray<never>;
    }>(await post({ operation: "results", surveyId }));

    expect(list.data).toEqual({ departmentId, semesterId, surveys: [survey] });
    expect(create.data).toEqual(survey);
    expect(close.data).toMatchObject({ surveyId, state: "Closed", revision: 1 });
    expect(results.data).toEqual({ survey, responseCount: 0, responses: [] });
    expect(mocks.listAdminSurveys).toHaveBeenCalledWith({ query: { departmentId, semesterId } });
    expect(mocks.createAdminSurvey).toHaveBeenCalledWith({
      headers: { "idempotency-key": "school-survey-route-create-command" },
      payload: {
        departmentId,
        semesterId,
        title: survey.title,
        completionText: survey.completionText,
        resultsVisibility: "DepartmentManagers",
        questions: [{ kind: "Text", label: "Hva fungerte?", help: null, required: true }],
      },
    });
    expect(mocks.closeAdminSurvey).toHaveBeenCalledWith({
      params: { surveyId },
      headers: { "idempotency-key": "school-survey-route-close-command" },
      payload: { expectedRevision: 0 },
    });
    expect(mocks.readAdminResults).toHaveBeenCalledWith({ params: { surveyId } });
  });

  it("preserves the CSV transport contract and maps a stale close to a typed conflict", async () => {
    const csv = await load(`/surveys?export=${surveyId}`);
    if (!(csv instanceof Response)) throw new Error("Expected a CSV response");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("cache-control")).toBe("private, no-store");
    expect(csv.headers.get("content-disposition")).toBe(
      `attachment; filename="school-survey-${surveyId}-results.csv"`,
    );
    expect(await csv.text()).toBe("submittedAt,school,Hva fungerte?\n");
    expect(mocks.exportAdminResults).toHaveBeenCalledWith({ params: { surveyId } });

    mocks.closeAdminSurvey.mockRejectedValueOnce({ code: "precondition.failed" });
    const stale = bridgeData<{ readonly error: { readonly tag: string } }>(
      await post({
        operation: "close",
        commandId: "school-survey-route-stale-command",
        surveyId,
        expectedRevision: 0,
      }),
    );
    expect(stale.init?.status).toBe(409);
    expect(stale.data).toEqual({ error: { tag: "CommandConflict" } });
  });

  it("preserves special survey IDs in CSV filenames and rejects malformed export IDs", async () => {
    const specialSurveyId = "survey!route'(test)*";
    const encodedDisposition =
      'attachment; filename="school-survey-survey%21route%27%28test%29%2A-results.csv"';
    mocks.exportAdminResults.mockResolvedValueOnce({
      body: "submittedAt,school,Hva fungerte?\n",
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": encodedDisposition,
        "content-type": "text/csv; charset=utf-8",
        vary: "Origin",
      },
    });

    const csv = await load(`/surveys?${new URLSearchParams({ export: specialSurveyId })}`);
    if (!(csv instanceof Response)) throw new Error("Expected a CSV response");
    expect(csv.headers.get("content-disposition")).toBe(encodedDisposition);
    expect(mocks.exportAdminResults).toHaveBeenCalledWith({
      params: { surveyId: specialSurveyId },
    });

    mocks.exportAdminResults.mockClear();
    const malformed = bridgeData<{ readonly error: { readonly tag: string } }>(
      await load("/surveys?export=%20"),
    );
    expect(malformed.init?.status).toBe(422);
    expect(malformed.data).toEqual({ error: { tag: "SurveyDecodeError" } });
    expect(mocks.exportAdminResults).not.toHaveBeenCalled();
  });
  it("does not construct an SDK client for an expired dashboard session", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 302 }));

    const response = bridgeData<{ readonly error: { readonly tag: string } }>(await load());

    expect(response.init?.status).toBe(401);
    expect(response.data).toEqual({ error: { tag: "UnauthenticatedActor" } });
    expect(mocks.createAuthenticatedClient).not.toHaveBeenCalled();
  });
});
