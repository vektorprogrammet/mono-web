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
import { Admissions } from "@vektorprogrammet/domain";
import { NativeProblem } from "@vektorprogrammet/http-api";
import { Predicate, DateTime, Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { decodeBackendConfig } from "./config.js";
import { makeBackendTestHttp as backendHttpHandler } from "./test/native-http.js";

const leaderToken = "leader-session-token";

const memberToken = "member-session-token";

const inactiveToken = "inactive-session-token";

const unassignedToken = "unassigned-session-token";

// Leads department-1 after the person's global-administrator grant has ended.
const formerAdministratorToken = "former-administrator-session-token";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
} as const;

const config = Effect.runSync(decodeBackendConfig(environment));

const database = backendDatabase();

interface AuthorityMembershipRow {
  readonly departmentId: string;
  readonly active: boolean;
  /** Leads the board of the (independent) department; an ordinary team leader has no reach. */
  readonly boardLeader: boolean;
}

/** One authority projection per session token, selected by the cookie value. */
const membershipsByToken = new Map<string, ReadonlyArray<AuthorityMembershipRow>>([
  [
    leaderToken,
    [{ departmentId: DepartmentId.make("department-1"), active: true, boardLeader: true }],
  ],
  [
    memberToken,
    [{ departmentId: DepartmentId.make("department-1"), active: true, boardLeader: false }],
  ],
  [
    inactiveToken,
    [{ departmentId: DepartmentId.make("department-1"), active: false, boardLeader: false }],
  ],
  [unassignedToken, []],
  [
    formerAdministratorToken,
    [{ departmentId: DepartmentId.make("department-1"), active: true, boardLeader: true }],
  ],
]);

const personIdsByToken = new Map<string, string>([
  [leaderToken, "leader-1"],
  [memberToken, "member-1"],
  [inactiveToken, "inactive-1"],
  [unassignedToken, "unassigned-1"],
  [formerAdministratorToken, "former-administrator-1"],
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
      globalAdministrator:
        personId === personIdForToken(formerAdministratorToken) ? "Inactive" : "Absent",
      memberships: (row?.[1] ?? []).map((membership, index) => ({
        membershipId: MembershipId.make(`membership-${index}`),
        teamId: TeamId.make(`team-${index}`),
        departmentId: DepartmentId.make(membership.departmentId),
        active: membership.active,
        unitLeader: membership.boardLeader,
        unitKind: membership.boardLeader ? "DepartmentBoard" : "Team",
        teamScope: "HomeDepartment",
        departmentIndependent: true,
      })),
      nationalBoardSeats: [],
      delegations: [],
    });
  },
} satisfies Partial<OrganizationOperations>;

const recruitmentCalls: Array<{
  readonly operation: string;
  readonly actor: unknown;
}> = [];

const admissions = {
  listAdmissionPeriodsForManagement: ({ actor }: { readonly actor: unknown }) =>
    Effect.sync(() => {
      recruitmentCalls.push({ operation: "listAdmissionPeriodsForManagement", actor });

      return [];
    }),
};

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

// Models the frozen domain laws: assignment reads require an active DepartmentAdministrator;
// scheduling reads require an active department member.
const recruitment = {
  readPersonAuthoritySources: () => Effect.succeed([]),
  readAssignmentBoard: (
    query: RecruitmentAssignmentBoardQuery,
    context: { readonly actor: RecruitmentActor },
  ) =>
    context.actor.active && Predicate.isTagged(context.actor, "DepartmentAdministrator")
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
  readSnapshotInstant: Effect.die("unexpected social-event read"),
  readScope: () => Effect.die("unexpected social-event read"),
  readList: () => Effect.die("unexpected social-event read"),
  validateScope: () => Effect.die("unexpected social-event validation"),
  create: () => Effect.die("unexpected social-event create"),
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) => {
    const tokenValue = cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("better-auth.session_token="))
      ?.slice("better-auth.session_token=".length);

    return tokenValue !== undefined && membershipsByToken.has(tokenValue)
      ? Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(personIdForToken(tokenValue)),
            sessionId: "session-1",
            expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
          }),
        )
      : Effect.fail(new IdentitySessionNotFound());
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

const backendServices = Layer.mergeAll(
  database.layer,
  Layer.mock(Organization, organization),
  Layer.mock(RecruitmentService, recruitment),
  Layer.mock(Admissions, admissions),
  Layer.succeed(SocialEvents, socialEvents),
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const backend = backendHttpHandler(config, backendServices, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
});

