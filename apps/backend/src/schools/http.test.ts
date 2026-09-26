import { backendDatabase } from "../../test/database.js";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  Department,
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
  SchoolDirectoryScopeSchema,
  SchoolId,
  Schools,
  SchoolsDecodeError,
  SchoolsPersistenceError,
  type SchoolDirectory,
  type SchoolDirectoryListInput,
} from "@vektorprogrammet/domain/schools";
import { Schema, DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
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
      unitLeader: false,
      unitKind: "Team",
      teamScope: "HomeDepartment",
      departmentIndependent: false,
    },
  ],
  nationalBoardSeats: [],
  delegations: [],
  ...overrides,
});

const database = backendDatabase();

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader?.includes("schools-test-session")
      ? Effect.succeed(
          new IdentityActor({
            personId,
            sessionId: "schools-test-session",
            expiresAt: DateTime.makeUnsafe("2032-04-02T12:00:00.000Z"),
          }),
        )
      : Effect.fail(new IdentitySessionNotFound()),
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const makeServices = (
  authority: OrganizationPersonAuthority,
  listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsDecodeError | SchoolsPersistenceError>,
  readDepartment: (departmentId: DepartmentId) => Effect.Effect<Department, DepartmentNotFound> = (
    departmentId,
  ) =>
    Effect.succeed(
      new Department({
        departmentId,
        name: "Fixture department",
        shortName: "Fixture",
        email: "fixture@example.invalid",
        address: null,
        city: "Oslo",
        latitude: null,
        longitude: null,
        slackChannel: null,
        logoPath: null,
        active: true,
        revision: 0,
      }),
    ),
) => {
  const organization = {
    resolvePersonAuthorityForRead: () => Effect.succeed(authority),
    readDepartment,
  };

  const schools = Schools.of({
    listDirectory,
    readManagement: () => Effect.die("unexpected school management read"),
    authorizeCommand: () => Effect.die("unexpected school command authorization"),
    executeCommand: () => Effect.die("unexpected school command"),
  });

  return Layer.mergeAll(
    database.layer,
    Layer.mock(Organization, organization),
    Layer.succeed(Schools, schools),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  );
};

const responseBody = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
  );

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
      "The selected department is not valid for the school directory.",
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
  it.live("runs the named journey once and narrows the visible union by department", () =>
    Effect.gen(function* () {
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

      const response = yield* api.fetch(
        sessionRequest(`http://backend.test/api/schools?department=${departmentA}`),
      );

      expect({ status: response.status, body: yield* responseBody(response) }).toEqual({
        status: 200,
        body: school,
      });
      expect(listInputs).toEqual([
        {
          scope: SchoolDirectoryScopeSchema.cases.DepartmentIds.make({
            departmentIds: [departmentA],
          }),
          departmentId: departmentA,
        },
      ]);
    }),
  );

  it.live("rejects unknown, duplicate, and malformed query input before authentication", () =>
    Effect.gen(function* () {
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

      const malformed = expectedProblem(
        "request.malformed",
        "Malformed request",
        400,
        "The request is malformed.",
      );

      for (const query of [
        "unknown=1",
        `department=${departmentA}&unknown=1`,
        "department=a&department=b",
        "department=",
      ]) {
        const response = yield* api.fetch(
          sessionRequest(`http://backend.test/api/schools?${query}`),
        );

        expect({ status: response.status, body: yield* responseBody(response) }, query).toEqual({
          status: 400,
          body: malformed,
        });
      }

      expect(actorCalls).toBe(0);
      expect(listCalls).toBe(0);
    }),
  );

  it.live(
    "maps authentication, authority, reference, scope, and persistence failures exactly",
    () =>
      Effect.gen(function* () {
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
          ) => Effect.Effect<Department, DepartmentNotFound>;
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
            authority: projection({
              memberships: [],
              nationalBoardSeats: [],
              delegations: [],
              globalAdministrator: "Absent",
            }),
          },
          {
            name: "unknown department",
            expectedStatus: 422,
            expectedTag: "SchoolsDepartmentNotFound",
            query: `department=${departmentB}`,
            readDepartment: (departmentId) => Effect.fail(new DepartmentNotFound({ departmentId })),
          },
          {
            name: "outside scope",
            expectedStatus: 403,
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

          const response = yield* api.fetch(
            sessionRequest(`http://backend.test/api/schools${query}`),
          );

          expect(
            { status: response.status, body: yield* responseBody(response) },
            testCase.name,
          ).toEqual({
            status: testCase.expectedStatus,
            body: expectedProblemForTag(testCase.expectedTag, testCase.expectedStatus),
          });
        }
      }),
  );
});
