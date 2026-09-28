import { Admissions } from "@vektorprogrammet/domain";
import {
  AdmissionPeriodActorSchema,
  AdmissionPeriodId,
} from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  MembershipId,
  Organization,
  PersonId,
  TeamId,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import {
  Recruitment,
  RecruitmentRoleDenied,
  type RecruitmentActor,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentOperations,
} from "@vektorprogrammet/domain/recruitment";
import { isProblem, type Problem } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer, Predicate } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const leaderToken = "leader-session-token";

const memberToken = "member-session-token";

const inactiveToken = "inactive-session-token";

const unassignedToken = "unassigned-session-token";

// Leads department-1 after the person's global-administrator grant has ended.
const formerAdministratorToken = "former-administrator-session-token";

interface AuthorityMembershipRow {
  readonly departmentId: string;
  readonly active: boolean;
  /** Leads the board of the (independent) department; an ordinary team leader has no reach. */
  readonly boardLeader: boolean;
}

/** One authority projection per session token, selected by the cookie value. */
const membershipsByToken = new Map<string, ReadonlyArray<AuthorityMembershipRow>>([
  [leaderToken, [{ departmentId: "department-1", active: true, boardLeader: true }]],
  [memberToken, [{ departmentId: "department-1", active: true, boardLeader: false }]],
  [inactiveToken, [{ departmentId: "department-1", active: false, boardLeader: false }]],
  [unassignedToken, []],
  [formerAdministratorToken, [{ departmentId: "department-1", active: true, boardLeader: true }]],
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

const recruitmentCalls: Array<{ readonly operation: string; readonly actor: unknown }> = [];

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

const schedulingBoard = { departmentId: DepartmentId.make("department-1"), interviews: [] };

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
      : Effect.fail(
          RecruitmentRoleDenied.make({ personId: PersonId.make(context.actor.personId) }),
        ),
  readSchedulingBoard: (context: { readonly actor: RecruitmentActor }) =>
    !Predicate.isTagged(context.actor, "GlobalAdmin") && context.actor.active
      ? Effect.sync(() => {
          recruitmentCalls.push({ operation: "readSchedulingBoard", actor: context.actor });

          return schedulingBoard;
        })
      : Effect.fail(
          RecruitmentRoleDenied.make({ personId: PersonId.make(context.actor.personId) }),
        ),
} satisfies Partial<RecruitmentOperations>;

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
          IdentityActor.make({
            personId: PersonId.make(personIdForToken(tokenValue)),
            sessionId: "session-1",
            expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
          }),
        )
      : Effect.fail(IdentitySessionNotFound.make({}));
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

const backend = makeBackendTestRpc({
  config: backendTestConfig,
  services: Layer.mergeAll(
    Layer.mock(Organization, organization),
    Layer.mock(Recruitment, recruitment),
    Layer.mock(Admissions, admissions),
    Layer.succeed(Identity, identity),
  ),
});

/** Runs one call with the session cookie of `token`; an empty token presents none. */
const as = <A, E, R>(effect: Effect.Effect<A, E, R>, token: string) =>
  token === ""
    ? effect
    : RpcClient.withHeaders(effect, { cookie: `better-auth.session_token=${token}` });

/** The problem code of a failed call; a transport failure has none. */
const codeOf = (failure: Problem | RpcClientError) =>
  isProblem(failure) ? failure.code : "defect";

const leaderOf = (personId: string) =>
  expect.objectContaining(
    AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
      personId: PersonId.make(personId),
      departmentId: DepartmentId.make("department-1"),
      active: true,
    }),
  );

describe("recruitment actors from authorized departments (spec 0055)", () => {
  beforeEach(() => {
    recruitmentCalls.length = 0;
  });

  it.live("allows a DepartmentAdministrator to read the canonical assignment board once", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      expect(
        yield* as(client["recruitment.readAssignmentBoard"]({ status: "new" }), leaderToken),
      ).toEqual(assignmentBoard);
      expect(recruitmentCalls).toEqual([
        { operation: "readAssignmentBoard", actor: leaderOf("leader-1") },
      ]);
    }),
  );

  it.live("denies a plain active member from the assignment board", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const denied = yield* as(
        client["recruitment.readAssignmentBoard"]({ status: "new" }),
        memberToken,
      ).pipe(Effect.flip);

      expect(codeOf(denied)).toBe("authority.denied");
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  it.live("denies an anonymous assignment-board caller before any domain call", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const denied = yield* as(
        client["recruitment.readAssignmentBoard"]({ status: "new" }),
        "",
      ).pipe(Effect.flip);

      expect(codeOf(denied)).toBe("credential.missing");
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  it.live("allows an active department member to read the scheduling board once", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      expect(yield* as(client["recruitment.readSchedulingBoard"](), memberToken)).toEqual(
        schedulingBoard,
      );
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
      const client = yield* backend.client;

      const denied = yield* as(client["recruitment.readSchedulingBoard"](), inactiveToken).pipe(
        Effect.flip,
      );

      expect(codeOf(denied)).toBe("authority.denied");
      expect(recruitmentCalls).toEqual([]);
    }),
  );

  // A credential problem tells the dashboard that the session expired, and it signs the person out.
  it.live(
    "denies an authenticated person without a department instead of rejecting the session",
    () =>
      Effect.gen(function* () {
        const client = yield* backend.client;

        const [board, admissionPeriods] = yield* Effect.all(
          [
            as(client["recruitment.readSchedulingBoard"](), unassignedToken).pipe(Effect.flip),
            as(client["admissions.listAdmissionPeriods"](), unassignedToken).pipe(Effect.flip),
          ],
          { concurrency: "unbounded" },
        );

        expect([codeOf(board), codeOf(admissionPeriods)]).toEqual([
          "authority.denied",
          "authority.denied",
        ]);
        expect(recruitmentCalls).toEqual([]);
      }),
  );

  it.live("keeps a department leadership after the leader's administrator grant has ended", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      yield* as(client["admissions.listAdmissionPeriods"](), formerAdministratorToken);
      yield* as(
        client["recruitment.readAssignmentBoard"]({ status: "new" }),
        formerAdministratorToken,
      );

      expect(recruitmentCalls).toEqual([
        {
          operation: "listAdmissionPeriodsForManagement",
          actor: leaderOf("former-administrator-1"),
        },
        { operation: "readAssignmentBoard", actor: leaderOf("former-administrator-1") },
      ]);
    }),
  );

  it.live("denies an anonymous scheduling-board caller before any domain call", () =>
    Effect.gen(function* () {
      const client = yield* backend.client;

      const denied = yield* client["recruitment.readSchedulingBoard"]().pipe(Effect.flip);

      expect(codeOf(denied)).toBe("credential.missing");
      expect(recruitmentCalls).toEqual([]);
    }),
  );
});
