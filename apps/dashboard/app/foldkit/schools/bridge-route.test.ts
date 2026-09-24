import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolDirectoryExample } from "@vektorprogrammet/http-api";
import { nativeProblemResponse, nativeSessionResponse, privateReadHeaders, routeArgs, sessionCookie } from "../../../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { loader } from "../../routes/__foldkit.schools";

const departmentId = "d".repeat(256);

const directory = {
  activeSchools: [{ ...SchoolDirectoryExample.activeSchools[0], departments: [{ departmentId, name: "Trondheim" }] }],
  inactiveSchools: [],
};

const requests: Request[] = [];

let sessionResponse = nativeSessionResponse;

let schoolsResponse = () => Response.json(directory, { headers: privateReadHeaders });

const load = (path = "/schools", cookie = sessionCookie) => {
  const request = new Request(`http://dashboard.test${path}`, { headers: { cookie } });

  return loader(routeArgs(request, {}));
};

beforeEach(() => {
  requests.length = 0;
  sessionResponse = nativeSessionResponse;
  schoolsResponse = () => Response.json(directory, { headers: privateReadHeaders });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);

    return new URL(request.url).pathname === "/api/session" ? sessionResponse() : schoolsResponse();
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("authenticated Schools Foldkit bridge", () => {
  it("denies an expired session before reading the directory", async () => {
    sessionResponse = () => nativeProblemResponse("credential.invalid");
    const response = await load();
    expect(response.init?.status).toBe(401);
    expect(response.data).toEqual({ error: { tag: "UnauthenticatedActor" } });
    expect(requests.map(request => new URL(request.url).pathname)).not.toContain("/api/schools");
  });
  it("round-trips a canonical 256-character department through the strict bridge", async () => {
    const response = await load(`/schools?department=${departmentId}`);
    expect(response.data).toEqual(directory);
    expect(new Headers(response.init?.headers).get("cache-control")).toBe("no-store");
    const request = requests.find(request => new URL(request.url).pathname === "/api/schools");
    expect(request?.headers.get("cookie")).toBe(sessionCookie);
    expect(new URL(request!.url).searchParams.get("department")).toBe(departmentId);
  });
  it("maps a canonical authority denial without exposing its problem body", async () => {
    schoolsResponse = () => nativeProblemResponse("authority.denied");
    const response = await load();
    expect(response.init?.status).toBe(403);
    expect(response.data).toEqual({ error: { tag: "NotInScope" } });
  });
  it("rejects malformed upstream directory data at the actual SDK decoder", async () => {
    schoolsResponse = () => Response.json({ activeSchools: [{ schoolId: "invalid" }], inactiveSchools: [] }, { headers: privateReadHeaders });
    const response = await load();
    expect(response.init?.status).toBe(503);
    expect(response.data).toEqual({ error: { tag: "SchoolsPersistenceError" } });
  });
  it("rejects excess query parameters before the directory request", async () => {
    const response = await load("/schools?department=department-a&legacy=1");
    expect(response.init?.status).toBe(422);
    expect(response.data).toEqual({ error: { tag: "SchoolsDecodeError" } });
    expect(requests.map(request => new URL(request.url).pathname)).not.toContain("/api/schools");
  });
  it("does not turn a malformed authentication response into an authenticated request", async () => {
    sessionResponse = () => Response.json({ personId: "person-1" }, { headers: privateReadHeaders });
    const response = await load();
    expect(response.init?.status).toBe(503);
    expect(requests.map(request => new URL(request.url).pathname)).not.toContain("/api/schools");
  });
});