const request = (pathname: string, sessionValue: string): Effect.Effect<Response> =>
  backend.fetch(
    new Request(`http://backend.test${pathname}`, {
      headers: { cookie: `better-auth.session_token=${sessionValue}` },
    }),
  );

const problem = (response: Response) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(NativeProblem)(
      yield* Effect.promise(() => response.json()),
    );

    return { status: response.status, code: decoded.code };
  });

describe("recruitment actors from authorized departments (spec 0055)", () => {
  beforeEach(() => {
    recruitmentCalls.length = 0;
  });

  it.live("allows a DepartmentAdministrator to read the canonical assignment board once", () =>
    Effect.gen(function* () {
      const response = yield* request(
        "/api/recruitment/application-assignments?status=new",
        leaderToken,
      );

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual(assignmentBoard);
      expect(recruitmentCalls).toEqual([
        {
          operation: "readAssignmentBoard",
          actor: expect.objectContaining(
            AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
              personId: PersonId.make("leader-1"),
              departmentId: DepartmentId.make("department-1"),
              active: true,
            }),
          ),
        },
      ]);
    }),
  );

  it.live("denies a plain active member from the assignment board", () =>
    Effect.gen(function* () {
      const response = yield* request(
        "/api/recruitment/application-assignments?status=new",
        memberToken,
      );

      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
        title: "Authority denied",
        status: 403,
        detail: "The authenticated principal is not permitted to perform this operation.",
        code: "authority.denied",
      });
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  it.live("denies an anonymous assignment-board caller before any domain call", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recruitment/application-assignments?status=new", "");
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
        title: "Credential required",
        status: 401,
        detail: "A credential is required for this operation.",
        code: "credential.missing",
      });
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  it.live("allows an active department member to read the scheduling board once", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recruitment/interviews", memberToken);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual(schedulingBoard);
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
    }),
  );

  it.live("denies an inactive department member from the scheduling board", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recruitment/interviews", inactiveToken);

      expect(yield* problem(response)).toEqual({ status: 403, code: "authority.denied" });
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  // A 401 tells the dashboard that the session expired, and it signs the person out.
  it.live(
    "denies an authenticated person without a department instead of rejecting the session",
    () =>
      Effect.gen(function* () {
        const [board, admissionPeriods] = yield* Effect.all(
          [
            request("/api/recruitment/interviews", unassignedToken),
            request("/api/admission-periods", unassignedToken),
          ],
          { concurrency: "unbounded" },
        );

        expect([yield* problem(board), yield* problem(admissionPeriods)]).toEqual([
          { status: 403, code: "authority.denied" },
          { status: 403, code: "authority.denied" },
        ]);
        expect(recruitmentCalls).toEqual([]);
      }),
  );

  it.live("lists admission periods in a department leader's own department without a scope", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/admission-periods", leaderToken);

      expect(response.status).toBe(200);
      expect(recruitmentCalls).toEqual([
        {
          operation: "listAdmissionPeriodsForManagement",
          actor: expect.objectContaining(
            AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
              personId: PersonId.make("leader-1"),
              departmentId: DepartmentId.make("department-1"),
              active: true,
            }),
          ),
        },
      ]);
    }),
  );

  it.live("keeps a department leadership after the leader's administrator grant has ended", () =>
    Effect.gen(function* () {
      const [admissionPeriods, board] = [
        yield* request("/api/admission-periods", formerAdministratorToken),
        yield* request(
          "/api/recruitment/application-assignments?status=new",
          formerAdministratorToken,
        ),
      ];

      const leader = expect.objectContaining(
        AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
          personId: PersonId.make("former-administrator-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
        }),
      );

      expect([admissionPeriods.status, board.status]).toEqual([200, 200]);
      expect(recruitmentCalls).toEqual([
        { operation: "listAdmissionPeriodsForManagement", actor: leader },
        { operation: "readAssignmentBoard", actor: leader },
      ]);
    }),
  );

  it.live("denies an anonymous scheduling-board caller before any domain call", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recruitment/interviews", "");
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
        title: "Credential required",
        status: 401,
        detail: "A credential is required for this operation.",
        code: "credential.missing",
      });
      expect(recruitmentCalls).toEqual([]);
    }),
  );
});
