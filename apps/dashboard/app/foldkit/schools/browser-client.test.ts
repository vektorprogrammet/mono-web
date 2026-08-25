import { Effect, Schema as S } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const directory = {
  activeSchools: [
    {
      schoolId: 1,
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian",
      departments: [{ departmentId: "department-a", name: "Avdeling A" }],
      isActive: true,
    },
  ],
  inactiveSchools: [],
};

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Schools directory browser client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("API_URL", "http://api.test");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // API_URL is captured during ESM evaluation, so these tests intentionally
  // exercise the module-loading boundary after installing the process input.
  it("sends one credentialed native request with optional department narrowing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(directory));
    const { SchoolDepartmentId } = await import("@vektorprogrammet/sdk/effect");
    const { createBrowserSchoolsDirectoryClient } = await import("./browser-client");

    const result = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().admin.schools.list({
        department: S.decodeUnknownSync(SchoolDepartmentId)("department-a"),
      }),
    );

    expect(result).toEqual(directory);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test/api/admin/schools?department=department-a");
    expect(init?.method).toBe("GET");
    expect(init?.credentials ?? "same-origin").toBe("same-origin");
  });

  it("strictly rejects excess response fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...directory, legacyCapacity: {} }));
    const { createBrowserSchoolsDirectoryClient } = await import("./browser-client");

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().admin.schools.list().pipe(Effect.flip),
    );

    expect(failure._tag).toBe("SchoolsDecodeError");
  });
});
