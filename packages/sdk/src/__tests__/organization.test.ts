import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrganizationCommandConflictError,
  OrganizationDecodeSdkError,
  OrganizationInvalidReferenceError,
  OrganizationPersistenceSdkError,
  OrganizationRequestBodyTooLargeError,
  OrganizationRoleDeniedError,
  OrganizationUnauthenticatedActorError,
  createClient,
} from "../promise.js";
import {
  CreateDepartmentCommandSchema,
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  TeamJsonSchema,
} from "../schemas/organization.js";

const department = Schema.decodeUnknownSync(DepartmentJsonSchema)({
  departmentId: "department-1",
  name: "Vektorprogrammet Trondheim",
  shortName: "Trondheim",
  email: "trondheim@example.invalid",
  address: "Høgskoleringen 1",
  city: "Trondheim",
  latitude: "63.4195",
  longitude: "10.4021",
  slackChannel: null,
  logoPath: null,
  active: true,
  revision: 0,
});
const team = Schema.decodeUnknownSync(TeamJsonSchema)({
  teamId: "team-1",
  departmentId: department.departmentId,
  name: "Rekruttering",
  email: null,
  description: "Rekrutterer studenter",
  shortDescription: null,
  acceptApplication: true,
  deadline: null,
  active: true,
  revision: 0,
});
const fieldOfStudy = Schema.decodeUnknownSync(FieldOfStudyJsonSchema)({
  fieldOfStudyId: "field-1",
  name: "Datateknologi",
  shortName: "Data",
  departmentId: null,
  active: true,
  revision: 0,
});

const createDepartmentCommand = Schema.decodeUnknownSync(CreateDepartmentCommandSchema)({
  _tag: "CreateDepartment",
  commandId: "command-department",
  name: department.name,
  shortName: department.shortName,
  email: department.email,
  address: department.address,
  city: department.city,
  latitude: department.latitude,
  longitude: department.longitude,
});
const createTeamCommand = Schema.decodeUnknownSync(CreateTeamCommandSchema)({
  _tag: "CreateTeam",
  commandId: "command-team",
  departmentId: department.departmentId,
  name: team.name,
  email: team.email,
  description: team.description,
  shortDescription: team.shortDescription,
  acceptApplication: team.acceptApplication,
  deadline: team.deadline,
  active: team.active,
});
const createFieldOfStudyCommand = Schema.decodeUnknownSync(CreateFieldOfStudyCommandSchema)({
  _tag: "CreateFieldOfStudy",
  commandId: "command-field",
  name: fieldOfStudy.name,
  shortName: fieldOfStudy.shortName,
  departmentId: fieldOfStudy.departmentId,
});

const departmentResult = {
  committed: true,
  observation: {
    _tag: "DepartmentCreated",
    commandId: createDepartmentCommand.commandId,
    department,
  },
} as const;
const teamResult = {
  committed: true,
  observation: {
    _tag: "TeamCreated",
    commandId: createTeamCommand.commandId,
    team,
  },
} as const;
const fieldOfStudyResult = {
  committed: true,
  observation: {
    _tag: "FieldOfStudyCreated",
    commandId: createFieldOfStudyCommand.commandId,
    fieldOfStudy,
  },
} as const;
const replayResult = {
  committed: false,
  observation: {
    _tag: "Replayed",
    commandId: createDepartmentCommand.commandId,
    original: departmentResult.observation,
  },
} as const;

