import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  DepartmentJsonSchema,
  MembershipId,
  Organization,
  type OrganizationOperations,
  PersonId,
  SemesterId,
  TeamId,
  type TeamInterestReadScope,
} from "@vektorprogrammet/domain/organization";
import { isProblem } from "@vektorprogrammet/rpc/problem";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

/**
 * The team-interest gate matrix and wire shape, driven through the backend authority flow:
 * credential -> one authorization instant -> leader scope.
 */

const department = Schema.decodeSync(DepartmentJsonSchema)(
  {
    departmentId: DepartmentId.make("department-1"),
    name: "Department One",
    shortName: "ONE",
    email: "one@example.invalid",
    address: null,
    city: "Trondheim",
    latitude: null,
    longitude: null,
    slackChannel: null,
    logoPath: null,
    active: true,
    revision: 0,
  },
  { onExcessProperty: "error" },
);

const secondDepartment = Schema.decodeSync(DepartmentJsonSchema)(
  {
    departmentId: DepartmentId.make("department-2"),
    name: "Department Two",
    shortName: "TWO",
    email: "two@example.invalid",
    address: null,
    city: "Bergen",
    latitude: null,
    longitude: null,
    slackChannel: null,
    logoPath: null,
    active: true,
    revision: 0,
  },
  { onExcessProperty: "error" },
);

const registrationRows = [
  {
    registrationId: 2,
    submitterName: "User B",
    submitterEmail: "b@example.invalid",
    teamId: TeamId.make("team-1"),
    teamName: "Team One",
    departmentId: DepartmentId.make("department-1"),
    semesterId: null,
    submittedAt: "2031-09-15T10:00:00.000Z",
    revision: 0,
  },
  {
    registrationId: 1,
    submitterName: "User A",
    submitterEmail: "a@example.invalid",
    teamId: TeamId.make("team-1"),
    teamName: "Team One",
    departmentId: DepartmentId.make("department-1"),
    semesterId: SemesterId.make("semester-host"),
    submittedAt: "2031-09-14T10:00:00.000Z",
    revision: 3,
  },
  {
    registrationId: 3,
    submitterName: "User C",
    submitterEmail: "c@example.invalid",
    teamId: TeamId.make("team-2"),
    teamName: "Team Two",
    departmentId: DepartmentId.make("department-2"),
    semesterId: null,
    submittedAt: "2031-09-16T10:00:00.000Z",
    revision: 0,
  },
] as const;

// The scope that the handler required on the last listing.
let lastTeamInterestScope: TeamInterestReadScope | undefined;

// The departments that the organization store holds; a test may empty it.
let storedDepartments = [department, secondDepartment];

type TokenMembership = {
  teamId: TeamId;
  departmentId: DepartmentId;
  active: boolean;
  /** Leads the unit; a board of an independent department reaches the department. */
  leader: boolean;
  unitKind: "Team" | "DepartmentBoard";
};

type AuthorityByToken = {
  globalAdministrator: "Active" | "Inactive" | "Absent";
  memberships: ReadonlyArray<TokenMembership>;
};

const boardOne = TeamId.make("styret-1");

const teamOne = TeamId.make("team-1");

const teamTwo = TeamId.make("team-2");

const departmentOne = DepartmentId.make("department-1");

const departmentTwo = DepartmentId.make("department-2");

/** Each session token names one caller; the person ID carries the token. */
const authorityForToken = (token: string): AuthorityByToken => {
  if (token === "admin-session") {
    return {
      globalAdministrator: "Active",
      memberships: [
        {
          teamId: teamOne,
          departmentId: departmentOne,
          active: true,
          leader: false,
          unitKind: "Team",
        },
      ],
    };
  }

  if (token === "leader-session") {
    return {
      globalAdministrator: "Absent",
      memberships: [
        {
          teamId: boardOne,
          departmentId: departmentOne,
          active: true,
          leader: true,
          unitKind: "DepartmentBoard",
        },
        {
          teamId: teamTwo,
          departmentId: departmentTwo,
          active: true,
          leader: false,
          unitKind: "Team",
        },
      ],
    };
  }

  if (token === "team-captain") {
    return {
      globalAdministrator: "Absent",
      memberships: [
        {
          teamId: teamTwo,
          departmentId: departmentTwo,
          active: true,
          leader: true,
          unitKind: "Team",
        },
      ],
    };
  }

  if (token === "inactive-leader") {
    return {
      globalAdministrator: "Absent",
      memberships: [
        {
          teamId: boardOne,
          departmentId: departmentOne,
          active: false,
          leader: true,
          unitKind: "DepartmentBoard",
        },
      ],
    };
  }

  return {
    globalAdministrator: "Absent",
    memberships: [
      {
        teamId: teamOne,
        departmentId: departmentOne,
        active: true,
        leader: false,
        unitKind: "Team",
      },
    ],
  };
};

const tokenPrefix = "better-auth.session_token=";

