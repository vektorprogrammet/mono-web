import { SchoolsRejectionError } from "@vektorprogrammet/sdk";
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

const directory = {
  activeSchools: [
    {
      schoolId: 61,
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian" as const,
      departments: [{ departmentId: "department-a", name: "Avdeling A" }],
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

  it("requires the dashboard session before constructing an SDK client", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 302 }));

    const response = await load();

    expect(response.init?.status).toBe(401);
    expect(response.data).toEqual({
      error: { tag: "UnauthenticatedActor" },
    });
    expect(mocks.createAuthenticatedClient).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("forwards one strictly decoded list call with optional narrowing", async () => {
    const response = await load("/schools?department=department-a");

    expect(response.init?.status ?? 200).toBe(200);
    expect(new Headers(response.init?.headers).get("cache-control")).toBe("no-store");
    expect(response.data).toEqual(directory);
    expect(mocks.createAuthenticatedClient).toHaveBeenCalledWith(
      "better-auth.session_token=session-value",
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ department: "department-a" });
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
