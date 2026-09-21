import { Database, OAuthCredentialAuthority, type DatabaseShape } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  DepartmentNotFound,
  MembershipId,
  Organization,
  OrganizationAuthorityInstantSchema,
  PersonId,
  TeamId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  SchoolId,
  Schools,
  SchoolsDecodeError,
  SchoolsPersistenceError,
  type SchoolDirectory,
  type SchoolDirectoryListInput,
} from "@vektorprogrammet/domain/schools";
import { DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeSchoolsTestHttp as makeSchoolsApiHttp } from "../test/native-http.js";

const personId = PersonId.make("schools-http-person");
const sessionRequest = (url: string): Request =>
  new Request(url, {
    headers: { cookie: "better-auth.session_token=schools-test-session" },
  });
const departmentA = DepartmentId.make("schools-http-a");
const departmentB = DepartmentId.make("schools-http-b");
const instant = OrganizationAuthorityInstantSchema.make("2032-04-01T12:00:00.000Z");
const emptyDirectory: SchoolDirectory = { activeSchools: [], inactiveSchools: [] };

const projection = (
  overrides: Partial<OrganizationPersonAuthority> = {},
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: instant,
  globalAdministrator: "Absent",
  memberships: [
    {
      membershipId: MembershipId.make("schools-http-membership"),
      teamId: TeamId.make("schools-http-team"),
      departmentId: departmentA,
      active: true,
      teamLeader: false,
    },
  ],
  ...overrides,
});

const makeDatabase = (): DatabaseShape => {
  const sql = (() => Effect.succeed([])) as unknown as DatabaseShape;
  Object.assign(sql, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  });
  return sql;
};

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
} as never);
const identity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookieHeader: string | undefined) => {
    if (cookieHeader?.includes("schools-test-session")) {
      return new IdentityActor({
        personId,
        sessionId: "schools-test-session",
        expiresAt: DateTime.makeUnsafe(new Date("2032-04-02T12:00:00.000Z")),
      });
    }
    throw new IdentitySessionNotFound();
  },
  readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
  listSessions: () => Promise.reject(new Error("unexpected session list")),
  revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
  revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
  recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
  signOut: async () => ({ setCookies: [] }),
} satisfies IdentityShape);
const makeServices = (
  authority: OrganizationPersonAuthority,
  listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsDecodeError | SchoolsPersistenceError>,
  readDepartment: (departmentId: DepartmentId) => Effect.Effect<unknown, DepartmentNotFound> = (
    departmentId,
  ) => Effect.succeed({ departmentId }),
) => {
  const organization = Organization.of({
    resolvePersonAuthorityForRead: () => Effect.succeed(authority),
    readDepartment,
  } as never);
  const schools = Schools.of({ listDirectory });
  return Layer.mergeAll(
    Layer.succeed(Database, makeDatabase()),
    Layer.succeed(Organization, organization),
    Layer.succeed(Schools, schools),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  );
};

const responseBody = (response: Response): Promise<unknown> => response.json();
const expectedProblem = (code: string, title: string, status: number, detail: string) => ({
  type: `urn:vektorprogrammet:problem:v0.2:${code}`,
  title,
  status,
  detail,
  code,
});
const expectedProblemForTag = (tag: string, status: number) => {
  if (tag === "UnauthenticatedActor") {
    return expectedProblem(
      "credential.invalid",
      "Invalid credential",
      status,
      "The supplied credential is invalid.",
    );
  }
  if (tag === "SchoolsDepartmentNotFound" && status === 422) {
    return expectedProblem(
      "schools.invalid-department",
      "Invalid school department",
      status,
      "The requested department is not valid for the school directory.",
    );
  }
  if (status === 403) {
    return expectedProblem(
      "authority.denied",
      "Authority denied",
      status,
      "The authenticated principal is not permitted to perform this operation.",
    );
  }
  return expectedProblem(
    "schools.unavailable",
    "Schools unavailable",
    status,
    "The school directory is temporarily unavailable.",
  );
};