const organization = {
  listDepartments: Effect.sync(() => storedDepartments),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: (personId: PersonId, evaluatedAt: string) => {
    const authority = authorityForToken(personId);

    return Effect.succeed({
      personId,
      evaluatedAt,
      ...authority,
      memberships: authority.memberships.map(
        ({ leader, teamId, departmentId, active, unitKind }, index) => ({
          membershipId: MembershipId.make(`membership-${index}`),
          teamId,
          departmentId,
          active,
          unitLeader: leader,
          unitKind,
          teamScope: "HomeDepartment" as const,
          departmentIndependent: true,
        }),
      ),
      nationalBoardSeats: [],
      delegations: [],
    });
  },
  listTeamInterestRegistrations: (scope: TeamInterestReadScope, semesterId?: SemesterId) =>
    Effect.sync(() => {
      lastTeamInterestScope = scope;

      const rows = registrationRows
        .filter(
          (row) =>
            (scope.departmentIds.includes(row.departmentId) ||
              scope.teams.some((team) => team.teamId === row.teamId)) &&
            (semesterId === undefined || row.semesterId === semesterId),
        )
        .toSorted((left, right) => left.registrationId - right.registrationId);

      return rows.map((row) => ({ ...row }));
    }),
} satisfies Partial<OrganizationOperations>;

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) => {
    const token = cookieHeader?.startsWith(tokenPrefix)
      ? cookieHeader.slice(tokenPrefix.length)
      : "";

    return token.length === 0
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(token),
            sessionId: "team-interest-session",
            expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
          }),
        );
  },
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const backend = makeBackendTestRpc(
  backendTestConfig,
  Layer.mergeAll(
    Layer.mock(Organization, organization),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  ),
);

const asSession =
  (token: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    RpcClient.withHeaders(effect, { cookie: `${tokenPrefix}${token}` });

const codeOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((failure) => (isProblem(failure) ? failure.code : String(failure))),
  );

describe("team-interest RPC boundary", () => {
  it.live("answers credential.missing without a session before any data leaves the store", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      expect(yield* codeOf(client["organization.listTeamInterest"]({}))).toBe("credential.missing");
    }),
  );

  it.live("denies a plain member and an inactive leader", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      expect(
        yield* codeOf(
          client["organization.listTeamInterest"]({}).pipe(asSession("member-session")),
        ),
      ).toBe("authority.denied");

      expect(
        yield* codeOf(
          client["organization.listTeamInterest"]({}).pipe(asSession("inactive-leader")),
        ),
      ).toBe("authority.denied");
    }),
  );

  it.live("scopes a leader to their authorized union and answers the exact envelope", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const response = yield* client["organization.listTeamInterest"]({}).pipe(
        asSession("leader-session"),
      );

      expect(response).toEqual({
        "hydra:member": [
          { id: 1, userName: "User A", teamName: "Team One" },
          { id: 2, userName: "User B", teamName: "Team One" },
        ],
        "hydra:totalItems": 2,
      });
      // Rows ordered registration_id ASC regardless of insert order.
      expect(lastTeamInterestScope?.departmentIds).toEqual(["department-1"]);
    }),
  );

  it.live("lets an ordinary team's leader read the own team's interest only", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const response = yield* client["organization.listTeamInterest"]({}).pipe(
        asSession("team-captain"),
      );

      expect(response).toEqual({
        "hydra:member": [{ id: 3, userName: "User C", teamName: "Team Two" }],
        "hydra:totalItems": 1,
      });
      expect(lastTeamInterestScope?.departmentIds).toEqual([]);
      expect(lastTeamInterestScope?.teams.map(({ teamId }) => teamId)).toEqual(["team-2"]);

      expect(
        yield* codeOf(
          client["organization.listTeamInterest"]({ departmentId: departmentOne }).pipe(
            asSession("team-captain"),
          ),
        ),
      ).toBe("authority.denied");
    }),
  );

  it.live("gives a global administrator every department despite having one membership", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const response = yield* client["organization.listTeamInterest"]({}).pipe(
        asSession("admin-session"),
      );

      expect(response).toEqual({
        "hydra:member": [
          { id: 1, userName: "User A", teamName: "Team One" },
          { id: 2, userName: "User B", teamName: "Team One" },
          { id: 3, userName: "User C", teamName: "Team Two" },
        ],
        "hydra:totalItems": 3,
      });
      expect(lastTeamInterestScope?.departmentIds).toEqual(["department-1", "department-2"]);
    }),
  );

  it.live("gives a global administrator an empty success while no department exists", () =>
    Effect.gen(function* () {
      storedDepartments = [];

      const client = yield* backend.client;

      const response = yield* client["organization.listTeamInterest"]({}).pipe(
        asSession("admin-session"),
      );

      expect(response).toEqual({ "hydra:member": [], "hydra:totalItems": 0 });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          storedDepartments = [department, secondDepartment];
        }),
      ),
    ),
  );

  it.live("narrows by department inside scope and denies a department outside it", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const inScope = yield* client["organization.listTeamInterest"]({
        departmentId: departmentOne,
      }).pipe(asSession("leader-session"));

      expect(inScope["hydra:totalItems"]).toBe(2);

      expect(
        yield* codeOf(
          client["organization.listTeamInterest"]({ departmentId: departmentTwo }).pipe(
            asSession("leader-session"),
          ),
        ),
      ).toBe("authority.denied");
    }),
  );
});
