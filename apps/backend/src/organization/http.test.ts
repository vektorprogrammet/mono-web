import {
  CreateDepartmentResultSchema,
  CreateFieldOfStudyResultSchema,
  CreateTeamResultSchema,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  Organization,
  PersonId,
  TeamJsonSchema,
  type OrganizationShape,
} from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { BackendRun } from "../router.js";
import { makeOrganizationApiConfig } from "./config.js";
import { makeOrganizationTestHttp as makeOrganizationApiHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

const ADMIN_SESSION = "organization-admin-session";
const MEMBER_SESSION = "organization-member-session";

const config = makeOrganizationApiConfig({
  ORGANIZATION_MAX_BODY_BYTES: "1024",
});

const department = Schema.decodeUnknownSync(DepartmentJsonSchema)(
  {
    departmentId: "department-created",
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
  },
  { onExcessProperty: "error" },
);

const team = Schema.decodeUnknownSync(TeamJsonSchema)(
  {
    teamId: "team-created",
    departmentId: department.departmentId,
    name: "Rekruttering",
    email: null,
    description: "Rekrutterer studenter",
    shortDescription: null,
    acceptApplication: true,
    deadline: null,
    active: true,
    revision: 0,
  },
  { onExcessProperty: "error" },
);

const fieldOfStudy = Schema.decodeUnknownSync(FieldOfStudyJsonSchema)(
  {
    fieldOfStudyId: "field-created",
    name: "Datateknologi",
    shortName: "Data",
    departmentId: null,
    active: true,
    revision: 0,
  },
  { onExcessProperty: "error" },
);

const createDepartmentCommand = {
  _tag: "CreateDepartment",
  commandId: "command-department",
  name: department.name,
  shortName: department.shortName,
  email: department.email,
  address: department.address,
  city: department.city,
  latitude: department.latitude,
  longitude: department.longitude,
} as const;

const createTeamCommand = {
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
} as const;

const createFieldOfStudyCommand = {
  _tag: "CreateFieldOfStudy",
  commandId: "command-field",
  name: fieldOfStudy.name,
  shortName: fieldOfStudy.shortName,
  departmentId: fieldOfStudy.departmentId,
} as const;

const departmentResult = (commandId: string, committed: boolean) =>
  Schema.decodeUnknownSync(CreateDepartmentResultSchema)(
    committed
      ? {
          committed: true,
          observation: { _tag: "DepartmentCreated", commandId, department },
        }
      : {
          committed: false,
          observation: {
            _tag: "Replayed",
            commandId,
            original: { _tag: "DepartmentCreated", commandId, department },
          },
        },
    { onExcessProperty: "error" },
  );

let publicListCalls = 0;
let createCalls = 0;
const organization = {
  listDepartments: Effect.sync(() => {
    publicListCalls += 1;
    return [department];
  }),
  listTeams: () => Effect.succeed([team]),
  listFieldOfStudies: Effect.succeed([fieldOfStudy]),
  createDepartment: (command: { readonly commandId: string }, actor: { readonly _tag: string }) => {
    createCalls += 1;
    if (actor._tag === "OrganizationMember") {
      return Effect.fail({ _tag: "OrganizationRoleDenied" } as never);
    }
    if (command.commandId === "command-conflict") {
      return Effect.fail({ _tag: "OrganizationCommandConflict" } as never);
    }
    if (command.commandId === "command-persistence") {
      return Effect.fail({ _tag: "OrganizationPersistenceError" } as never);
    }
    return Effect.succeed(
      departmentResult(command.commandId, command.commandId !== "command-replay"),
    );
  },
  createTeam: (command: typeof createTeamCommand) => {
    createCalls += 1;
    if (command.departmentId === "department-unknown") {
      return Effect.fail({ _tag: "OrganizationInvalidReference" } as never);
    }
    return Effect.succeed(
      Schema.decodeUnknownSync(CreateTeamResultSchema)(
        {
          committed: true,
          observation: { _tag: "TeamCreated", commandId: command.commandId, team },
        },
        { onExcessProperty: "error" },
      ),
    );
  },
  createFieldOfStudy: (command: typeof createFieldOfStudyCommand) =>
    Effect.succeed(
      Schema.decodeUnknownSync(CreateFieldOfStudyResultSchema)(
        {
          committed: true,
          observation: {
            _tag: "FieldOfStudyCreated",
            commandId: command.commandId,
            fieldOfStudy,
          },
        },
        { onExcessProperty: "error" },
      ),
    ),
} as unknown as OrganizationShape;

const run = (<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runTestPromise(
    effect.pipe(Effect.provideService(Organization, organization)) as Effect.Effect<A, E>,
  )) as BackendRun;

const http = makeOrganizationApiHttp({
  config,
  resolveActor: async (request) => {
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader === null) {
      throw Object.assign(new Error("UnauthenticatedActor"), { _tag: "UnauthenticatedActor" });
    }
    if (cookieHeader.includes(`better-auth.session_token=${ADMIN_SESSION}`)) {
      return { _tag: "OrganizationAdministrator", personId: PersonId.make("person-admin") };
    }
    return { _tag: "OrganizationMember", personId: PersonId.make("person-member") };
  },
  resolveAuthority: async () => ({
    personId: PersonId.make("person-admin"),
    evaluatedAt: "2031-09-15T12:00:00.000Z",
    globalAdministrator: "Active",
    memberships: [],
  }),
  run,
});
const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  http.fetch(new Request(`http://backend.test${pathname}`, init));
const post = (
  pathname: string,
  session: string,
  body: unknown,
  contentType = "application/json",
): Promise<Response> =>
  request(pathname, {
    method: "POST",
    headers: {
      cookie: `better-auth.session_token=${session}`,
      "content-type": contentType,
      origin: "http://127.0.0.1:5174",
    },
    body: JSON.stringify(body),
  });

