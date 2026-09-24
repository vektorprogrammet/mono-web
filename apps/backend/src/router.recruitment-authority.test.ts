import { backendDatabase } from "../test/database.js";
import {
  AdmissionPeriodId,
  AdmissionPeriodActorSchema,
} from "@vektorprogrammet/domain/admission-period";
import type { RecruitmentAssignmentBoardQuery } from "@vektorprogrammet/domain/recruitment";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";

import {
  DepartmentId,
  MembershipId,
  TeamId,
  Organization,
  PersonId,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import {
  Recruitment as RecruitmentService,
  RecruitmentRoleDenied,
  type RecruitmentActor,
  type RecruitmentOperations,
} from "@vektorprogrammet/domain/recruitment";
import { SocialEvents } from "@vektorprogrammet/domain/social-events";
import { SchoolSurveys } from "@vektorprogrammet/domain";
import { Predicate, DateTime, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeBackendConfig } from "./config.js";
import { makeBackendTestHttp as backendHttpHandler } from "./test/native-http.js";

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

const config = decodeBackendConfig(environment);

const database = backendDatabase();

interface AuthorityMembershipRow {
  readonly departmentId: string;
  readonly active: boolean;
  readonly teamLeader: boolean;
}

/** One authority projection per session token, selected by the cookie value. */
const membershipsByToken = new Map<string, ReadonlyArray<AuthorityMembershipRow>>([
  [
    leaderToken,
    [{ departmentId: DepartmentId.make("department-1"), active: true, teamLeader: true }],
  ],
  [
    memberToken,
    [{ departmentId: DepartmentId.make("department-1"), active: true, teamLeader: false }],
  ],
  [
    inactiveToken,
    [{ departmentId: DepartmentId.make("department-1"), active: false, teamLeader: false }],
  ],
]);

const personIdsByToken = new Map<string, string>([
  [leaderToken, "leader-1"],
  [memberToken, "member-1"],
  [inactiveToken, "inactive-1"],
]);

const personIdForToken = (tokenValue: string): string =>
  personIdsByToken.get(tokenValue) ?? "unknown-person";

const organization = {
  listDepartments: Effect.succeed([]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: (personId: PersonId) => {
    const row = membershipsByToken
      .entries()
      .find(([token]) => personIdForToken(token) === personId);

    return Effect.succeed({
      personId,
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: (row?.[1] ?? []).map((membership, index) => ({
        membershipId: MembershipId.make(`membership-${index}`),
        teamId: TeamId.make(`team-${index}`),
        departmentId: DepartmentId.make(membership.departmentId),
        active: membership.active,
        teamLeader: membership.teamLeader,
      })),
    });
  },
} satisfies Partial<OrganizationOperations>;

const recruitmentCalls: Array<{
  readonly operation: string;
  readonly actor: unknown;
}> = [];

const assignmentBoard = {
  admissionPeriodId: AdmissionPeriodId.make("period-1"),
  departmentId: DepartmentId.make("department-1"),
  candidates: [],
  interviewers: [],
  interviewSchemas: [],
};

const schedulingBoard = {
  departmentId: DepartmentId.make("department-1"),
  interviews: [],
};

// Models the frozen domain laws: assignment reads require an active DepartmentLeader;
// scheduling reads require an active department member.
const recruitment = {
  readPersonAuthoritySources: () => Effect.succeed([]),
  readAssignmentBoard: (
    query: RecruitmentAssignmentBoardQuery,
    context: { readonly actor: RecruitmentActor },
  ) =>
    context.actor.active && Predicate.isTagged(context.actor, "DepartmentLeader")
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readAssignmentBoard", actor: context.actor });
          void query;

          return assignmentBoard;
        })
      : Effect.fail(new RecruitmentRoleDenied({ personId: PersonId.make(context.actor.personId) })),
  assignApplicant: () => Effect.die("unexpected assignApplicant"),
  readSchedulingBoard: (context: { readonly actor: RecruitmentActor }) =>
    !Predicate.isTagged(context.actor, "GlobalAdmin") && context.actor.active
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readSchedulingBoard", actor: context.actor });

          return schedulingBoard;
        })
      : Effect.fail(new RecruitmentRoleDenied({ personId: PersonId.make(context.actor.personId) })),
  scheduleInterview: () => Effect.die("unexpected scheduleInterview"),
  readInvitationResponse: () => Effect.die("unexpected readInvitationResponse"),
  confirmInvitation: () => Effect.die("unexpected confirmInvitation"),
  rejectInvitation: () => Effect.die("unexpected rejectInvitation"),
  requestNewInvitationTime: () => Effect.die("unexpected requestNewInvitationTime"),
} satisfies Partial<RecruitmentOperations>;

const socialEvents = SocialEvents.of({
  readSnapshotInstant: () => Effect.die("unexpected social-event read"),
  readScope: () => Effect.die("unexpected social-event read"),
  readList: () => Effect.die("unexpected social-event read"),
  validateScope: () => Effect.die("unexpected social-event validation"),
  create: () => Effect.die("unexpected social-event create"),
});

const schoolSurveys = SchoolSurveys.of({
  readForm: () => Effect.die("unexpected school-survey read"),
  prepareResponse: () => Effect.die("unexpected school-survey preparation"),
  persistResponse: () => Effect.die("unexpected school-survey persistence"),
  readAdminCatalog: () => Effect.die("unexpected school-survey administration catalog"),
  readAdminSurvey: () => Effect.die("unexpected school-survey administration read"),
  listAdminSurveys: () => Effect.die("unexpected school-survey administration list"),
  createAdminSurvey: () => Effect.die("unexpected school-survey administration create"),
  closeAdminSurvey: () => Effect.die("unexpected school-survey administration close"),
  readAdminResults: () => Effect.die("unexpected school-survey administration results"),
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookieHeader: string | undefined) => {
    const tokenValue = cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("better-auth.session_token="))
      ?.slice("better-auth.session_token=".length);

    if (tokenValue !== undefined && membershipsByToken.has(tokenValue)) {
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
} satisfies IdentityOperations);

const backendServices = Layer.mergeAll(
  database.layer,
  Layer.mock(Organization, organization),
  Layer.mock(RecruitmentService, recruitment),
  Layer.succeed(SocialEvents, socialEvents),
  Layer.succeed(SchoolSurveys, schoolSurveys),
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const backend = backendHttpHandler(config, backendServices, {
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
        actor: expect.objectContaining(
          AdmissionPeriodActorSchema.cases.DepartmentLeader.make({
            personId: PersonId.make("leader-1"),
            departmentId: DepartmentId.make("department-1"),
            active: true,
          }),
        ),
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
        actor: expect.objectContaining(
          AdmissionPeriodActorSchema.cases.Member.make({
            personId: PersonId.make("member-1"),
            departmentId: DepartmentId.make("department-1"),
            active: true,
          }),
        ),
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
