import { IdentitySnapshot } from "@vektorprogrammet/database";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
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
import { DateTime, Effect, Schema } from "effect";
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

const createDepartmentRequest = {
  name: department.name,
  shortName: department.shortName,
  email: department.email,
  address: department.address,
  city: department.city,
  latitude: department.latitude,
  longitude: department.longitude,
} as const;

const createTeamRequest = {
  departmentId: department.departmentId,
  name: team.name,
  email: team.email,
  description: team.description,
  shortDescription: team.shortDescription,
  acceptApplication: team.acceptApplication,
  deadline: team.deadline,
  active: team.active,
} as const;

const createFieldOfStudyRequest = {
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
  resolvePersonAuthority: (personId: PersonId, evaluatedAt: string) =>
    Effect.succeed({
      personId,
      evaluatedAt,
      globalAdministrator: personId === "person-admin" ? "Active" : "Absent",
      memberships: [],
    }),
  createDepartment: (
    command: Parameters<OrganizationShape["createDepartment"]>[0],
    actor: Parameters<OrganizationShape["createDepartment"]>[1],
  ) => {
    createCalls += 1;
    if (actor._tag === "OrganizationMember") {
      return Effect.fail({ _tag: "OrganizationRoleDenied" } as never);
    }
    if (command.name === "Conflict") {
      return Effect.fail({ _tag: "OrganizationCommandConflict" } as never);
    }
    if (command.name === "Unavailable") {
      return Effect.fail({ _tag: "OrganizationPersistenceError" } as never);
    }
    return Effect.succeed(departmentResult(command.commandId, true));
  },
  createTeam: (command: Parameters<OrganizationShape["createTeam"]>[0]) => {
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
  createFieldOfStudy: (command: Parameters<OrganizationShape["createFieldOfStudy"]>[0]) =>
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
type NativeReceiptRow = {
  readonly requestSha256: string;
  readonly operationId: string;
  readonly state: "Complete";
  readonly status: number;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array | null;
  readonly headers: unknown;
};

const nativeReceipts = new Map<string, NativeReceiptRow>();
const database = Object.assign(
  ((strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
    const statement = strings.join(" ");
    if (statement.includes("SET TRANSACTION ISOLATION LEVEL")) return Effect.void;
    if (statement.includes("SELECT pg_try_advisory_xact_lock")) {
      return Effect.succeed([{ acquired: true }]);
    }
    if (statement.includes("UPDATE public.native_http_idempotency_receipts")) {
      return Effect.succeed([]);
    }
    if (statement.includes("FROM public.native_http_idempotency_receipts")) {
      const stored = nativeReceipts.get(String(values[0]));
      return Effect.succeed(stored === undefined ? [] : [stored]);
    }
    if (statement.includes("INSERT INTO public.native_http_idempotency_receipts")) {
      nativeReceipts.set(String(values[0]), {
        requestSha256: String(values[1]),
        operationId: String(values[2]),
        state: "Complete",
        status: Number(values[3]),
        mediaType: values[4] as string | null,
        bodyBytes: values[5] as Uint8Array | null,
        headers: values[6],
      });
    }
    return Effect.succeed([]);
  }) as unknown as DatabaseShape,
  {
    health: Effect.void,
    json: (value: unknown) => value,
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  },
);

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookieHeader) =>
    Effect.suspend(() => {
      const personId = cookieHeader?.includes(ADMIN_SESSION)
        ? PersonId.make("person-admin")
        : cookieHeader?.includes(MEMBER_SESSION)
          ? PersonId.make("person-member")
          : undefined;
      return personId === undefined
        ? Effect.fail(new IdentitySessionNotFound())
        : Effect.succeed(
            new IdentityActor({
              personId,
              sessionId: "organization-http-session",
              expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
            }),
          );
    }),
  revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
  revokeSession: () => Effect.succeed({ setCookies: [] }),
  revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
  revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
});

const run = (<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runTestPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(IdentitySnapshot, identitySnapshot),
      Effect.provideService(Organization, organization),
    ) as Effect.Effect<A, E>,
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
  idempotencyKey: string,
  contentType = "application/json",
): Promise<Response> =>
  request(pathname, {
    method: "POST",
    headers: {
      cookie: `better-auth.session_token=${session}`,
      "content-type": contentType,
      "idempotency-key": idempotencyKey,
      origin: "http://127.0.0.1:5174",
    },
    body: JSON.stringify(body),
  });

const responseBody = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});
const expectedProblem = (code: string, title: string, status: number, detail: string) => ({
  type: `urn:vektorprogrammet:problem:v0.2:${code}`,
  title,
  status,
  detail,
  code,
});

