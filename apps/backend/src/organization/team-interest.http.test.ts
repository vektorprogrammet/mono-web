import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  TeamId,
  SemesterId,
  MembershipId,
  OrganizationActorSchema,
  DepartmentJsonSchema,
  Organization,
  PersonId,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeOrganizationApiConfig } from "./config.js";
import { makeOrganizationTestHttp as makeOrganizationApiHttp } from "../test/native-http.js";
import { PRIVATE_NO_STORE } from "../http-semantics.js";

/**
 * Specs 0059/0060 gate matrix and wire shapes, driven through the backend
 * authority flow: cookie -> resolveAuthority (one instant) -> leader scope.
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

let lastTeamInterestFilter: {
  authorizedDepartmentIds: ReadonlyArray<string>;
  authorizedTeamIds: ReadonlyArray<string>;
  semesterId?: string;
};

// The departments that the organization store holds; a test may empty it.
let storedDepartments = [department, secondDepartment];

const organization = {
  listDepartments: Effect.sync(() => storedDepartments),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  listTeamInterestRegistrations: (filter: {
    authorizedDepartmentIds: ReadonlyArray<string>;
    authorizedTeamIds: ReadonlyArray<string>;
    semesterId?: string;
  }) =>
    Effect.sync(() => {
      lastTeamInterestFilter = filter;

      const rows = registrationRows
        .filter(
          (row) =>
            (filter.authorizedDepartmentIds.includes(row.departmentId) ||
              filter.authorizedTeamIds.includes(row.teamId)) &&
            (filter.semesterId === undefined || row.semesterId === filter.semesterId),
        )
        .toSorted((left, right) => left.registrationId - right.registrationId);

      return rows.map((row) => ({ ...row }));
    }),
} satisfies Partial<OrganizationOperations>;

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

const authorityForToken = (cookie: string | null): AuthorityByToken => {
  if (cookie?.includes("admin-session")) {
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

  if (cookie?.includes("leader-session")) {
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

  if (cookie?.includes("team-captain")) {
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

  if (cookie?.includes("inactive-leader")) {
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

const config = decodeOrganizationApiConfig({
  ORGANIZATION_MAX_BODY_BYTES: "1024",
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader === undefined || cookieHeader.length === 0
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make("team-interest-person"),
            sessionId: "team-interest-session",
            expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
          }),
        ),
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const services = Layer.mergeAll(
  Layer.mock(Organization, organization),
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const http = makeOrganizationApiHttp(
  {
    config,
    resolveActor: () =>
      Effect.succeed(
        OrganizationActorSchema.members[1].make({ personId: PersonId.make("person-member") }),
      ),
    resolveAuthority: (request) => {
      const cookie = request.headers.get("cookie");

      if (cookie === null || cookie.length === 0) {
        return Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
      }

      const authority = authorityForToken(cookie);

      return Effect.succeed({
        personId: PersonId.make("person-any"),
        evaluatedAt: "2031-09-15T12:00:00.000Z",
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
  },
  services,
);

const get = (pathname: string, cookie?: string): Promise<Response> =>
  http.fetch(
    new Request(`http://backend.test${pathname}`, {
      headers:
        cookie === undefined
          ? {}
          : { cookie: `better-auth.session_token=${cookie.replace(/^session=/, "")}` },
    }),
  );

describe("spec 0059 team-interest HTTP boundary", () => {
  it("answers 401 without a session before any data leaves the store", async () => {
    const response = await get("/api/team-interest-registrations");
    expect(response.status).toBe(401);
  });

  it("denies a plain member and an inactive leader with typed 403", async () => {
    const member = await get("/api/team-interest-registrations", "session=member-session");
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
      code: "authority.denied",
    });

    const inactive = await get("/api/team-interest-registrations", "session=inactive-leader");
    expect(inactive.status).toBe(403);
  });

  it("scopes a leader to their authorized union and emits the exact fixture envelope", async () => {
    const response = await get("/api/team-interest-registrations", "session=leader-session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      "hydra:member": [
        { id: 1, userName: "User A", teamName: "Team One" },
        { id: 2, userName: "User B", teamName: "Team One" },
      ],
      "hydra:totalItems": 2,
    });
    // Rows ordered registration_id ASC regardless of insert order.
    expect(lastTeamInterestFilter.authorizedDepartmentIds).toEqual(["department-1"]);
  });

  it("lets an ordinary team's leader read the own team's interest only (O8-11)", async () => {
    const response = await get("/api/team-interest-registrations", "session=team-captain");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      "hydra:member": [{ id: 3, userName: "User C", teamName: "Team Two" }],
      "hydra:totalItems": 1,
    });
    expect(lastTeamInterestFilter.authorizedDepartmentIds).toEqual([]);
    expect(lastTeamInterestFilter.authorizedTeamIds).toEqual(["team-2"]);

    const otherDepartment = await get(
      "/api/team-interest-registrations?department=department-1",
      "session=team-captain",
    );

    expect(otherDepartment.status).toBe(403);
  });

  it("gives a global administrator every department despite having one membership", async () => {
    const teamInterest = await get("/api/team-interest-registrations", "session=admin-session");
    expect(teamInterest.status).toBe(200);
    // The contract declares a private read; the dashboard's SDK rejects any other cache policy.
    expect(teamInterest.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
    expect(await teamInterest.json()).toEqual({
      "hydra:member": [
        { id: 1, userName: "User A", teamName: "Team One" },
        { id: 2, userName: "User B", teamName: "Team One" },
        { id: 3, userName: "User C", teamName: "Team Two" },
      ],
      "hydra:totalItems": 3,
    });
    expect(lastTeamInterestFilter.authorizedDepartmentIds).toEqual([
      "department-1",
      "department-2",
    ]);
  });

  it("gives a global administrator an empty success while no department exists", async () => {
    storedDepartments = [];

    try {
      const teamInterest = await get("/api/team-interest-registrations", "session=admin-session");

      expect(teamInterest.status).toBe(200);
      expect(await teamInterest.json()).toEqual({ "hydra:member": [], "hydra:totalItems": 0 });
    } finally {
      storedDepartments = [department, secondDepartment];
    }
  });

  it("rejects an unknown mailing-list type at the decode boundary", async () => {
    const response = await get("/api/mailing-lists?type=unknown", "session=admin-session");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:request.malformed",
      title: "Malformed request",
      status: 400,
      detail: "The request is malformed.",
      code: "request.malformed",
    });
  });
  it("narrows by department inside scope and denies out-of-scope with 403", async () => {
    const inScope = await get(
      "/api/team-interest-registrations?department=department-1",
      "session=leader-session",
    );

    expect(inScope.status).toBe(200);

    const outOfScope = await get(
      "/api/team-interest-registrations?department=department-2",
      "session=leader-session",
    );

    expect(outOfScope.status).toBe(403);
  });
});
