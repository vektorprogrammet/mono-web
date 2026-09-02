import type { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import type { Admissions } from "@vektorprogrammet/domain/admissions";
import type { ServicePrincipalGrantAuthority } from "@vektorprogrammet/domain/authz";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity } from "@vektorprogrammet/domain/identity";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
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
import type { Profile } from "@vektorprogrammet/domain/profile";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Recruitment } from "@vektorprogrammet/domain/recruitment";
import {
  SchoolId,
  Schools,
  SchoolsDecodeError,
  SchoolsPersistenceError,
  type SchoolDirectory,
  type SchoolDirectoryListInput,
} from "@vektorprogrammet/domain/schools";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BackendRun } from "../router.js";
import { makeSchoolsTestHttp as makeSchoolsApiHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

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

const makeRun = (
  authority: OrganizationPersonAuthority,
  listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsDecodeError | SchoolsPersistenceError>,
  readDepartment: (departmentId: DepartmentId) => Effect.Effect<unknown, DepartmentNotFound> = (
    departmentId,
  ) => Effect.succeed({ departmentId }),
): BackendRun => {
  const organization = Organization.of({
    resolvePersonAuthorityForRead: () => Effect.succeed(authority),
    readDepartment,
  } as never);
  const schools = Schools.of({ listDirectory });
  const database = makeDatabase();

  return <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Database
      | Admissions
      | Economy
      | Organization
      | Profile
      | Recruitment
      | Schools
      | Identity
      | IdentitySnapshot
      | OAuthCredentialAuthority
      | ServicePrincipalGrantAuthority
      | ContentManagement
      | Content
    >,
  ): Promise<A> => {
    const runnable = effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Organization, organization),
      Effect.provideService(Schools, schools),
    ) as Effect.Effect<A, E, never>;
    return runTestPromise(runnable);
  };
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
    const run = makeRun(projection(), (input) => {
      listInputs.push(input);
      return Effect.succeed(school);
    });
    const api = makeSchoolsApiHttp({
      resolveActor: () => Promise.resolve({ personId, authorizationInstant: instant }),

      run,
    });

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
    const run = makeRun(projection(), () => {
      listCalls += 1;
      return Effect.succeed(emptyDirectory);
    });
    const api = makeSchoolsApiHttp({
      resolveActor: () => {
        actorCalls += 1;
        return Promise.resolve({ personId, authorizationInstant: instant });
      },
      run,
    });

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
      readonly resolveActor?: () => Promise<{
        personId: PersonId;
        authorizationInstant: typeof instant;
      }>;
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
          Promise.reject(new UnauthenticatedActor({ message: "authentication required" })),
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
      const api = makeSchoolsApiHttp({
        resolveActor:
          testCase.resolveActor ??
          (() => Promise.resolve({ personId, authorizationInstant: instant })),
        run: makeRun(
          testCase.authority ?? projection(),
          testCase.listDirectory ?? (() => Effect.succeed(emptyDirectory)),
          testCase.readDepartment,
        ),
      });
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
