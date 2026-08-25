import {
  DepartmentJsonSchema,
  Organization,
  type OrganizationShape,
} from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { BackendRun } from "../router.js";
import { makeOrganizationApiConfig } from "./config.js";
import { makeOrganizationApiHttp } from "./http.js";
import { runTestPromise } from "../../test/runtime.js";

/**
 * Specs 0059/0060 gate matrix and wire shapes, driven through the backend
 * authority flow: cookie -> resolveAuthority (one instant) -> leader scope.
 */

const department = Schema.decodeUnknownSync(DepartmentJsonSchema)(
  {
    departmentId: "department-1",
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
const secondDepartment = Schema.decodeUnknownSync(DepartmentJsonSchema)(
  {
    departmentId: "department-2",
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
    teamId: "team-1",
    teamName: "Team One",
    departmentId: "department-1",
    semesterId: null,
    submittedAt: "2031-09-15T10:00:00.000Z",
    revision: 0,
  },
  {
    registrationId: 1,
    submitterName: "User A",
    submitterEmail: "a@example.invalid",
    teamId: "team-1",
    teamName: "Team One",
    departmentId: "department-1",
    semesterId: "semester-host",
    submittedAt: "2031-09-14T10:00:00.000Z",
    revision: 3,
  },
  {
    registrationId: 3,
    submitterName: "User C",
    submitterEmail: "c@example.invalid",
    teamId: "team-2",
    teamName: "Team Two",
    departmentId: "department-2",
    semesterId: null,
    submittedAt: "2031-09-16T10:00:00.000Z",
    revision: 0,
  },
] as const;
let lastTeamInterestFilter: {
  authorizedDepartmentIds: ReadonlyArray<string>;
  semesterId?: string;
};
const organization = {
  listDepartments: Effect.succeed([department, secondDepartment]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  listTeamInterestRegistrations: (filter: {
    authorizedDepartmentIds: ReadonlyArray<string>;
    semesterId?: string;
  }) =>
    Effect.sync(() => {
      lastTeamInterestFilter = filter;
      const authorized = filter.authorizedDepartmentIds;
      const rows = registrationRows
        .filter(
          (row) =>
            authorized.includes(row.departmentId) &&
            (filter.semesterId === undefined || row.semesterId === filter.semesterId),
        )
        .toSorted((left, right) => left.registrationId - right.registrationId);
      return rows.map((row) => ({ ...row }));
    }),
  projectMailingLists: (input: {
    type: "assistants" | "team" | "all";
    authorizedDepartmentIds: ReadonlyArray<string>;
  }) =>
    Effect.succeed(
      input.authorizedDepartmentIds
        .map((departmentId) => ({
          name: `${input.type}-${departmentId}`,
          emails: [],
        }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
} as unknown as OrganizationShape;

type AuthorityByToken = {
  globalAdministrator: "Active" | "Inactive" | "Absent";
  memberships: ReadonlyArray<{
    departmentId: string;
    active: boolean;
    teamLeader: boolean;
  }>;
};

const authorityForToken = (cookie: string | null): AuthorityByToken => {
  if (cookie?.includes("admin-session")) {
    return {
      globalAdministrator: "Active",
      memberships: [{ departmentId: "department-1", active: true, teamLeader: false }],
    };
  }
  if (cookie?.includes("leader-session")) {
    return {
      globalAdministrator: "Absent",
      memberships: [
        { departmentId: "department-1", active: true, teamLeader: true },
        { departmentId: "department-2", active: true, teamLeader: false },
      ],
    };
  }
  if (cookie?.includes("inactive-leader")) {
    return {
      globalAdministrator: "Absent",
      memberships: [{ departmentId: "department-1", active: false, teamLeader: true }],
    };
  }
  return {
    globalAdministrator: "Absent",
    memberships: [{ departmentId: "department-1", active: true, teamLeader: false }],
  };
};

const config = makeOrganizationApiConfig({
  ORGANIZATION_MAX_BODY_BYTES: "1024",
});

const run = (<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runTestPromise(
    effect.pipe(Effect.provideService(Organization, organization)) as Effect.Effect<A, E>,
  )) as BackendRun;

const http = makeOrganizationApiHttp({
  config,
  resolveActor: async () => ({
    _tag: "OrganizationMember",
    personId: "person-member" as never,
  }),
  resolveAuthority: async (request) => {
    const cookie = request.headers.get("cookie");
    if (cookie === null || cookie.length === 0) {
      throw Object.assign(new Error("UnauthenticatedActor"), { _tag: "UnauthenticatedActor" });
    }
    const authority = authorityForToken(cookie);
    return {
      personId: "person-any",
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      ...authority,
      memberships: authority.memberships.map((membership, index) => ({
        membershipId: `membership-${index}`,
        teamId: `team-${index}`,
        ...membership,
      })),
    } as never;
  },
  run,
});

const get = (pathname: string, cookie?: string): Promise<Response> =>
  http.fetch(
    new Request(`http://backend.test${pathname}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

describe("spec 0059 team-interest HTTP boundary", () => {
  it("answers 401 without a session before any data leaves the store", async () => {
    const response = await get("/api/admin/team-interest");
    expect(response.status).toBe(401);
  });

  it("denies a plain member and an inactive leader with typed 403", async () => {
    const member = await get("/api/admin/team-interest", "session=member-session");
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: { tag: "OrganizationRoleDenied" } });

    const inactive = await get("/api/admin/team-interest", "session=inactive-leader");
    expect(inactive.status).toBe(403);
  });

  it("scopes a leader to their authorized union and emits the exact fixture envelope", async () => {
    const response = await get("/api/admin/team-interest", "session=leader-session");
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

  it("gives a global administrator every department despite having one membership", async () => {
    const teamInterest = await get("/api/admin/team-interest", "session=admin-session");
    expect(teamInterest.status).toBe(200);
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

    const mailingLists = await get("/api/admin/mailing-lists", "session=admin-session");
    expect(mailingLists.status).toBe(200);
    expect(await mailingLists.json()).toEqual([
      { name: "assistants-department-1", emails: [] },
      { name: "assistants-department-2", emails: [] },
    ]);
  });

  it("rejects an unknown mailing-list type at the decode boundary", async () => {
    const response = await get("/api/admin/mailing-lists?type=unknown", "session=admin-session");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { tag: "OrganizationDecodeError" },
    });
  });
  it("narrows by department inside scope and denies out-of-scope with 403", async () => {
    const inScope = await get(
      "/api/admin/team-interest?department=department-1",
      "session=leader-session",
    );
    expect(inScope.status).toBe(200);

    const outOfScope = await get(
      "/api/admin/team-interest?department=department-2",
      "session=leader-session",
    );
    expect(outOfScope.status).toBe(403);
  });
});
