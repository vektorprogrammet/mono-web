import { ArticleDetailExample, DepartmentExample } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionalReadHeaders, nativeProblemResponse, nativeSessionResponse, privateReadHeaders, routeArgs, sessionCookie } from "../../../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action, loader } from "../../routes/__foldkit.content";

const article = { ...ArticleDetailExample, articleId: 7 };

const departments = [
  { ...DepartmentExample, departmentId: "department-a", name: "Trondheim" },
  { ...DepartmentExample, departmentId: "department-b", name: "Bergen" },
  { ...DepartmentExample, departmentId: "department-old", name: "Tidligere", active: false },
];

const requests: Request[] = [];

let workspaceResponse = () => Response.json({ entries: [] }, { headers: privateReadHeaders });

let createResponse = () => nativeProblemResponse("authority.denied");

const loadWorkspace = () => loader(routeArgs(new Request("http://dashboard.test/content", { headers: { cookie: sessionCookie } }), {}));

const post = (body: string) => action(routeArgs(new Request("http://dashboard.test/content", {
  method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie }, body,
}), {}));

beforeEach(() => {
  requests.length = 0;
  workspaceResponse = () => Response.json({ entries: [] }, { headers: privateReadHeaders });
  createResponse = () => nativeProblemResponse("authority.denied");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;

    if (path === "/api/session") return nativeSessionResponse();

    if (path === "/api/departments") return Response.json(departments, { headers: { ...conditionalReadHeaders, "cache-control": "public, max-age=60, s-maxage=300, must-revalidate" } });

    if (path === "/api/content/articles/7") return Response.json(article, { headers: conditionalReadHeaders });

    if (path === "/api/content/articles" && request.method === "POST") return createResponse();

    if (path === "/api/content/articles") return workspaceResponse();
    throw new Error(`Unexpected content request: ${path}`);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Content bridge denial decoding", () => {
  it("maps canonical authority denial across the real SDK boundary", async () => {
    workspaceResponse = () => nativeProblemResponse("authority.denied");
    const result = await loadWorkspace();
    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "NotInScope" } });
  });
  it.each(['{"_tag":"AuthorityInactive"}', '{"code":"made-up.failure"}'])("does not grant authority to malformed problem bytes %s", async body => {
    workspaceResponse = () => new Response(body, { status: 403, headers: { "content-type": "application/problem+json", "cache-control": "no-store", vary: "Origin" } });
    const result = await loadWorkspace();
    expect(result.init?.status).toBe(503);
    expect(result.data).toEqual({ error: { tag: "ContentPersistenceError" } });
  });
  it("returns only active department choices even when the workspace is empty", async () => {
    const result = await loadWorkspace();
    expect(result.data).toEqual({ workspace: { entries: [] }, knownDepartments: [{ departmentId: "department-a", name: "Trondheim" }, { departmentId: "department-b", name: "Bergen" }] });
  });
  it("does not let a visible department choice override server authority", async () => {
    await loadWorkspace();
    const result = await post(JSON.stringify({ operation: "createDraft", commandId: "AAAAAAAAAAAAAAAAAAAAAA", title: "Tittel", bodyHtml: "<p>Brødtekst</p>", departmentIds: ["department-b"], sticky: false }));
    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "NotInScope" } });
    const request = requests.find(request => request.method === "POST");
    expect(await request!.json()).toMatchObject({ departmentIds: ["department-b"] });
  });
  it("reads private detail but rejects caller-supplied authority fields before HTTP dispatch", async () => {
    const result = await post('{"operation":"readArticle","articleId":7}');
    expect(result.data).toEqual({ body: article, etag: conditionalReadHeaders.etag });
    const before = requests.filter(request => new URL(request.url).pathname === "/api/content/articles/7").length;
    const polluted = await post('{"operation":"readArticle","articleId":7,"createdByPersonId":"person-secret"}');
    expect(polluted.init?.status).toBe(422);
    expect(polluted.data).toEqual({ error: { tag: "ContentDecodeError" } });
    expect(requests.filter(request => new URL(request.url).pathname === "/api/content/articles/7")).toHaveLength(before);
  });
  it("rejects unknown operations without a content write", async () => {
    const result = await post('{"operation":"saveDraft","articleId":7}');
    expect(result.init?.status).toBe(422);
    expect(requests.some(request => request.method === "POST")).toBe(false);
  });
});
