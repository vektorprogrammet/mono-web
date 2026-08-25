import { ConfigurationError, NetworkError, SchoolsRejectionError } from "@vektorprogrammet/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createAuthenticatedClient: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../lib/auth.server", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("../../lib/api.server", () => ({
  createAuthenticatedClient: mocks.createAuthenticatedClient,
}));

import { loader } from "../../routes/__foldkit.schools";

const departmentId = "d".repeat(256);

const directory = {
  activeSchools: [
    {
      schoolId: 61,
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian" as const,
      departments: [{ departmentId, name: "Avdeling A" }],
      isActive: true,
    },
  ],
  inactiveSchools: [],
};

const load = (path = "/schools") =>
  loader({ request: new Request(`http://dashboard.test${path}`) } as never);

describe("authenticated Schools Foldkit bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("better-auth.session_token=session-value");
    mocks.createAuthenticatedClient.mockReturnValue({
      admin: { schools: { list: mocks.list } },
    });
    mocks.list.mockResolvedValue(directory);
  });

  it("returns 401 for an invalid or expired dashboard session", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 302 }));

    const response = await load();

    expect(response.init?.status).toBe(401);
    expect(response.data).toEqual({
      error: { tag: "UnauthenticatedActor" },
    });
    expect(mocks.createAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([
    [
      "network failure",
      new NetworkError("connection refused", new TypeError("connection refused")),
      502,
      "Network",
    ],
    [
      "configuration failure",
      new ConfigurationError("API URL is not configured"),
      503,
      "Configuration",
    ],
    ["server provider failure", new NetworkError("HTTP 503"), 503, "SchoolsPersistenceError"],
    ["unknown provider failure", new Error("provider unavailable"), 503, "SchoolsPersistenceError"],
  ] as const)(
    "maps a session %s without constructing a Schools client",
    async (_name, failure, expectedStatus, expectedTag) => {
      mocks.requireAuth.mockRejectedValueOnce(failure);

      const response = await load();

      expect(response.init?.status).toBe(expectedStatus);
      expect(response.data).toEqual({ error: { tag: expectedTag } });
      expect(mocks.createAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );

  it("round-trips a canonical 256-character department through the strict bridge", async () => {
    const response = await load(`/schools?department=${departmentId}`);
    expect(departmentId).toHaveLength(256);

    expect(response.init?.status ?? 200).toBe(200);
    expect(new Headers(response.init?.headers).get("cache-control")).toBe("no-store");
    expect(response.data).toEqual(directory);
    expect(mocks.createAuthenticatedClient).toHaveBeenCalledWith(
      "better-auth.session_token=session-value",
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ department: departmentId });
  });

  it("mirrors a typed backend Schools rejection and status", async () => {
    mocks.list.mockRejectedValueOnce(new SchoolsRejectionError("AuthorityInactive"));

    const response = await load();

    expect(response.init?.status).toBe(403);
    expect(response.data).toEqual({
      error: { tag: "AuthorityInactive" },
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("preserves an upstream decode failure as unavailable", async () => {
    mocks.list.mockRejectedValueOnce(new SchoolsRejectionError("SchoolsDecodeError"));

    const response = await load();

    expect(response.init?.status).toBe(503);
    expect(response.data).toEqual({
      error: { tag: "SchoolsDecodeError" },
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("rejects excess query parameters without invoking the backend client", async () => {
    const response = await load("/schools?department=department-a&legacy=1");

    expect(response.init?.status).toBe(422);
    expect(response.data).toEqual({
      error: { tag: "SchoolsDecodeError" },
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
