import { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  Department,
  DepartmentCreatedObservationSchema,
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudy,
  FieldOfStudyCreatedObservationSchema,
  FieldOfStudyJsonSchema,
  Organization,
  OrganizationCommandConflict,
  type OrganizationCommandId,
  OrganizationInvalidReference,
  type OrganizationOperations,
  OrganizationPersistenceError,
  PersonId,
  Team,
  TeamCreatedObservationSchema,
  TeamJsonSchema,
} from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem, problemBody } from "@vektorprogrammet/rpc/problem";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { jsonText } from "../rpc/problem.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const ADMIN_SESSION = "organization-admin-session";

const MEMBER_SESSION = "organization-member-session";

const department = Schema.decodeSync(DepartmentJsonSchema)(
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

const team = Schema.decodeSync(TeamJsonSchema)(
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

const fieldOfStudy = Schema.decodeSync(FieldOfStudyJsonSchema)(
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

// Like the PostgreSQL layer, the doubles answer with the model instance that they read back.
// Canonical JSON refuses a model instance, so the response must come from the contract schema.
const departmentResult = (commandId: OrganizationCommandId) => ({
  committed: true as const,
  observation: {
    ...DepartmentCreatedObservationSchema.make({ commandId, department }),
    department: Schema.decodeSync(Department)(department),
  },
});

let createCalls = 0;

const organization = {
  listDepartments: Effect.succeed([department]),
  listTeams: () => Effect.succeed([team]),
  listFieldOfStudies: Effect.succeed([fieldOfStudy]),
  resolvePersonAuthority: (personId: PersonId, evaluatedAt: string) =>
    Effect.succeed({
      personId,
      evaluatedAt,
      globalAdministrator: personId === "person-admin" ? "Active" : "Absent",
      memberships: [],
      nationalBoardSeats: [],
      delegations: [],
    }),
  createDepartment: (
    command: Parameters<OrganizationOperations["createDepartment"]>[0],
    _administrator: Parameters<OrganizationOperations["createDepartment"]>[1],
  ) => {
    createCalls += 1;

    if (command.name === "Conflict") {
      return Effect.fail(new OrganizationCommandConflict({ commandId: command.commandId }));
    }

    if (command.name === "Unavailable") {
      return Effect.fail(
        new OrganizationPersistenceError({
          operation: "createDepartment",
          message: "database unavailable",
        }),
      );
    }

    return Effect.succeed(departmentResult(command.commandId));
  },
  createTeam: (command: Parameters<OrganizationOperations["createTeam"]>[0]) => {
    createCalls += 1;

    if (command.departmentId === "department-unknown") {
      return Effect.fail(new OrganizationInvalidReference({ referenceKind: "Department" }));
    }

    return Effect.succeed({
      committed: true as const,
      observation: {
        ...TeamCreatedObservationSchema.make({ commandId: command.commandId, team }),
        team: Schema.decodeSync(Team)(team),
      },
    });
  },
  createFieldOfStudy: (command: Parameters<OrganizationOperations["createFieldOfStudy"]>[0]) =>
    Effect.succeed({
      committed: true as const,
      observation: {
        ...FieldOfStudyCreatedObservationSchema.make({
          commandId: command.commandId,
          fieldOfStudy,
        }),
        fieldOfStudy: Schema.decodeSync(FieldOfStudy)(fieldOfStudy),
      },
    }),
} satisfies Partial<OrganizationOperations>;

const sessionPerson = (cookieHeader: string | undefined) =>
  cookieHeader?.includes(ADMIN_SESSION)
    ? PersonId.make("person-admin")
    : cookieHeader?.includes(MEMBER_SESSION)
      ? PersonId.make("person-member")
      : undefined;

const sessionActor = (cookieHeader: string | undefined) => {
  const personId = sessionPerson(cookieHeader);

  return personId === undefined
    ? Effect.fail(new IdentitySessionNotFound())
    : Effect.succeed(
        new IdentityActor({
          personId,
          sessionId: "organization-rpc-session",
          expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
        }),
      );
};

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookieHeader) => Effect.suspend(() => sessionActor(cookieHeader)),
  revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
  revokeSession: () => Effect.succeed({ setCookies: [] }),
  revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
  revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) => sessionActor(cookieHeader),
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const database = backendDatabase();

const backend = makeBackendTestRpc({
  config: backendTestConfig,
  services: Layer.mergeAll(
    database.layer,
    Layer.succeed(IdentitySnapshot, identitySnapshot),
    Layer.mock(Organization, organization),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  ),
});

const asSession =
  (session: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    RpcClient.withHeaders(effect, { cookie: `better-auth.session_token=${session}` });

const key = (value: string) => IdempotencyKey.make(value);

/** The problem an RPC failed with, as its frozen body. */
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((failure) => (isProblem(failure) ? problemBody(failure) : failure)),
  );

const expectedProblem = (code: string, title: string, status: number, detail: string) => ({
  type: `urn:vektorprogrammet:problem:v0.2:${code}`,
  title,
  status,
  detail,
  code,
});

describe("Organization RPC boundary", () => {
  it.live("returns only canonical Organization JSON projections from all public reads", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const [departments, teams, fields] = yield* Effect.all(
        [
          client["organization.listDepartments"](),
          client["organization.listTeams"](),
          client["organization.listFieldOfStudies"](),
        ],
        { concurrency: "unbounded" },
      );

      expect(departments).toEqual([department]);
      expect(teams).toEqual([team]);
      expect(fields).toEqual([fieldOfStudy]);

      const serialized = yield* jsonText([departments, teams, fields]);

      for (const forbidden of ["personId", "membership", "commandId", "audit", "actorsByToken"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }),
  );

  it.live("returns canonical resources for committed and replayed commands", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;
      const departmentKey = key("department-create-key-0001");

      const created = yield* client["organization.createDepartment"]({
        idempotencyKey: departmentKey,
        request: createDepartmentRequest,
      }).pipe(asSession(ADMIN_SESSION));

      const createdTeam = yield* client["organization.createTeam"]({
        idempotencyKey: key("team-create-key-00000001"),
        request: createTeamRequest,
      }).pipe(asSession(ADMIN_SESSION));

      const createdField = yield* client["organization.createFieldOfStudy"]({
        idempotencyKey: key("field-create-key-0000001"),
        request: createFieldOfStudyRequest,
      }).pipe(asSession(ADMIN_SESSION));

      const before = createCalls;

      const replayed = yield* client["organization.createDepartment"]({
        idempotencyKey: departmentKey,
        request: createDepartmentRequest,
      }).pipe(asSession(ADMIN_SESSION));

      expect(created).toEqual(department);
      expect(createdTeam).toEqual(team);
      expect(createdField).toEqual(fieldOfStudy);
      expect(replayed).toEqual(department);
      // The replay answers the stored receipt without running the command again.
      expect(createCalls).toBe(before);
    }),
  );

  it.live("maps authority, reference, conflict, and dependency failures to problems", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const denied = yield* failureOf(
        client["organization.createDepartment"]({
          idempotencyKey: key("department-denied-key-0001"),
          request: createDepartmentRequest,
        }).pipe(asSession(MEMBER_SESSION)),
      );

      const invalidReference = yield* failureOf(
        client["organization.createTeam"]({
          idempotencyKey: key("team-invalid-ref-key-00001"),
          request: { ...createTeamRequest, departmentId: DepartmentId.make("department-unknown") },
        }).pipe(asSession(ADMIN_SESSION)),
      );

      const conflict = yield* failureOf(
        client["organization.createDepartment"]({
          idempotencyKey: key("department-conflict-key-01"),
          request: { ...createDepartmentRequest, name: "Conflict" },
        }).pipe(asSession(ADMIN_SESSION)),
      );

      const unavailable = yield* failureOf(
        client["organization.createDepartment"]({
          idempotencyKey: key("department-unavailable-001"),
          request: { ...createDepartmentRequest, name: "Unavailable" },
        }).pipe(asSession(ADMIN_SESSION)),
      );

      expect(denied).toEqual(
        expectedProblem(
          "authority.denied",
          "Authority denied",
          403,
          "The authenticated principal is not permitted to perform this operation.",
        ),
      );
      expect(invalidReference).toEqual(
        expectedProblem(
          "organization.invalid-reference",
          "Invalid organization reference",
          422,
          "An organization reference is invalid.",
        ),
      );
      expect(conflict).toEqual(
        expectedProblem(
          "idempotency.digest-conflict",
          "Idempotency conflict",
          409,
          "This idempotency key identifies a different semantic request.",
        ),
      );
      expect(unavailable).toEqual(
        expectedProblem(
          "organization.unavailable",
          "Organization unavailable",
          503,
          "The organization service is temporarily unavailable.",
        ),
      );
    }),
  );

  it.live("fails closed with a credential problem before the command runs", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;
      const before = createCalls;

      const anonymous = yield* failureOf(
        client["organization.createDepartment"]({
          idempotencyKey: key("anonymous-department-key-01"),
          request: createDepartmentRequest,
        }),
      );

      expect(anonymous).toEqual(
        expectedProblem(
          "credential.missing",
          "Credential required",
          401,
          "A credential is required for this operation.",
        ),
      );
      expect(createCalls).toBe(before);
    }),
  );
});
