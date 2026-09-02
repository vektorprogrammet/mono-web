import type { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import type { Admissions } from "@vektorprogrammet/domain/admissions";
import type { ServicePrincipalGrantAuthority } from "@vektorprogrammet/domain/authz";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import {
  Organization,
  PersonId,
  type OrganizationShape,
} from "@vektorprogrammet/domain/organization";
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
import { beforeEach, describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import type { BackendRun } from "./router.js";
import { makeBackendTestHttp as makeBackendHttp } from "./test/native-http.js";
import { runTestPromise } from "../test/runtime.js";

const leaderToken = "leader-session-token";
const memberToken = "member-session-token";
const inactiveToken = "inactive-session-token";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
} as const;

const config = makeBackendConfig(environment);

const database = Object.assign(
  ((strings: TemplateStringsArray) => {
    const statement = strings.join(" ");
    if (statement.includes("organization_memberships AS membership")) {
      return Effect.succeed([
        {
          kind: "Membership",
          identity: "membership-0",
          revisions: [0, 0, 0],
        },
      ]);
    }
    return Effect.succeed([]);
  }) as unknown as DatabaseShape,
  {
    health: Effect.void,
    json: (value: unknown) => value,
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  },
);

interface AuthorityMembershipRow {
  readonly departmentId: string;
  readonly active: boolean;
  readonly teamLeader: boolean;
}

/** One authority projection per session token, selected by the cookie value. */
const membershipsByToken: Record<string, ReadonlyArray<AuthorityMembershipRow>> = {
  [leaderToken]: [{ departmentId: "department-1", active: true, teamLeader: true }],
  [memberToken]: [{ departmentId: "department-1", active: true, teamLeader: false }],
  [inactiveToken]: [{ departmentId: "department-1", active: false, teamLeader: false }],
};

const personIdsByToken: Readonly<Record<string, string>> = {
  [leaderToken]: "leader-1",
  [memberToken]: "member-1",
  [inactiveToken]: "inactive-1",
};
const personIdForToken = (tokenValue: string): string =>
  personIdsByToken[tokenValue] ?? "unknown-person";

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
const assignmentBoard = {
  admissionPeriodId: "period-1",
  departmentId: "department-1",
  candidates: [],
  interviewers: [],
  interviewSchemas: [],
};
const schedulingBoard = {
  departmentId: "department-1",
  interviews: [],
};

// Models the frozen domain laws: assignment reads require an active DepartmentLeader;
// scheduling reads require an active department member.
const recruitment = {
  readAssignmentBoard: (query: unknown, context: { readonly actor: RecruitmentActor }) =>
    context.actor.active && context.actor._tag === "DepartmentLeader"
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readAssignmentBoard", actor: context.actor });
          void query;
          return assignmentBoard;
        })
      : Effect.fail(new RecruitmentRoleDenied({ personId: context.actor.personId })),
  assignApplicant: () => Effect.die("unexpected assignApplicant"),
  readSchedulingBoard: (context: { readonly actor: RecruitmentActor }) =>
    context.actor._tag !== "GlobalAdmin" && context.actor.active
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readSchedulingBoard", actor: context.actor });
          return schedulingBoard;
        })
      : Effect.fail(new RecruitmentRoleDenied({ personId: context.actor.personId })),
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
    | Database
    | Admissions
    | Economy
    | Organization
    | Profile
    | RecruitmentService
    | Schools
    | Identity
    | IdentitySnapshot
    | OAuthCredentialAuthority
    | ServicePrincipalGrantAuthority
    | ContentManagement
    | Content
  >,
): Promise<A> =>
  runTestPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(OrganizationService, organization),
      Effect.provideService(RecruitmentService, recruitment),
      Effect.provideService(Identity, {
        signIn: () => Promise.reject(new Error("unexpected sign-in")),
        resolveSession: async (cookieHeader: string | undefined) => {
          const tokenValue = cookieHeader
            ?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("better-auth.session_token="))
            ?.slice("better-auth.session_token=".length);
          if (tokenValue !== undefined && tokenValue in membershipsByToken) {
            return new IdentityActor({
              personId: PersonId.make(personIdForToken(tokenValue)),
              sessionId: "session-1",
              expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
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
      } satisfies IdentityShape),
    ) as Effect.Effect<A, E>,
  );

const backend = makeBackendHttp(config, run, {
  handle: async () => new Response(null, { status: 404 }),
  recordTrustedOriginRejection: async () => undefined,
});

const request = (pathname: string, sessionValue: string): Promise<Response> =>
  backend.fetch(
    new Request(`http://backend.test${pathname}`, {
      headers: { cookie: `better-auth.session_token=${sessionValue}` },
    }),
  );

describe("recruitment actors from authorized departments (spec 0055)", () => {
  beforeEach(() => {
    recruitmentCalls.length = 0;
  });

  it("allows a DepartmentLeader to read the canonical assignment board once", async () => {
    const response = await request(
      "/api/recruitment/application-assignments?status=new",
      leaderToken,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(assignmentBoard);
    expect(recruitmentCalls).toEqual([
      {
        operation: "readAssignmentBoard",
        actor: expect.objectContaining({
          _tag: "DepartmentLeader",
          personId: "leader-1",
          departmentId: "department-1",
          active: true,
        }),
      },
    ]);
  });

  it("denies a plain active member from the assignment board", async () => {
    const response = await request(
      "/api/recruitment/application-assignments?status=new",
      memberToken,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
      code: "authority.denied",
    });
    expect(recruitmentCalls).toEqual([]);
  });

  it("denies an anonymous assignment-board caller before any domain call", async () => {
    const response = await request("/api/recruitment/application-assignments?status=new", "");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:credential.invalid",
      title: "Invalid credential",
      status: 401,
      detail: "The supplied credential is invalid.",
      code: "credential.invalid",
    });
    expect(recruitmentCalls).toEqual([]);
  });

  it("allows an active department member to read the scheduling board once", async () => {
    const response = await request("/api/recruitment/interviews", memberToken);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(schedulingBoard);
    expect(recruitmentCalls).toEqual([
      {
        operation: "readSchedulingBoard",
        actor: expect.objectContaining({
          _tag: "Member",
          personId: "member-1",
          departmentId: "department-1",
          active: true,
        }),
      },
    ]);
  });

  it("rejects an inactive department member from the scheduling board", async () => {
    const response = await request("/api/recruitment/interviews", inactiveToken);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:credential.invalid",
      title: "Invalid credential",
      status: 401,
      detail: "The supplied credential is invalid.",
      code: "credential.invalid",
    });
    expect(recruitmentCalls).toEqual([]);
  });

  it("denies an anonymous scheduling-board caller before any domain call", async () => {
    const response = await request("/api/recruitment/interviews", "");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:credential.invalid",
      title: "Invalid credential",
      status: 401,
      detail: "The supplied credential is invalid.",
      code: "credential.invalid",
    });
    expect(recruitmentCalls).toEqual([]);
  });
});
