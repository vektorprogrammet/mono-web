import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionalReadHeaders, nativeProblemResponse, nativeSessionResponse, privateReadHeaders, routeArgs, sessionCookie } from "../../../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action, loader } from "../../routes/__foldkit.surveys";

const surveyId = "survey-route-test";

const departmentId = "department-route-test";

const semesterId = "semester-route-test";

const survey = {
  surveyId, departmentId, semesterId, semesterLabel: "Vår 2030", title: "Skoleundersøkelse",
  completionText: "Takk for svaret.", resultsVisibility: "DepartmentManagers", state: "Open", revision: 0,
  createdAt: null, createdByPersonId: null, closedAt: null, closedByPersonId: null, responseCount: 0,
  questions: [{ kind: "Text", questionId: "question-route-test", label: "Hva fungerte?", help: null, required: true }],
};

const catalog = {
  departments: [{ departmentId, name: "Trondheim" }],
  semesters: [{ semesterId, startAt: "2030-01-01T00:00:00.000Z", endAt: "2030-06-30T23:59:59.000Z" }],
};

const requests: Request[] = [];

let sessionResponse = nativeSessionResponse;

let closeResponse = () => Response.json({ ...survey, state: "Closed", revision: 1, closedAt: "2030-01-02T00:00:00.000Z", closedByPersonId: "person-route-test" }, { headers: { ...conditionalReadHeaders, "cache-control": "no-store" } });

let csvDisposition = `attachment; filename="school-survey-${surveyId}-results.csv"`;

beforeEach(() => {
  requests.length = 0;
  sessionResponse = nativeSessionResponse;
  csvDisposition = `attachment; filename="school-survey-${surveyId}-results.csv"`;
  closeResponse = () => Response.json({ ...survey, state: "Closed", revision: 1, closedAt: "2030-01-02T00:00:00.000Z", closedByPersonId: "person-route-test" }, { headers: { ...conditionalReadHeaders, "cache-control": "no-store" } });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;

    if (path === "/api/session") return sessionResponse();

    if (path === "/api/surveys/admin/catalog") return Response.json(catalog, { headers: privateReadHeaders });

    if (path === "/api/surveys/admin" && request.method === "POST") return Response.json(survey, { status: 201, headers: { ...conditionalReadHeaders, "cache-control": "no-store", location: `/api/surveys/admin/${surveyId}` } });

    if (path === "/api/surveys/admin") return Response.json({ departmentId, semesterId, surveys: [survey] }, { headers: privateReadHeaders });

    if (path.endsWith("/close")) return closeResponse();

    if (path.endsWith("/results")) return Response.json({ survey, responseCount: 0, responses: [] }, { headers: privateReadHeaders });

    if (path.endsWith("/results.csv")) return new Response("submittedAt,school,Hva fungerte?\n", { headers: { ...privateReadHeaders, "content-disposition": csvDisposition, "content-type": "text/csv; charset=utf-8" } });
    throw new Error(`Unexpected survey request: ${path}`);
  }));
});

afterEach(() => vi.unstubAllGlobals());

const load = (path = "/surveys") => loader(routeArgs(new Request(`http://dashboard.test${path}`, { headers: { cookie: sessionCookie } }), {}));

const post = (operation: Schema.Json) => action(routeArgs(new Request("http://dashboard.test/surveys", {
  method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie }, body: JSON.stringify(operation),
}), {}));

describe("authenticated School-survey Foldkit bridge", () => {
  it("reads the catalog and scoped survey operations through the generated SDK", async () => {
    const catalogResult = await load();

    if (catalogResult instanceof Response) throw new Error("Expected a survey catalog");
    expect(catalogResult.data).toEqual(catalog);
    expect(new Headers(catalogResult.init?.headers).get("cache-control")).toBe("no-store");
    const list = await post({ operation: "list", query: { departmentId, semesterId } });
    expect(list.data).toEqual({ departmentId, semesterId, surveys: [survey] });
    const create = await post({ operation: "create", commandId: "school-survey-route-create-command", departmentId, semesterId, title: survey.title, completionText: survey.completionText, resultsVisibility: "DepartmentManagers", questions: [{ kind: "Text", label: "Hva fungerte?", help: null, required: true }] });
    expect(create.data).toEqual(survey);
    const close = await post({ operation: "close", commandId: "school-survey-route-close-command", surveyId, expectedRevision: 0 });
    expect(close.data).toMatchObject({ surveyId, state: "Closed", revision: 1 });
    const results = await post({ operation: "results", surveyId });
    expect(results.data).toEqual({ survey, responseCount: 0, responses: [] });
  });
  it("preserves CSV transport and translates a stale close problem", async () => {
    const csv = await load(`/surveys?export=${surveyId}`);

    if (!(csv instanceof Response)) throw new Error("Expected a CSV response");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("cache-control")).toBe("private, no-store");
    expect(csv.headers.get("content-disposition")).toBe(csvDisposition);
    expect(await csv.text()).toBe("submittedAt,school,Hva fungerte?\n");
    closeResponse = () => nativeProblemResponse("precondition.failed");
    const stale = await post({ operation: "close", commandId: "school-survey-route-stale-command", surveyId, expectedRevision: 0 });
    expect(stale.init?.status).toBe(409);
    expect(stale.data).toEqual({ error: { tag: "CommandConflict" } });
  });
  it("preserves encoded CSV filenames and rejects malformed export IDs locally", async () => {
    const specialSurveyId = "survey!route'(test)*";
    csvDisposition = 'attachment; filename="school-survey-survey%21route%27%28test%29%2A-results.csv"';
    const csv = await load(`/surveys?${new URLSearchParams({ export: specialSurveyId })}`);

    if (!(csv instanceof Response)) throw new Error("Expected a CSV response");
    expect(csv.headers.get("content-disposition")).toBe(csvDisposition);
    const exported = requests.find(request => new URL(request.url).pathname.endsWith("/results.csv"));
    expect(decodeURIComponent(new URL(exported!.url).pathname)).toBe(`/api/surveys/admin/${specialSurveyId}/results.csv`);
    requests.length = 0;
    const malformed = await load("/surveys?export=%20");

    if (malformed instanceof Response) throw new Error("Expected an export validation error");
    expect(malformed.init?.status).toBe(422);
    expect(malformed.data).toEqual({ error: { tag: "SurveyDecodeError" } });
    expect(requests.some(request => new URL(request.url).pathname.endsWith("/results.csv"))).toBe(false);
  });
  it("does not read survey data for an expired dashboard session", async () => {
    sessionResponse = () => nativeProblemResponse("credential.invalid");
    const response = await load();

    if (response instanceof Response) throw new Error("Expected a private survey failure");
    expect(response.init?.status).toBe(401);
    expect(response.data).toEqual({ error: { tag: "UnauthenticatedActor" } });
    expect(requests.some(request => new URL(request.url).pathname.startsWith("/api/surveys"))).toBe(false);
  });
});
