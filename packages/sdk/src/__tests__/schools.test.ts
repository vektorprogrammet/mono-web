import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DepartmentId,
  SchoolDirectorySchema,
  SchoolsRejectionError,
  createClient,
} from "../promise.js";

const directory = {
  activeSchools: [
    {
      schoolId: 1,
      name: "Alpha School",
      contactPerson: "Ada Lovelace",
      email: "alpha@example.invalid",
      phone: "+47 900 00 001",
      language: "Norwegian",
      departments: [
        { departmentId: "department-a", name: "Department A" },
        { departmentId: "department-b", name: "Department B" },
      ],
      isActive: true,
    },
  ],
  inactiveSchools: [
    {
      schoolId: 2,
      name: "Beta School",
      contactPerson: "Grace Hopper",
      email: "beta@example.invalid",
      phone: "+47 900 00 002",
      language: "International",
      departments: [{ departmentId: "department-b", name: "Department B" }],
      isActive: false,
    },
  ],
} as const;

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("Schools SDK wire contract", () => {
  it("strictly decodes the canonical fields and directory partition", () => {
    expect(
      Schema.decodeUnknownSync(SchoolDirectorySchema)(directory, {
        onExcessProperty: "error",
      }),
    ).toEqual(directory);
    expect(() =>
      Schema.decodeUnknownSync(SchoolDirectorySchema)(
        {
          ...directory,
          activeSchools: [{ ...directory.activeSchools[0], legacyCapacity: 3 }],
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SchoolDirectorySchema)({
        ...directory,
        activeSchools: [{ ...directory.activeSchools[0], isActive: false }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SchoolDirectorySchema)({
        ...directory,
        activeSchools: [
          {
            ...directory.activeSchools[0],
            departments: [...directory.activeSchools[0].departments].reverse(),
          },
        ],
      }),
    ).toThrow();
  });

  it("strictly round-trips a canonical 256-character DepartmentId through list input and response", async () => {
    const department = DepartmentId.make("d".repeat(256));
    const directoryWithLongDepartment = {
      activeSchools: directory.activeSchools.map((school) => ({
        ...school,
        departments: [{ departmentId: department, name: "Long Department" }],
      })),
      inactiveSchools: directory.inactiveSchools.map((school) => ({
        ...school,
        departments: [{ departmentId: department, name: "Long Department" }],
      })),
    };
    const observed: Array<{ url: string; cookie: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observed.push({
        url: String(input),
        cookie: new Headers(init?.headers).get("Cookie"),
      });
      return response(200, directoryWithLongDepartment);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });

    const result = await client.admin.schools.list({ department });

    expect(department).toHaveLength(256);
    expect(Schema.encodeSync(SchoolDirectorySchema)(result)).toEqual(directoryWithLongDepartment);
    expect(observed).toEqual([
      {
        url: `http://api.test/api/admin/schools?department=${department}`,
        cookie: "better-auth.session_token=admin-session",
      },
    ]);
  });

  it("rejects excess and Hydra success bodies and preserves typed failure tags", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          ...directory,
          activeSchools: [{ ...directory.activeSchools[0], capacity: 4 }],
        }),
      )
      .mockResolvedValueOnce(response(200, { "hydra:member": directory.activeSchools }))
      .mockResolvedValueOnce(response(403, { error: { tag: "SchoolsDepartmentOutOfScope" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });

    for (let index = 0; index < 2; index += 1) {
      await expect(client.admin.schools.list()).rejects.toMatchObject({
        name: "SchoolsRejectionError",
        schoolsTag: "SchoolsDecodeError",
      });
    }
    await expect(client.admin.schools.list()).rejects.toEqual(
      new SchoolsRejectionError("SchoolsDepartmentOutOfScope"),
    );
  });
});
