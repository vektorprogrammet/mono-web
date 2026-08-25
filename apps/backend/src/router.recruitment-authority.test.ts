import type { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  Auth,
  AuthenticatedActor,
  AuthSessionNotFound,
  type AuthShape,
} from "@vektorprogrammet/domain/auth";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { Organization, type OrganizationShape } from "@vektorprogrammet/domain/organization";
import { Organization as OrganizationService } from "@vektorprogrammet/domain/organization";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Profile } from "@vektorprogrammet/domain/profile";
import {
  Recruitment as RecruitmentService,
  RecruitmentRoleDenied,
  type RecruitmentActor,
  type RecruitmentShape,
} from "@vektorprogrammet/domain/recruitment";
import type { Schools } from "@vektorprogrammet/domain/schools";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp, type BackendRun } from "./router.js";
import { runTestPromise } from "../test/runtime.js";

const leaderToken = "leader-session-token";
const memberToken = "member-session-token";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
} as const;

const config = makeBackendConfig(environment);

const database = { health: Effect.void } as unknown as DatabaseShape;

interface AuthorityMembershipRow {
  readonly departmentId: string;
  readonly active: boolean;
  readonly teamLeader: boolean;
}

/** One authority projection per session token, selected by the cookie value. */
const membershipsByToken: Record<string, ReadonlyArray<AuthorityMembershipRow>> = {
  [leaderToken]: [{ departmentId: "department-1", active: true, teamLeader: true }],
  [memberToken]: [{ departmentId: "department-1", active: true, teamLeader: false }],
};

const personIdForToken = (tokenValue: string): string =>
  tokenValue === leaderToken ? "leader-1" : "member-1";

const organization = {
  listDepartments: Effect.succeed([]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: (personId: string) => {
    const row = Object.entries(membershipsByToken).find(
      ([token]) => personIdForToken(token) === personId,
    );
    return Effect.succeed({
      personId,
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: (row?.[1] ?? []).map((membership, index) => ({
        membershipId: `membership-${index}`,
        teamId: `team-${index}`,
        departmentId: membership.departmentId,
        active: membership.active,
        teamLeader: membership.teamLeader,
      })),
    });
  },
} as unknown as OrganizationShape;

const recruitmentCalls: Array<{
  readonly operation: string;
  readonly actor: unknown;
}> = [];

// Models the frozen domain law (checkContext): only active DepartmentLeaders
// may read or assign; everyone else receives RecruitmentRoleDenied.
const recruitment = {
  readAssignmentBoard: (query: unknown, context: { readonly actor: RecruitmentActor }) =>
    context.actor.active && context.actor._tag === "DepartmentLeader"
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readAssignmentBoard", actor: context.actor });
          void query;
          return {
            admissionPeriodId: "period-1",
            departmentId: "department-1",
            candidates: [],
            interviewers: [],
            interviewSchemas: [],
          };
        })
      : Effect.fail(new RecruitmentRoleDenied({ personId: context.actor.personId })),
  assignApplicant: () => Effect.die("unexpected assignApplicant"),
  readSchedulingBoard: () => Effect.die("unexpected readSchedulingBoard"),
  scheduleInterview: () => Effect.die("unexpected scheduleInterview"),
  readInvitationResponse: () => Effect.die("unexpected readInvitationResponse"),
  confirmInvitation: () => Effect.die("unexpected confirmInvitation"),
  rejectInvitation: () => Effect.die("unexpected rejectInvitation"),
  requestNewInvitationTime: () => Effect.die("unexpected requestNewInvitationTime"),
} as unknown as RecruitmentShape;

const run: BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database | Admissions | Economy | Organization | Profile | RecruitmentService | Schools | Auth
  >,
): Promise<A> =>
  runTestPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(OrganizationService, organization),
      Effect.provideService(RecruitmentService, recruitment),
      Effect.provideService(Auth, {
        signIn: () => Promise.reject(new Error("unexpected sign-in")),
        resolveSession: async (cookieHeader: string | undefined) => {
          const matched = Object.keys(membershipsByToken).find((token) =>
            cookieHeader?.includes(`${token}=`),
          );
          if (matched !== undefined) {
            return new AuthenticatedActor({
              personId: personIdForToken(matched) as never,
              sessionId: "session-1",
              expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
            });
          }
          throw new AuthSessionNotFound({ sessionToken: "" });
        },
        signOut: async () => undefined,
      } as unknown as AuthShape),
    ) as Effect.Effect<A, E>,
  );

const backend = makeBackendHttp(config, run, {
  handle: async () => new Response(null, { status: 404 }),
});

const request = (pathname: string, cookie: string): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, { headers: { cookie } }));

describe("recruitment actors from authorized departments (spec 0055)", () => {
  it("resolves a DepartmentLeader actor for an active team-leader membership", async () => {
    const response = await request(
      "/api/admin/recruitment/assignment-board?status=new",
      `${leaderToken}=value`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      admissionPeriodId: "period-1",
      departmentId: "department-1",
      candidates: [],
      interviewers: [],
      interviewSchemas: [],
    });
    expect(recruitmentCalls.at(-1)).toEqual({
      operation: "readAssignmentBoard",
      actor: {
        _tag: "DepartmentLeader",
        personId: "leader-1",
        departmentId: "department-1",
        active: true,
      },
    });
  });

  it("still denies a plain active member", async () => {
    const response = await request(
      "/api/admin/recruitment/assignment-board?status=all",
      `${memberToken}=value`,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { tag: "RecruitmentRoleDenied" },
    });
  });

  it("denies an anonymous caller before any projection runs", async () => {
    const response = await request("/api/admin/recruitment/assignment-board?status=new", "");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { tag: "UnauthenticatedActor" } });
  });
});