describe("Organization HTTP boundary", () => {
  it("returns only canonical Organization JSON projections from all public routes", async () => {
    const [departments, teams, fields] = await Promise.all([
      request("/api/departments"),
      request("/api/teams"),
      request("/api/field-of-studies"),
    ]);

    expect(await responseBody(departments)).toEqual({ status: 200, body: [department] });
    expect(await responseBody(teams)).toEqual({ status: 200, body: [team] });
    expect(await responseBody(fields)).toEqual({ status: 200, body: [fieldOfStudy] });
    const serialized = JSON.stringify([
      await request("/api/departments").then((response) => response.json()),
      await request("/api/teams").then((response) => response.json()),
      await request("/api/field-of-studies").then((response) => response.json()),
    ]);
    for (const forbidden of ["personId", "membership", "commandId", "audit", "actorsByToken"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns canonical resources for committed and replayed generated operations", async () => {
    const departmentKey = "department-create-key-0001";
    const created = await post(
      "/api/departments",
      ADMIN_SESSION,
      createDepartmentRequest,
      departmentKey,
    );
    const createdTeam = await post(
      "/api/teams",
      ADMIN_SESSION,
      createTeamRequest,
      "team-create-key-00000001",
    );
    const createdField = await post(
      "/api/field-of-studies",
      ADMIN_SESSION,
      createFieldOfStudyRequest,
      "field-create-key-0000001",
    );
    const replayed = await post(
      "/api/departments",
      ADMIN_SESSION,
      createDepartmentRequest,
      departmentKey,
    );

    expect(await responseBody(created)).toEqual({ status: 201, body: department });
    expect(created.headers.get("location")).toBe("/api/departments/department-created");
    expect(created.headers.get("etag")).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(await responseBody(createdTeam)).toEqual({ status: 201, body: team });
    expect(await responseBody(createdField)).toEqual({ status: 201, body: fieldOfStudy });
    expect(await responseBody(replayed)).toEqual({ status: 201, body: department });
  });

  it("maps authority, reference, conflict, and dependency failures to RFC 9457", async () => {
    const denied = await post(
      "/api/departments",
      MEMBER_SESSION,
      createDepartmentRequest,
      "department-denied-key-0001",
    );
    const invalidReference = await post(
      "/api/teams",
      ADMIN_SESSION,
      { ...createTeamRequest, departmentId: "department-unknown" },
      "team-invalid-ref-key-00001",
    );
    const conflict = await post(
      "/api/departments",
      ADMIN_SESSION,
      { ...createDepartmentRequest, name: "Conflict" },
      "department-conflict-key-01",
    );
    const unavailable = await post(
      "/api/departments",
      ADMIN_SESSION,
      { ...createDepartmentRequest, name: "Unavailable" },
      "department-unavailable-001",
    );

    expect(await responseBody(denied)).toEqual({
      status: 403,
      body: expectedProblem(
        "authority.denied",
        "Authority denied",
        403,
        "The authenticated principal is not permitted to perform this operation.",
      ),
    });
    expect(await responseBody(invalidReference)).toEqual({
      status: 422,
      body: expectedProblem(
        "organization.invalid-reference",
        "Invalid organization reference",
        422,
        "An organization reference is invalid.",
      ),
    });
    expect(await responseBody(conflict)).toEqual({
      status: 409,
      body: expectedProblem(
        "idempotency.digest-conflict",
        "Idempotency conflict",
        409,
        "This idempotency key identifies a different semantic request.",
      ),
    });
    expect(await responseBody(unavailable)).toEqual({
      status: 503,
      body: expectedProblem(
        "organization.unavailable",
        "Organization unavailable",
        503,
        "The organization service is temporarily unavailable.",
      ),
    });
  });

  it("rejects malformed JSON, wrong content type, excess fields, and oversized bodies", async () => {
    const before = createCalls;
    const malformed = await request("/api/departments", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${ADMIN_SESSION}`,
        "content-type": "application/json",
        "idempotency-key": "department-malformed-key-01",
        origin: "http://127.0.0.1:5174",
      },
      body: "{",
    });
    const wrongContentType = await post(
      "/api/departments",
      ADMIN_SESSION,
      createDepartmentRequest,
      "department-media-key-0001",
      "text/plain",
    );
    const excess = await post(
      "/api/departments",
      ADMIN_SESSION,
      { ...createDepartmentRequest, actorRole: "OrganizationAdministrator" },
      "department-excess-key-001",
    );
    const oversized = await post(
      "/api/departments",
      ADMIN_SESSION,
      { ...createDepartmentRequest, name: "x".repeat(2_000) },
      "department-oversize-key-01",
    );

    for (const response of [malformed, wrongContentType, excess]) {
      expect(await responseBody(response)).toEqual({
        status: 422,
        body: expectedProblem(
          "validation.failed",
          "Validation failed",
          422,
          "The request contains invalid semantic values.",
        ),
      });
    }
    expect(await responseBody(oversized)).toEqual({
      status: 413,
      body: expectedProblem(
        "request.too-large",
        "Request too large",
        413,
        "The request body exceeds the permitted size.",
      ),
    });
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
      body: expectedProblem(
        "validation.failed",
        "Validation failed",
        422,
        "The request contains invalid semantic values.",
      ),
    });
    expect(publicListCalls).toBe(before);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5174");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("fails closed with an RFC 9457 credential problem", async () => {
    const anonymous = await request("/api/departments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "anonymous-department-key-01",
      },
      body: JSON.stringify(createDepartmentRequest),
    });
    expect(await responseBody(anonymous)).toEqual({
      status: 401,
      body: expectedProblem(
        "credential.invalid",
        "Invalid credential",
        401,
        "The supplied credential is invalid.",
      ),
    });
  });
});