const responseBody = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

describe("Organization HTTP boundary", () => {
  it("returns only canonical Organization JSON projections from all public routes", async () => {
    const [departments, teams, fields] = await Promise.all([
      request("/api/departments"),
      request("/api/teams"),
      request("/api/field_of_studies"),
    ]);

    expect(await responseBody(departments)).toEqual({ status: 200, body: [department] });
    expect(await responseBody(teams)).toEqual({ status: 200, body: [team] });
    expect(await responseBody(fields)).toEqual({ status: 200, body: [fieldOfStudy] });
    const serialized = JSON.stringify([
      await request("/api/departments").then((response) => response.json()),
      await request("/api/teams").then((response) => response.json()),
      await request("/api/field_of_studies").then((response) => response.json()),
    ]);
    for (const forbidden of ["personId", "membership", "commandId", "audit", "actorsByToken"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns 201 for a committed command and 200 with the original observation for replay", async () => {
    const created = await post("/api/admin/departments", ADMIN_SESSION, createDepartmentCommand);
    const createdTeam = await post("/api/admin/teams", ADMIN_SESSION, createTeamCommand);
    const createdField = await post(
      "/api/admin/field-of-studies",
      ADMIN_SESSION,
      createFieldOfStudyCommand,
    );
    const replayed = await post("/api/admin/departments", ADMIN_SESSION, {
      ...createDepartmentCommand,
      commandId: "command-replay",
    });

    expect(await responseBody(created)).toEqual({
      status: 201,
      body: departmentResult(createDepartmentCommand.commandId, true),
    });
    expect(await responseBody(createdTeam)).toMatchObject({
      status: 201,
      body: { committed: true, observation: { _tag: "TeamCreated" } },
    });
    expect(await responseBody(createdField)).toMatchObject({
      status: 201,
      body: { committed: true, observation: { _tag: "FieldOfStudyCreated" } },
    });
    expect(await responseBody(replayed)).toEqual({
      status: 200,
      body: departmentResult("command-replay", false),
    });
  });

  it("maps member denial, invalid references, command conflict, and persistence failure", async () => {
    const denied = await post("/api/admin/departments", MEMBER_SESSION, createDepartmentCommand);
    const invalidReference = await post("/api/admin/teams", ADMIN_SESSION, {
      ...createTeamCommand,
      departmentId: "department-unknown",
    });
    const conflict = await post("/api/admin/departments", ADMIN_SESSION, {
      ...createDepartmentCommand,
      commandId: "command-conflict",
    });
    const unavailable = await post("/api/admin/departments", ADMIN_SESSION, {
      ...createDepartmentCommand,
      commandId: "command-persistence",
    });

    expect(await responseBody(denied)).toEqual({
      status: 403,
      body: { error: { tag: "OrganizationRoleDenied" } },
    });
    expect(await responseBody(invalidReference)).toEqual({
      status: 422,
      body: { error: { tag: "OrganizationInvalidReference" } },
    });
    expect(await responseBody(conflict)).toEqual({
      status: 409,
      body: { error: { tag: "OrganizationCommandConflict" } },
    });
    expect(await responseBody(unavailable)).toEqual({
      status: 503,
      body: { error: { tag: "OrganizationPersistenceError" } },
    });
  });

  it("rejects malformed JSON, wrong content type, excess fields, and oversized bodies", async () => {
    const before = createCalls;
    const malformed = await request("/api/admin/departments", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${ADMIN_SESSION}`,
        "content-type": "application/json",
        origin: "http://127.0.0.1:5174",
      },
      body: "{",
    });
    const wrongContentType = await post(
      "/api/admin/departments",
      ADMIN_SESSION,
      createDepartmentCommand,
      "text/plain",
    );
    const excess = await post("/api/admin/departments", ADMIN_SESSION, {
      ...createDepartmentCommand,
      actorRole: "OrganizationAdministrator",
    });
    const oversized = await post("/api/admin/departments", ADMIN_SESSION, {
      ...createDepartmentCommand,
      name: "x".repeat(2_000),
    });

    expect(malformed.status).toBe(422);
    expect(wrongContentType.status).toBe(422);
    expect(excess.status).toBe(422);
    expect(oversized.status).toBe(413);
    expect(createCalls).toBe(before);
  });

  it("rejects public query strings before reading Organization and uses exact credentialed preflight origins", async () => {
    const before = publicListCalls;
    const queried = await request("/api/departments?active=true");
    const preflight = await request("/api/departments", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5174",
        "access-control-request-method": "GET",
      },
    });

    expect(await responseBody(queried)).toEqual({
      status: 422,
      body: { error: { tag: "OrganizationDecodeError" } },
    });
    expect(publicListCalls).toBe(before);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5174");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("fails closed for an unauthenticated request", async () => {
    const anonymous = await request("/api/admin/departments", { method: "POST" });
    expect(await responseBody(anonymous)).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
  });
});
