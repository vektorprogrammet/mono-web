import { backendDatabase } from "../../test/database.js";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
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
import { isProblem, problemBody } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { RpcClient } from "effect/unstable/rpc";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc, testAuthHandler } from "../test/native-rpc.js";

const personId = PersonId.make("schools-rpc-person");

const SESSION = "schools-test-session";

const departmentA = DepartmentId.make("schools-rpc-a");

const departmentB = DepartmentId.make("schools-rpc-b");

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
      membershipId: MembershipId.make("schools-rpc-membership"),
      teamId: TeamId.make("schools-rpc-team"),
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
    cookieHeader?.includes(SESSION)
      ? Effect.succeed(
          new IdentityActor({
            personId,
            sessionId: SESSION,
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

const makeBackend = (
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
) =>
  makeBackendTestRpc({
    config: backendTestConfig,
    services: Layer.mergeAll(
      database.layer,
      Layer.mock(Organization, {
        resolvePersonAuthorityForRead: () => Effect.succeed(authority),
        readDepartment,
      }),
      Layer.succeed(
        Schools,
        Schools.of({
          listDirectory,
          readManagement: () => Effect.die("unexpected school management read"),
          authorizeCommand: () => Effect.die("unexpected school command authorization"),
          executeCommand: () => Effect.die("unexpected school command"),
        }),
      ),
      Layer.succeed(Identity, identity),
      Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
    ),
    authHandler: testAuthHandler,
    options: // The composition pins the authorization instant that the projection was evaluated at.
      { now: () => instant },
  });

const listSchools = (
  backend: ReturnType<typeof makeBackend>,
  departmentId: DepartmentId | undefined,
  session: string = SESSION,
) =>
  Effect.gen(function* () {
    const client = yield* backend.client;

    return yield* RpcClient.withHeaders(
      client["directory.listSchools"](departmentId === undefined ? {} : { departmentId }),
      { cookie: `better-auth.session_token=${session}` },
    );
  });

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

describe("Schools directory RPC", () => {
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

      const backend = makeBackend(projection(), (input) => {
        listInputs.push(input);

        return Effect.succeed(school);
      });

      expect(yield* listSchools(backend, departmentA)).toEqual(school);
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

  it.live(
    "maps authentication, authority, reference, scope, and persistence failures exactly",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly name: string;
          readonly expectedStatus: number;
          readonly expectedTag: string;
          readonly authority?: OrganizationPersonAuthority;
          readonly departmentId?: DepartmentId;
          readonly session?: string;
          readonly readDepartment?: (
            departmentId: DepartmentId,
          ) => Effect.Effect<Department, DepartmentNotFound>;
          readonly listDirectory?: (
            input: SchoolDirectoryListInput,
          ) => Effect.Effect<SchoolDirectory, SchoolsDecodeError | SchoolsPersistenceError>;
        }> = [
          {
            name: "unknown session",
            expectedStatus: 401,
            expectedTag: "UnauthenticatedActor",
            session: "unknown-session",
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
            departmentId: departmentB,
            readDepartment: (departmentId) => Effect.fail(new DepartmentNotFound({ departmentId })),
          },
          {
            name: "outside scope",
            expectedStatus: 403,
            expectedTag: "SchoolsDepartmentOutOfScope",
            departmentId: departmentB,
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
          const backend = makeBackend(
            testCase.authority ?? projection(),
            testCase.listDirectory ?? (() => Effect.succeed(emptyDirectory)),
            testCase.readDepartment,
          );

          const failure = yield* Effect.flip(
            listSchools(backend, testCase.departmentId, testCase.session),
          );

          expect(isProblem(failure) ? problemBody(failure) : failure, testCase.name).toEqual(
            expectedProblemForTag(testCase.expectedTag, testCase.expectedStatus),
          );
        }
      }),
  );
});