describe("Schools native HTTP adapter", () => {
  it("runs the named journey once and narrows the visible union by department", async () => {
    const listInputs: Array<SchoolDirectoryListInput> = [];
    const school: SchoolDirectory = {
      activeSchools: [
        {
          schoolId: SchoolId.make(1),
          name: "Journey School",
          contactPerson: "Journey Contact",
          email: "journey@example.invalid",
          phone: "+47 900 00 000",
          language: "Norwegian",
          departments: [{ departmentId: departmentA, name: "Department A" }],
          isActive: true,
        },
      ],
      inactiveSchools: [],
    };
    const services = makeServices(projection(), (input) => {
      listInputs.push(input);
      return Effect.succeed(school);
    });
    const api = makeSchoolsApiHttp(
      { resolveActor: () => Effect.succeed({ personId, authorizationInstant: instant }) },
      services,
    );

    const response = await api.fetch(
      sessionRequest(`http://backend.test/api/schools?department=${departmentA}`),
    );

    expect({ status: response.status, body: await responseBody(response) }).toEqual({
      status: 200,
      body: school,
    });
    expect(listInputs).toEqual([
      { scope: { _tag: "DepartmentIds", departmentIds: [departmentA] }, departmentId: departmentA },
    ]);
  });

  it("rejects unknown, duplicate, and malformed query input before authentication", async () => {
    let actorCalls = 0;
    let listCalls = 0;
    const services = makeServices(projection(), () => {
      listCalls += 1;
      return Effect.succeed(emptyDirectory);
    });
    const api = makeSchoolsApiHttp(
      {
        resolveActor: () =>
          Effect.sync(() => {
            actorCalls += 1;
            return { personId, authorizationInstant: instant };
          }),
      },
      services,
    );

    for (const [query, expected] of [
      [
        "unknown=1",
        expectedProblem(
          "schools.unavailable",
          "Schools unavailable",
          503,
          "The school directory is temporarily unavailable.",
        ),
      ],
      [
        "department=a&department=b",
        expectedProblem("request.malformed", "Malformed request", 400, "The request is malformed."),
      ],
      [
        "department=",
        expectedProblem("request.malformed", "Malformed request", 400, "The request is malformed."),
      ],
    ] as const) {
      const response = await api.fetch(sessionRequest(`http://backend.test/api/schools?${query}`));
      expect({ status: response.status, body: await responseBody(response) }, query).toEqual({
        status: expected.status,
        body: expected,
      });
    }
    expect(actorCalls).toBe(0);
    expect(listCalls).toBe(0);
  });

  it("maps authentication, authority, reference, scope, and persistence failures exactly", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly expectedStatus: number;
      readonly expectedTag: string;
      readonly authority?: OrganizationPersonAuthority;
      readonly query?: string;
      readonly resolveActor?: () => Effect.Effect<
        { personId: PersonId; authorizationInstant: typeof instant },
        UnauthenticatedActor
      >;
      readonly readDepartment?: (
        departmentId: DepartmentId,
      ) => Effect.Effect<unknown, DepartmentNotFound>;
      readonly listDirectory?: (
        input: SchoolDirectoryListInput,
      ) => Effect.Effect<SchoolDirectory, SchoolsDecodeError | SchoolsPersistenceError>;
    }> = [
      {
        name: "missing session",
        expectedStatus: 401,
        expectedTag: "UnauthenticatedActor",
        resolveActor: () =>
          Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
      },
      {
        name: "inactive authority",
        expectedStatus: 403,
        expectedTag: "AuthorityInactive",
        authority: projection({ memberships: [], globalAdministrator: "Inactive" }),
      },
      {
        name: "absent authority",
        expectedStatus: 403,
        expectedTag: "NotInScope",
        authority: projection({ memberships: [], globalAdministrator: "Absent" }),
      },
      {
        name: "unknown department",
        expectedStatus: 503,
        expectedTag: "SchoolsDepartmentNotFound",
        query: `department=${departmentB}`,
        readDepartment: (departmentId) => Effect.fail(new DepartmentNotFound({ departmentId })),
      },
      {
        name: "outside scope",
        expectedStatus: 503,
        expectedTag: "SchoolsDepartmentOutOfScope",
        query: `department=${departmentB}`,
      },
      {
        name: "persistence",
        expectedStatus: 503,
        expectedTag: "SchoolsPersistenceError",
        listDirectory: () =>
          Effect.fail(
            new SchoolsPersistenceError({
              operation: "read Schools directory",
              message: "unavailable",
            }),
          ),
      },
      {
        name: "row decode",
        expectedStatus: 503,
        expectedTag: "SchoolsDecodeError",
        listDirectory: () =>
          Effect.fail(
            new SchoolsDecodeError({
              operation: "decode Schools directory rows",
              message: "malformed row",
            }),
          ),
      },
    ];

    for (const testCase of cases) {
      const api = makeSchoolsApiHttp(
        {
          resolveActor:
            testCase.resolveActor ??
            (() => Effect.succeed({ personId, authorizationInstant: instant })),
        },
        makeServices(
          testCase.authority ?? projection(),
          testCase.listDirectory ?? (() => Effect.succeed(emptyDirectory)),
          testCase.readDepartment,
        ),
      );
      const query = testCase.query === undefined ? "" : `?${testCase.query}`;
      const response = await api.fetch(sessionRequest(`http://backend.test/api/schools?${query}`));
      expect(
        { status: response.status, body: await responseBody(response) },
        testCase.name,
      ).toEqual({
        status: testCase.expectedStatus,
        body: expectedProblemForTag(testCase.expectedTag, testCase.expectedStatus),
      });
    }
  });
});
