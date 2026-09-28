import { IdentitySnapshot } from "@vektorprogrammet/database";
import {
  AdmissionPeriodActorSchema,
  InactiveActor,
} from "@vektorprogrammet/domain/admission-period";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  CredentialOutcomeSchema,
  DomainId,
  GrantId,
  PrincipalSchema,
  RequirementId,
  Scope,
  decodeGrant,
  evaluateAccess,
  evaluateRequirement,
} from "@vektorprogrammet/domain/authz";
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
  OrganizationPersistenceError,
  PersonId,
  TeamId,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import { ProfileContactNotFound } from "@vektorprogrammet/domain/profile";
import {
  InterviewQuestionsUnavailable,
  InterviewSchemaId,
  Recruitment,
  RecruitmentAdmissionPeriodNotFound,
  RecruitmentAmbiguousAdmissionPeriod,
  RecruitmentApplicationAlreadyAssigned,
  RecruitmentApplicationNotFound,
  RecruitmentAssignmentCommandConflict,
  RecruitmentAssignmentCommandId,
  RecruitmentConductCommandId,
  RecruitmentConductValidationError,
  RecruitmentDecodeError,
  RecruitmentInactiveActor,
  RecruitmentInterviewAlreadyCancelled,
  RecruitmentInterviewAlreadyFinalized,
  RecruitmentInterviewAlreadyScheduled,
  RecruitmentInterviewerNotEligible,
  RecruitmentInterviewId,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewNotScheduled,
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewSchemaNotFound,
  RecruitmentInterviewStaleRevision,
  RecruitmentInvalidContext,
  RecruitmentInvitationAlreadyResponded,
  RecruitmentInvitationHttpSnapshotSchema,
  RecruitmentInvitationId,
  RecruitmentInvitationNotAccepted,
  RecruitmentInvitationNotFound,
  RecruitmentInvitationTransition,
  RecruitmentLifecycleCommandConflict,
  RecruitmentPersistenceError,
  RecruitmentRoleDenied,
  RecruitmentScheduleCommandConflict,
  RecruitmentScheduleCommandId,
  RecruitmentScheduleInPast,
  RecruitmentSchedulingBoardSchema,
  RecruitmentScopeDenied,
  type RecruitmentFailure,
  type RecruitmentOperations,
} from "@vektorprogrammet/domain/recruitment";
import { ReadInterviewReport, SchedulingBoard, reflectAccessSpec } from "@vektorprogrammet/rpc";
import { IdempotencyKey, isProblem, type Problem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer, Option, Predicate, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "@effect/vitest";
import { backendTestConfig } from "../../test/config.js";
import { PreconditionDecision, evaluateMutationPrecondition } from "../http-semantics.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";
import { recruitmentInterviewAccessContext } from "./access.js";
import { interviewETag, invitationETag, schedulingBoardWithETags } from "./representation.js";

const at = "2031-09-15T12:00:00.000Z";

const departmentId = DepartmentId.make("rpc-department");

const leaderId = PersonId.make("rpc-leader");

const observation = {
  scheduledAt: "2031-09-20T10:00:00.000Z",
  room: "A101",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;

const snapshot = Schema.decodeSync(RecruitmentInvitationHttpSnapshotSchema)({
  source: {
    capabilitySha256: "a".repeat(64),
    invitationId: "rpc-invitation",
    interviewId: "rpc-interview",
    departmentId,
    scheduleRevision: 2,
    responseRevision: 0,
    responseState: "Pending",
    supersededAt: null,
  },
  observation,
});

/** The failure every domain call answers; without one, an invitation reads and answers. */
let injected: RecruitmentFailure | undefined;

const transitions: Array<RecruitmentInvitationTransition> = [];

const injectedFailure = () =>
  Effect.suspend(() =>
    injected === undefined ? Effect.die("no recruitment failure injected") : Effect.fail(injected),
  );

const recruitment = {
  readInvitationSnapshot: () =>
    Effect.suspend(() =>
      injected === undefined ? Effect.succeed(snapshot) : Effect.fail(injected),
    ),
  transitionInvitation: ({
    transition,
  }: {
    readonly transition: RecruitmentInvitationTransition;
  }) =>
    Effect.suspend(() => {
      if (injected !== undefined) return Effect.fail(injected);

      transitions.push(transition);

      return Effect.succeed({ ...snapshot, source: { ...snapshot.source, responseRevision: 1 } });
    }),
  readAssignmentBoard: injectedFailure,
  readSchedulingBoard: injectedFailure,
  resolveInterviewReportLeader: injectedFailure,
  prepareAssignment: injectedFailure,
  prepareInterview: injectedFailure,
} satisfies Partial<RecruitmentOperations>;

/** The session's person leads the board of the one department. */
const organization = {
  resolvePersonAuthority: (personId: PersonId) =>
    Effect.succeed({
      personId,
      evaluatedAt: at,
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: MembershipId.make("rpc-board-membership"),
          teamId: TeamId.make("rpc-board"),
          departmentId,
          active: true,
          unitLeader: true,
          unitKind: "DepartmentBoard",
          teamScope: "HomeDepartment",
          departmentIndependent: true,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    }),
} satisfies Partial<OrganizationOperations>;

/** A session cookie whose session has ended. */
const expiredSession = "rpc-expired";

const sessionActor = (cookie: string | undefined) => {
  const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

  return person === undefined || person === expiredSession
    ? undefined
    : IdentityActor.make({
        personId: PersonId.make(person),
        sessionId: `session-${person}`,
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      });
};

const resolveSession = (cookie: string | undefined) => {
  const actor = sessionActor(cookie);

  return actor === undefined
    ? Effect.fail(IdentitySessionNotFound.make({}))
    : Effect.succeed(actor);
};

const identitySnapshot = IdentitySnapshot.of({
  resolveSession,
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession,
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

/** The recruitment RPCs as a department leader reaches them. */
const fixture = () =>
  Effect.gen(function* () {
    const backend = makeBackendTestRpc({
      config: {
        ...backendTestConfig,
        recruitment: {
          maxBodyBytes: 256,
          now: () => at,
          nextInterviewId: () => RecruitmentInterviewId.make("rpc-unexpected-interview"),
          nextInvitationId: () => RecruitmentInvitationId.make("rpc-unexpected-invitation"),
          nextResponseCapability: () => "unexpected".padEnd(43, "_"),
        },
      },
      services: Layer.mergeAll(
        Layer.mock(Recruitment, recruitment),
        Layer.mock(Organization, organization),
        Layer.succeed(IdentitySnapshot, identitySnapshot),
        Layer.succeed(Identity, identity),
      ),
    });

    const client = yield* backend.client;

    /** Runs one call with the leader's session cookie. */
    const asLeader = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      RpcClient.withHeaders(effect, { cookie: `better-auth.session_token=${leaderId}` });

    return { client, asLeader };
  });

type Client = Effect.Success<ReturnType<typeof fixture>>["client"];

const capability = "rpc".padEnd(43, "_");

const anyValidator = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');

const key = IdempotencyKey.make("rpc-command".padEnd(22, "0"));

const interviewId = RecruitmentInterviewId.make("rpc-interview");

/**
 * Every call that a failure case exercises, by name: a person call with the leader's session, and
 * an invitation response with its capability alone.
 */
const calls = (
  client: Client,
  asLeader: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) => ({
  schedulingBoard: () => asLeader(client["recruitment.readSchedulingBoard"]()),
  assignmentBoard: () => asLeader(client["recruitment.readAssignmentBoard"]({ status: "new" })),
  interviewConduct: () => asLeader(client["recruitment.readInterviewConduct"]({ interviewId })),
  interviewReport: () => asLeader(client["recruitment.readInterviewReport"]({})),
  createInterview: () =>
    asLeader(
      client["recruitment.createApplicationInterview"]({
        applicationId: PublicApplicationIdSchema.make("rpc-application"),
        idempotencyKey: key,
        request: {
          interviewerPersonId: leaderId,
          interviewSchemaId: InterviewSchemaId.make("rpc-schema"),
        },
      }),
    ),
  scheduleInterview: () =>
    asLeader(
      client["recruitment.scheduleInterview"]({
        interviewId,
        idempotencyKey: key,
        ifMatch: anyValidator,
        request: {
          scheduledAt: "2031-09-20T10:00:00.000Z",
          room: "A101",
          campus: null,
          mapLink: null,
          message: "Velkommen.",
        },
      }),
    ),
  finalizeInterview: () =>
    asLeader(
      client["recruitment.finalizeInterview"]({
        interviewId,
        idempotencyKey: key,
        ifMatch: anyValidator,
        request: {
          answers: [{ questionId: "q-1", answer: "Svar" }],
          score: { explanatoryPower: 4, roleModel: 5, suitability: 6 },
          recommendation: "Ja",
        },
      }),
    ),
  invitationResponse: () => client["recruitment.readInvitationResponse"]({ capability }),
  rejectInvitation: () =>
    client["recruitment.rejectInvitation"]({
      capability,
      ifMatch: invitationETag(snapshot.source),
      request: {},
    }),
});

/** One call of any recruitment RPC. */
type AnyCall = Effect.Effect<unknown, Problem | RpcClientError>;

/** The problem code of a failed call; a transport failure has none. */
const codeOf = (failure: Problem | RpcClientError) =>
  isProblem(failure) ? failure.code : "defect";

/** The problem code that a call answers, or `success`. */
const answeredCode = (call: AnyCall) =>
  call.pipe(Effect.match({ onFailure: codeOf, onSuccess: () => "success" }));

describe("native recruitment RPC boundary", () => {
  it.live("answers an invitation response with its transition and the new entity tag", () =>
    Effect.gen(function* () {
      const { client } = yield* fixture();
      injected = undefined;
      transitions.length = 0;

      const rejected = yield* client["recruitment.rejectInvitation"]({
        capability,
        ifMatch: invitationETag(snapshot.source),
        request: { message: "Another time" },
      });

      expect(transitions).toEqual([
        RecruitmentInvitationTransition.Reject({ message: "Another time" }),
      ]);
      expect(rejected.etag).toBe(invitationETag({ ...snapshot.source, responseRevision: 1 }));

      const stale = yield* client["recruitment.confirmInvitation"]({
        capability,
        ifMatch: anyValidator,
      }).pipe(Effect.flip);

      expect(codeOf(stale)).toBe("precondition.failed");

      // A malformed capability names no invitation, as an unknown one does.
      const malformed = yield* client["recruitment.readInvitationResponse"]({
        capability: "",
      }).pipe(Effect.flip);

      expect(codeOf(malformed)).toBe("resource.not-found");
      expect(transitions).toHaveLength(1);
    }),
  );

  it.live("reads the invitation with the strong entity tag that a response takes", () =>
    Effect.gen(function* () {
      const { client } = yield* fixture();
      injected = undefined;

      expect(yield* client["recruitment.readInvitationResponse"]({ capability })).toEqual({
        observation,
        etag: invitationETag(snapshot.source),
      });
    }),
  );

  it.live("rejects an invitation capability presented beside a session cookie or a bearer", () =>
    Effect.gen(function* () {
      const { client } = yield* fixture();
      injected = undefined;
      transitions.length = 0;

      const ifMatch = invitationETag(snapshot.source);

      // The capability is the request's one credential in every invitation operation.
      const operations: ReadonlyArray<readonly [string, AnyCall]> = [
        ["read", client["recruitment.readInvitationResponse"]({ capability })],
        ["confirm", client["recruitment.confirmInvitation"]({ capability, ifMatch })],
        ["reject", client["recruitment.rejectInvitation"]({ capability, ifMatch, request: {} })],
        [
          "request-new-time",
          client["recruitment.requestNewInvitationTime"]({
            capability,
            ifMatch,
            request: { message: "Kan vi møtes torsdag?" },
          }),
        ],
      ];

      for (const [header, credential] of [
        ["cookie", `theme=dark; better-auth.session_token=${leaderId}`],
        ["authorization", "Bearer rpc-leader-bearer"],
      ] as const) {
        for (const [operation, call] of operations) {
          const code = yield* RpcClient.withHeaders(call, { [header]: credential }).pipe(
            answeredCode,
          );

          expect({ operation, header, code }).toEqual({
            operation,
            header,
            code: "credential.invalid",
          });
        }
      }

      expect(transitions).toEqual([]);

      // A cookie without a session is no second credential.
      const read = yield* RpcClient.withHeaders(
        client["recruitment.readInvitationResponse"]({ capability }),
        { cookie: "theme=dark" },
      );

      expect(read.etag).toBe(ifMatch);
    }),
  );

  it("exposes mutation-compatible strong ETags on scheduling items", () => {
    const board = Schema.decodeSync(RecruitmentSchedulingBoardSchema)(
      {
        departmentId: "department-1",
        interviews: [
          {
            interviewId: "interview-1",
            applicationId: "application-1",
            departmentId: "department-1",
            interviewer: {
              personId: "interviewer-1",
              displayName: "Ivar Interviewer",
              email: "ivar@example.org",
              phone: "+47 900 00 001",
            },
            coInterviewer: null,
            applicant: {
              applicationId: "application-1",
              applicantId: "applicant-1",
              firstName: "Ada",
              lastName: "Applicant",
              email: "ada@example.org",
              phone: "+47 900 00 002",
            },
            revision: 2,
            schedule: null,
            notificationState: null,
            responseState: null,
            responseMessage: null,
          },
        ],
      },
      { onExcessProperty: "error" },
    );

    const authority = [
      { kind: "Membership" as const, identity: "membership-1", revisions: [4, 5, 6] },
    ];

    expect(() =>
      Schema.decodeUnknownSync(SchedulingBoard)(board, { onExcessProperty: "error" }),
    ).toThrow();

    const tagged = schedulingBoardWithETags({ board, authority });

    const decoded = Schema.decodeSync(SchedulingBoard)(tagged, { onExcessProperty: "error" });

    const boardTag = decoded.interviews[0]!.etag;

    const mutationTag = interviewETag({
      interviewId: board.interviews[0]!.interviewId,
      departmentId: board.interviews[0]!.departmentId,
      interviewerPersonId: board.interviews[0]!.interviewer.personId,
      coInterviewerPersonId: null,
      interviewRevision: board.interviews[0]!.revision,
      authority,
    });

    const afterInterviewRevision = schedulingBoardWithETags({
      board: { ...board, interviews: [{ ...board.interviews[0]!, revision: 3 }] },
      authority,
    }).interviews[0]!.etag;

    const afterCoInterviewerChange = schedulingBoardWithETags({
      board: {
        ...board,
        interviews: [
          {
            ...board.interviews[0]!,
            coInterviewer: {
              personId: PersonId.make("co-interviewer-1"),
              displayName: "Cora Co-interviewer",
            },
          },
        ],
      },
      authority,
    }).interviews[0]!.etag;

    const afterAuthorityRevision = schedulingBoardWithETags({
      board,
      authority: [{ ...authority[0]!, revisions: [4, 5, 7] }],
    }).interviews[0]!.etag;

    expect(boardTag).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(boardTag).toBe(mutationTag);
    expect(afterInterviewRevision).not.toBe(boardTag);
    expect(afterCoInterviewerChange).not.toBe(boardTag);
    expect(afterAuthorityRevision).not.toBe(boardTag);
    expect(evaluateMutationPrecondition(mutationTag, boardTag)).toEqual(
      PreconditionDecision.Proceed(),
    );
    expect(evaluateMutationPrecondition(afterInterviewRevision, boardTag)).toEqual(
      PreconditionDecision.Failed({ code: "precondition.failed", status: 412 }),
    );
    expect("etag" in tagged).toBe(false);
  });

  it.live("maps recruitment failures to the declared problem vocabulary", () =>
    Effect.gen(function* () {
      const { client, asLeader } = yield* fixture();
      const call = calls(client, asLeader);
      const personId = PersonId.make("fixture-person");
      const failingInterviewId = RecruitmentInterviewId.make("fixture-id");
      const applicationId = PublicApplicationIdSchema.make("fixture-id");
      const interviewSchemaId = InterviewSchemaId.make("fixture-id");

      // Each failure is answered by an operation that declares its problem.
      const cases: ReadonlyArray<readonly [RecruitmentFailure, () => AnyCall, string]> = [
        [RecruitmentInactiveActor.make({ personId }), call.schedulingBoard, "authority.denied"],
        [InactiveActor.make({ personId }), call.schedulingBoard, "authority.denied"],
        [RecruitmentRoleDenied.make({ personId }), call.schedulingBoard, "authority.denied"],
        [
          RecruitmentScopeDenied.make({ personId, departmentId }),
          call.interviewConduct,
          "authority.denied",
        ],
        [
          RecruitmentInterviewerNotEligible.make({ personId, departmentId }),
          call.createInterview,
          "authority.denied",
        ],
        [
          RecruitmentAdmissionPeriodNotFound.make({ departmentId }),
          call.assignmentBoard,
          "recruitment.admission-period-not-found",
        ],
        [
          RecruitmentAmbiguousAdmissionPeriod.make({ departmentId }),
          call.assignmentBoard,
          "application.ambiguous-period",
        ],
        [
          RecruitmentApplicationNotFound.make({ applicationId }),
          call.createInterview,
          "recruitment.application-not-found",
        ],
        [
          RecruitmentInterviewSchemaNotFound.make({ interviewSchemaId }),
          call.createInterview,
          "recruitment.interview-schema-not-found",
        ],
        [
          RecruitmentApplicationAlreadyAssigned.make({ applicationId }),
          call.createInterview,
          "recruitment.application-already-assigned",
        ],
        [
          RecruitmentInterviewSchemaInactive.make({ interviewSchemaId }),
          call.createInterview,
          "recruitment.interview-schema-inactive",
        ],
        [
          RecruitmentAssignmentCommandConflict.make({
            commandId: RecruitmentAssignmentCommandId.make("fixture-id"),
          }),
          call.createInterview,
          "idempotency.digest-conflict",
        ],
        [
          InterviewQuestionsUnavailable.make({ interviewSchemaId, reason: "fixture" }),
          call.createInterview,
          "dependency.unavailable",
        ],
        [
          RecruitmentInterviewNotFound.make({ interviewId: failingInterviewId }),
          call.interviewConduct,
          "recruitment.interview-not-found",
        ],
        [
          RecruitmentInterviewNotScheduled.make({ interviewId: failingInterviewId }),
          call.interviewConduct,
          "recruitment.interview-not-scheduled",
        ],
        [
          RecruitmentInvitationNotAccepted.make({
            interviewId: failingInterviewId,
            responseState: "fixture",
          }),
          call.interviewConduct,
          "recruitment.invitation-not-accepted",
        ],
        [
          RecruitmentInterviewAlreadyScheduled.make({ interviewId: failingInterviewId }),
          call.scheduleInterview,
          "recruitment.already-scheduled",
        ],
        [
          RecruitmentInterviewStaleRevision.make({
            interviewId: failingInterviewId,
            expectedRevision: 1,
            actualRevision: 2,
          }),
          call.scheduleInterview,
          "precondition.failed",
        ],
        [
          RecruitmentScheduleInPast.make({ interviewId: failingInterviewId }),
          call.scheduleInterview,
          "recruitment.schedule-in-past",
        ],
        [
          RecruitmentScheduleCommandConflict.make({
            commandId: RecruitmentScheduleCommandId.make("fixture-id"),
          }),
          call.scheduleInterview,
          "idempotency.digest-conflict",
        ],
        [
          RecruitmentInterviewAlreadyFinalized.make({ interviewId: failingInterviewId }),
          call.finalizeInterview,
          "recruitment.already-finalized",
        ],
        [
          RecruitmentInterviewAlreadyCancelled.make({ interviewId: failingInterviewId }),
          call.finalizeInterview,
          "recruitment.already-cancelled",
        ],
        [
          RecruitmentConductValidationError.make({
            interviewId: failingInterviewId,
            message: "fixture",
          }),
          call.finalizeInterview,
          "recruitment.conduct-invalid",
        ],
        [
          RecruitmentLifecycleCommandConflict.make({
            commandId: RecruitmentConductCommandId.make("fixture-id"),
          }),
          call.finalizeInterview,
          "idempotency.digest-conflict",
        ],
        [RecruitmentInvitationNotFound.make({}), call.invitationResponse, "resource.not-found"],
        [
          RecruitmentInvitationAlreadyResponded.make({}),
          call.rejectInvitation,
          "invitation.already-responded",
        ],
        [
          RecruitmentPersistenceError.make({ operation: "fixture", message: "fixture" }),
          call.schedulingBoard,
          "recruitment.unavailable",
        ],
        [
          RecruitmentPersistenceError.make({ operation: "fixture", message: "fixture" }),
          call.rejectInvitation,
          "dependency.unavailable",
        ],
        [
          ProfileContactNotFound.make({ personId }),
          call.rejectInvitation,
          "dependency.unavailable",
        ],
        [
          RecruitmentDecodeError.make({ message: "fixture" }),
          call.schedulingBoard,
          "internal.error",
        ],
        [
          RecruitmentInvalidContext.make({ message: "fixture" }),
          call.assignmentBoard,
          "internal.error",
        ],
        [
          OrganizationPersistenceError.make({ operation: "fixture", message: "fixture" }),
          call.schedulingBoard,
          "internal.error",
        ],
      ];

      for (const [failure, request, code] of cases) {
        injected = failure;

        const answered = yield* request().pipe(answeredCode);

        expect({ failure: failure._tag, code: answered }).toEqual({
          failure: failure._tag,
          code,
        });
      }

      injected = undefined;

      // A cookie without a current session is a rejected credential, and no cookie is a missing one.
      const endedSession = yield* RpcClient.withHeaders(
        client["recruitment.readSchedulingBoard"](),
        {
          cookie: `better-auth.session_token=${expiredSession}`,
        },
      ).pipe(Effect.flip);

      expect(codeOf(endedSession)).toBe("credential.invalid");

      const anonymous = yield* client["recruitment.readSchedulingBoard"]().pipe(Effect.flip);

      expect(codeOf(anonymous)).toBe("credential.missing");
    }),
  );

  it.live(
    "preserves the native conflict protocol for PostgreSQL snapshot and deadlock failures",
    () =>
      Effect.gen(function* () {
        const { client, asLeader } = yield* fixture();

        for (const code of ["40001", "40P01"]) {
          injected = RecruitmentPersistenceError.make({
            operation: "fixture",
            message: "Transaction failed",
            cause: { cause: { code } },
          });

          const answered = yield* calls(client, asLeader).interviewReport().pipe(Effect.flip);

          expect(codeOf(answered)).toBe("transaction.conflict");
        }

        injected = undefined;
      }),
  );
});

it("denies a suspended assigned member in the access context used before receipt replay", () => {
  const personId = PersonId.make("suspended-assigned-person"),
    assignedDepartmentId = DepartmentId.make("department-assigned");

  const source = {
    interviewId: RecruitmentInterviewId.make("assigned-interview"),
    departmentId: assignedDepartmentId,
    interviewerPersonId: personId,
    coInterviewerPersonId: null,
    interviewRevision: 1,
    linkedApplicantPersonId: null,
    authority: [],
  };

  const requirement = {
    id: RequirementId.make("recruitment.assigned-interviewer"),
    parameters: {},
  };

  const principal = PrincipalSchema.cases.Person.make({ personId });

  const evaluate = (
    actor: Parameters<typeof recruitmentInterviewAccessContext>[0]["actor"],
    activeMember: boolean,
  ) =>
    evaluateRequirement(
      requirement,
      principal,
      recruitmentInterviewAccessContext({ source, actor, allowLeader: false, activeMember }),
    )._tag;

  expect(
    evaluate(
      AdmissionPeriodActorSchema.cases.Member.make({
        personId,
        departmentId: assignedDepartmentId,
        active: false,
      }),
      false,
    ),
  ).toBe("Failed");
  expect(
    evaluate(AdmissionPeriodActorSchema.cases.GlobalAdmin.make({ personId, active: true }), false),
  ).toBe("Failed");
  expect(
    evaluate(
      AdmissionPeriodActorSchema.cases.Member.make({
        personId,
        departmentId: assignedDepartmentId,
        active: true,
      }),
      true,
    ),
  ).toBe("Satisfied");
});

it("authorizes a current co-interviewer only through the participant requirement", () => {
  const primaryPersonId = PersonId.make("primary-interviewer"),
    coInterviewerPersonId = PersonId.make("co-interviewer"),
    coDepartmentId = DepartmentId.make("department-co-interviewer");

  const source = {
    interviewId: RecruitmentInterviewId.make("co-interviewer-interview"),
    departmentId: coDepartmentId,
    interviewerPersonId: primaryPersonId,
    coInterviewerPersonId,
    interviewRevision: 1,
    linkedApplicantPersonId: null,
    authority: [],
  };

  const principal = PrincipalSchema.cases.Person.make({ personId: coInterviewerPersonId });

  const actor = AdmissionPeriodActorSchema.cases.Member.make({
    personId: coInterviewerPersonId,
    departmentId: coDepartmentId,
    active: true,
  });

  const context = recruitmentInterviewAccessContext({
    source,
    actor,
    allowLeader: false,
    activeMember: true,
  });

  expect(
    evaluateRequirement(
      {
        id: RequirementId.make("recruitment.assigned-interviewer-or-co-interviewer"),
        parameters: {},
      },
      principal,
      context,
    )._tag,
  ).toBe("Satisfied");
  expect(
    evaluateRequirement(
      { id: RequirementId.make("recruitment.assigned-interviewer"), parameters: {} },
      principal,
      context,
    )._tag,
  ).toBe("Failed");
  expect(
    recruitmentInterviewAccessContext({
      source: { ...source, coInterviewerPersonId: null },
      actor,
      allowLeader: false,
      activeMember: true,
    }).authorityVersion,
  ).not.toBe(context.authorityVersion);
  expect(interviewETag({ ...source, coInterviewerPersonId: null })).not.toBe(interviewETag(source));
});

it("keeps the interview authority version that the HTTP handler derived", () => {
  const source = {
    interviewId: RecruitmentInterviewId.make("version-interview"),
    departmentId,
    interviewerPersonId: PersonId.make("version-interviewer"),
    coInterviewerPersonId: PersonId.make('co"interviewer'),
    interviewRevision: 3,
    linkedApplicantPersonId: null,
    authority: [{ kind: "Membership" as const, identity: "membership-1", revisions: [1, 2] }],
  };

  expect(
    recruitmentInterviewAccessContext({
      source,
      actor: AdmissionPeriodActorSchema.cases.Member.make({
        personId: source.interviewerPersonId,
        departmentId,
        active: true,
      }),
      allowLeader: false,
      activeMember: true,
    }).authorityVersion,
  ).toBe('3:"co\\"interviewer":Unknown:Membership:membership-1:1.2');
});

it("authorizes the report collection for its current scoped leader and rejects missing leadership", () => {
  const spec = Option.getOrThrow(reflectAccessSpec(ReadInterviewReport));

  if (!Predicate.isTagged(spec.capabilities, "One"))
    throw new Error("report requires one capability");
  const personId = PersonId.make("report-access-leader");
  const reportDepartmentId = DepartmentId.make("report-access-department");
  const principal = PrincipalSchema.cases.Person.make({ personId });
  const instant = AuthorizationInstant.make("2031-09-15T12:00:00.000Z");

  const grant = decodeGrant({
    grantId: GrantId.make("report-access-grant"),
    subject: principal,
    capability: spec.capabilities.capability,
    scope: Scope.Department({ departmentId: reportDepartmentId }),
    startAt: instant,
    endAt: null,
    requirements: [],
    source: AuthorityRef.make("native-recruitment-actor"),
    revision: 0,
  });

  const evaluate = (leaders: ReadonlyArray<typeof personId>) =>
    evaluateAccess({
      spec,
      credential: CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        principal,
        evidenceRef: CredentialEvidenceRef.make("report-access-session"),
      }),
      resolution: {
        selection: "AllMatching",
        contexts: [
          {
            domainId: DomainId.make("recruitment"),
            departmentId: reportDepartmentId,
            resource: null,
            facts: { departmentAdministratorPersonIds: leaders },
            authorityVersion: AuthorityVersion.make(instant),
          },
        ],
      },
      grants: [grant],
      authorizationInstant: instant,
    });

  expect(evaluate([personId])._tag).toBe("Allow");
  {
    const observed = evaluate([]);
    expect(observed).toHaveProperty("_tag", "Deny");
    expect(observed).toMatchObject({ stage: "Requirement", reason: "RequirementFailed" });
  }
});