const response = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    json: () => Promise.resolve(body),
  }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe("Organization SDK wire schemas", () => {
  it("keeps stable identifiers and exact canonical JSON fields", () => {
    expect(typeof department.departmentId).toBe("string");
    expect(typeof team.teamId).toBe("string");
    expect(typeof fieldOfStudy.fieldOfStudyId).toBe("string");
    expect(Object.keys(department).sort()).toEqual([
      "active",
      "address",
      "city",
      "departmentId",
      "email",
      "latitude",
      "logoPath",
      "longitude",
      "name",
      "revision",
      "shortName",
      "slackChannel",
    ]);
  });

  it("rejects excess command, generated fields, and malformed references", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateDepartmentCommandSchema)(
        { ...createDepartmentCommand, departmentId: "caller-selected" },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateTeamCommandSchema)(
        { ...createTeamCommand, departmentId: 1 },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateFieldOfStudyCommandSchema)(
        { ...createFieldOfStudyCommand, revision: 0 },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});

describe("Organization SDK transport", () => {
  it("uses exactly the three public and three administrator native operations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, [department]))
      .mockResolvedValueOnce(response(200, [team]))
      .mockResolvedValueOnce(response(200, [fieldOfStudy]))
      .mockResolvedValueOnce(response(201, departmentResult))
      .mockResolvedValueOnce(response(201, teamResult))
      .mockResolvedValueOnce(response(201, fieldOfStudyResult));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });

    await expect(client.public.organization.listDepartments()).resolves.toEqual([department]);
    await expect(client.public.organization.listTeams()).resolves.toEqual([team]);
    await expect(client.public.organization.listFieldOfStudies()).resolves.toEqual([fieldOfStudy]);
    await expect(
      client.admin.organization.createDepartment(createDepartmentCommand),
    ).resolves.toEqual(departmentResult);
    await expect(client.admin.organization.createTeam(createTeamCommand)).resolves.toEqual(
      teamResult,
    );
    await expect(
      client.admin.organization.createFieldOfStudy(createFieldOfStudyCommand),
    ).resolves.toEqual(fieldOfStudyResult);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/departments",
      "http://api.test/api/teams",
      "http://api.test/api/field_of_studies",
      "http://api.test/api/admin/departments",
      "http://api.test/api/admin/teams",
      "http://api.test/api/admin/field-of-studies",
    ]);
    for (const call of fetchMock.mock.calls.slice(0, 3)) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).Cookie).toBeUndefined();
    }
    for (const [index, command] of [
      createDepartmentCommand,
      createTeamCommand,
      createFieldOfStudyCommand,
    ].entries()) {
      const init = fetchMock.mock.calls[index + 3]?.[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual(command);
      expect((init.headers as Record<string, string>).Cookie).toBe(
        "better-auth.session_token=admin-session",
      );
    }
  });

  it("accepts a strict replay and rejects excess or unexpected successful responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, replayResult))
      .mockResolvedValueOnce(response(200, [{ ...department, receipt: "private" }]))
      .mockResolvedValueOnce(response(202, departmentResult));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });

    await expect(
      client.admin.organization.createDepartment(createDepartmentCommand),
    ).resolves.toEqual(replayResult);
    await expect(client.public.organization.listDepartments()).rejects.toBeInstanceOf(
      OrganizationDecodeSdkError,
    );
    await expect(
      client.admin.organization.createDepartment(createDepartmentCommand),
    ).rejects.toBeInstanceOf(OrganizationDecodeSdkError);
  });

  it("rejects excess request properties before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });

    await expect(
      client.admin.organization.createDepartment({
        ...createDepartmentCommand,
        actorRole: "OrganizationAdministrator",
      } as never),
    ).rejects.toBeInstanceOf(OrganizationDecodeSdkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps every native Organization failure without trusting response text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, { error: { tag: "UnauthenticatedActor" } }))
      .mockResolvedValueOnce(response(403, { error: { tag: "OrganizationRoleDenied" } }))
      .mockResolvedValueOnce(response(422, { error: { tag: "OrganizationInvalidReference" } }))
      .mockResolvedValueOnce(response(409, { error: { tag: "OrganizationCommandConflict" } }))
      .mockResolvedValueOnce(response(422, { error: { tag: "OrganizationDecodeError" } }))
      .mockResolvedValueOnce(response(413, { error: { tag: "RequestBodyTooLarge" } }))
      .mockResolvedValueOnce(response(503, { error: { tag: "OrganizationPersistenceError" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=admin-session",
    });
    const create = () => client.admin.organization.createDepartment(createDepartmentCommand);

    await expect(create()).rejects.toBeInstanceOf(OrganizationUnauthenticatedActorError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationRoleDeniedError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationInvalidReferenceError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationCommandConflictError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationDecodeSdkError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationRequestBodyTooLargeError);
    await expect(create()).rejects.toBeInstanceOf(OrganizationPersistenceSdkError);
  });

  it("removes numeric Hydra Organization methods instead of keeping compatibility paths", () => {
    const client = createClient("http://api.test");
    expect(Object.keys(client.public.organization).sort()).toEqual([
      "listDepartments",
      "listFieldOfStudies",
      "listTeams",
    ]);
    expect(Object.keys(client.admin.organization).sort()).toEqual([
      "createDepartment",
      "createFieldOfStudy",
      "createTeam",
    ]);
    expect("departments" in client.public).toBe(false);
    expect("fieldOfStudies" in client.public).toBe(false);
    expect("teams" in client.public).toBe(false);
    expect("list" in client.admin.teams).toBe(false);
  });
});
