import { IdentitySnapshot } from "@vektorprogrammet/database";
import {
  AdmissionPeriodActorSchema,
  InactiveActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  PrincipalSchema,
  Scope,
  CredentialOutcomeSchema,
  CredentialMechanismSchema,
  evaluateAccess,
  decodeGrant,
  GrantId,
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CredentialEvidenceRef,
  DomainId,
} from "@vektorprogrammet/domain/authz";
import { evaluateRequirement, RequirementId } from "@vektorprogrammet/domain/authz";
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  Organization,
  OrganizationPersistenceError,
  PersonId,
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
import {
  NativeProblem,
  ReadInterviewReportEndpoint,
  SchedulingBoard,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Option, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PreconditionDecision, evaluateMutationPrecondition } from "../http-semantics.js";
import { makeRecruitmentTestHttp } from "../test/native-http.js";
import { recruitmentInterviewAccessContext } from "./http-access.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import { interviewETag, invitationETag, schedulingBoardWithETags } from "./http-representation.js";

const at = "2031-09-15T12:00:00.000Z";

const departmentId = DepartmentId.make("http-department");

const leader = AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
  personId: PersonId.make("http-leader"),
  departmentId,
  active: true,
});

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
    invitationId: "http-invitation",
    interviewId: "http-interview",
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
    Effect.sync(() => {
      transitions.push(transition);

      return { ...snapshot, source: { ...snapshot.source, responseRevision: 1 } };
    }),
  readAssignmentBoard: injectedFailure,
  readSchedulingBoard: injectedFailure,
  resolveInterviewReportLeader: injectedFailure,
  prepareAssignment: injectedFailure,
  prepareInterview: injectedFailure,
} satisfies Partial<RecruitmentOperations>;

const organization = {
  resolvePersonAuthority: (personId: PersonId) =>
    Effect.succeed({
      personId,
      evaluatedAt: at,
      globalAdministrator: "Absent",
      memberships: [],
      nationalBoardSeats: [],
      delegations: [],
    }),
} satisfies Partial<OrganizationOperations>;

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(person),
            sessionId: `session-${person}`,
            expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
          }),
        );
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

/** The recruitment ingress as a department leader reaches it. */
const ingress = (
  resolveActor: RecruitmentApiHttpOptions["resolveActor"] = () => Effect.succeed(leader),
) =>
  makeRecruitmentTestHttp(
    {
      config: {
        maxBodyBytes: 256,
        now: () => at,
        nextInterviewId: () => RecruitmentInterviewId.make("http-unexpected-interview"),
        nextInvitationId: () => RecruitmentInvitationId.make("http-unexpected-invitation"),
        nextResponseCapability: () => "unexpected".padEnd(43, "_"),
      },
      resolveActor,
    },
    Layer.mergeAll(
      Layer.mock(Recruitment, recruitment),
      Layer.mock(Organization, organization),
      Layer.succeed(IdentitySnapshot, identitySnapshot),
    ),
  );

/** An invitation capability holder's read (`""`) or response. */
const invitation = (
  action: "" | ":confirm" | ":reject" | ":request-new-time",
  init: {
    readonly headers?: Record<string, string>;
    readonly body?: string | ReadableStream<Uint8Array>;
  } = {},
) => {
  const headers = new Headers({ "x-recruitment-invitation-capability": "http".padEnd(43, "_") });

  if (action !== "") {
    headers.set("content-type", "application/json");
    headers.set("if-match", invitationETag(snapshot.source));
    headers.set("origin", "http://127.0.0.1:5174");
  }

  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);

  return new Request(`http://backend.test/api/recruitment/invitation-response${action}`, {
    method: action === "" ? "GET" : "POST",
    headers,
    body: init.body,
    duplex: "half",
  } satisfies RequestInit & { readonly duplex: "half" });
};

/** A request of a person with a current session; a method makes it a command. */
const person = (
  path: string,
  init: {
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
  } = {},
) => {
  const headers = new Headers({ cookie: "better-auth.session_token=http-leader" });

  if (init.method !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", "http-command".padEnd(22, "0"));
    headers.set("origin", "http://127.0.0.1:5174");
  }

  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);

  return new Request(`http://backend.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
};

const anyValidator = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

const schedulingBoard = () => person("/api/recruitment/interviews");

const assignmentBoard = () => person("/api/recruitment/application-assignments?status=new");

const interviewConduct = () => person("/api/recruitment/interviews/http-interview");

const interviewReport = () => person("/api/recruitment/interview-report");

const createInterview = () =>
  person("/api/recruitment/applications/http-application/interviews", {
    method: "POST",
    body: JSON.stringify({ interviewerPersonId: "http-leader", interviewSchemaId: "http-schema" }),
  });

const scheduleInterview = () =>
  person("/api/recruitment/interviews/http-interview:schedule", {
    method: "POST",
    headers: { "if-match": anyValidator },
    body: JSON.stringify({
      scheduledAt: "2031-09-20T10:00:00.000Z",
      room: "A101",
      campus: null,
      mapLink: null,
      message: "Velkommen.",
    }),
  });

const finalizeInterview = () =>
  person("/api/recruitment/interviews/http-interview:finalize", {
    method: "POST",
    headers: { "if-match": anyValidator },
    body: JSON.stringify({
      answers: [{ questionId: "q-1", answer: "Svar" }],
      score: { explanatoryPower: 4, roleModel: 5, suitability: 6 },
      recommendation: "Ja",
    }),
  });

const invitationResponse = () => invitation("");

const rejectInvitation = () => invitation(":reject", { body: "{}" });

const problemOf = async (response: Response) => ({
  status: response.status,
  code: Schema.decodeUnknownSync(NativeProblem)(await response.json()).code,
});

describe("native recruitment HTTP boundary", () => {
  it("accepts one bounded JSON object and rejects invalid transport bodies", async () => {
    const http = ingress();
    transitions.length = 0;

    const accepted = await http.fetch(
      invitation(":reject", { body: JSON.stringify({ message: "Another time" }) }),
    );

    expect(accepted.status).toBe(204);
    expect(transitions).toEqual([
      RecruitmentInvitationTransition.Reject({ message: "Another time" }),
    ]);

    expect(
      await problemOf(
        await http.fetch(invitation(":reject", { body: '{"message":"first","message":"second"}' })),
      ),
    ).toEqual({ status: 400, code: "request.malformed" });

    expect(
      await problemOf(
        await http.fetch(
          invitation(":reject", { headers: { "content-type": "text/plain" }, body: "{}" }),
        ),
      ),
    ).toEqual({ status: 415, code: "media-type.unsupported" });

    // request.malformed is the only client problem a confirmation declares.
    expect(
      await problemOf(
        await http.fetch(
          invitation(":confirm", { body: JSON.stringify({ unexpected: "x".repeat(256) }) }),
        ),
      ),
    ).toEqual({ status: 400, code: "request.malformed" });

    let cancelled = false;
    let chunks = 0;

    const streamed = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        chunks += 1;

        if (chunks > 32) controller.close();
        else controller.enqueue(new Uint8Array(12));
      },
      cancel: () => {
        cancelled = true;
      },
    });

    expect(await problemOf(await http.fetch(invitation(":reject", { body: streamed })))).toEqual({
      status: 413,
      code: "request.too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("applies strong validators only after the private representation exists", async () => {
    const http = ingress();
    const etag = invitationETag(snapshot.source);
    const fresh = await http.fetch(invitation(""));

    expect({
      status: fresh.status,
      etag: fresh.headers.get("etag"),
      cacheControl: fresh.headers.get("cache-control"),
      vary: fresh.headers.get("vary"),
      body: await fresh.json(),
    }).toEqual({
      status: 200,
      etag,
      cacheControl: "private, no-store",
      vary: "Origin",
      body: observation,
    });

    const notModified = await http.fetch(invitation("", { headers: { "if-none-match": etag } }));

    expect({
      status: notModified.status,
      etag: notModified.headers.get("etag"),
      cacheControl: notModified.headers.get("cache-control"),
      vary: notModified.headers.get("vary"),
      body: await notModified.text(),
    }).toEqual({
      status: 304,
      etag,
      cacheControl: "private, no-store",
      vary: "Origin",
      body: "",
    });

    expect(
      await problemOf(
        await http.fetch(invitation("", { headers: { "if-match": '"vkr2.stale"' } })),
      ),
    ).toEqual({ status: 412, code: "precondition.failed" });
  });

  it("rejects an invitation capability presented beside a session cookie or a bearer", async () => {
    const http = ingress();
    transitions.length = 0;

    // The capability is the request's one credential in every invitation operation.
    const operations = [
      ["", undefined],
      [":confirm", "{}"],
      [":reject", "{}"],
      [":request-new-time", JSON.stringify({ message: "Kan vi møtes torsdag?" })],
    ] as const;

    const answer = async (response: Response) =>
      response.ok
        ? { status: response.status }
        : { ...(await problemOf(response)), challenge: response.headers.get("www-authenticate") };

    for (const [header, credential] of [
      ["cookie", "theme=dark; better-auth.session_token=http-leader"],
      ["authorization", "Bearer http-leader-bearer"],
    ] as const) {
      for (const [action, body] of operations) {
        const response = await http.fetch(
          invitation(action, { headers: { [header]: credential }, body }),
        );

        expect({ action, header, ...(await answer(response)) }).toEqual({
          action,
          header,
          status: 401,
          code: "credential.invalid",
          challenge: 'RecruitmentInvitationCapability realm="native-api"',
        });
      }
    }

    expect(transitions).toEqual([]);
    // A cookie without a session is no second credential.
    expect(
      await answer(await http.fetch(invitation("", { headers: { cookie: "theme=dark" } }))),
    ).toEqual({ status: 200 });
  });

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
      {
        kind: "Membership" as const,
        identity: "membership-1",
        revisions: [4, 5, 6],
      },
    ];

    expect(() =>
      Schema.decodeUnknownSync(SchedulingBoard)(board, { onExcessProperty: "error" }),
    ).toThrow();

    const tagged = schedulingBoardWithETags(board, authority);

    const decoded = Schema.decodeSync(SchedulingBoard)(tagged, {
      onExcessProperty: "error",
    });

    const boardTag = decoded.interviews[0]!.etag;

    const mutationTag = interviewETag({
      interviewId: board.interviews[0]!.interviewId,
      departmentId: board.interviews[0]!.departmentId,
      interviewerPersonId: board.interviews[0]!.interviewer.personId,
      coInterviewerPersonId: null,
      interviewRevision: board.interviews[0]!.revision,
      authority,
    });

    const afterInterviewRevision = schedulingBoardWithETags(
      {
        ...board,
        interviews: [{ ...board.interviews[0]!, revision: 3 }],
      },
      authority,
    ).interviews[0]!.etag;

    const afterCoInterviewerChange = schedulingBoardWithETags(
      {
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
    ).interviews[0]!.etag;

    const afterAuthorityRevision = schedulingBoardWithETags(board, [
      { ...authority[0]!, revisions: [4, 5, 7] },
    ]).interviews[0]!.etag;

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

  it("maps recruitment failures to the frozen RFC 9457 problem vocabulary", async () => {
    const http = ingress();
    const personId = PersonId.make("fixture-person");
    const interviewId = RecruitmentInterviewId.make("fixture-id");
    const applicationId = PublicApplicationIdSchema.make("fixture-id");
    const interviewSchemaId = InterviewSchemaId.make("fixture-id");

    // Each failure is answered by an operation that declares its problem.
    const cases = [
      [new RecruitmentInactiveActor({ personId }), schedulingBoard, 403, "authority.denied"],
      [new InactiveActor({ personId }), schedulingBoard, 403, "authority.denied"],
      [new RecruitmentRoleDenied({ personId }), schedulingBoard, 403, "authority.denied"],
      [
        new RecruitmentScopeDenied({ personId, departmentId }),
        interviewConduct,
        403,
        "authority.denied",
      ],
      [
        new RecruitmentInterviewerNotEligible({ personId, departmentId }),
        createInterview,
        403,
        "authority.denied",
      ],
      [
        new RecruitmentAdmissionPeriodNotFound({ departmentId }),
        assignmentBoard,
        404,
        "recruitment.admission-period-not-found",
      ],
      [
        new RecruitmentAmbiguousAdmissionPeriod({ departmentId }),
        assignmentBoard,
        409,
        "application.ambiguous-period",
      ],
      [
        new RecruitmentApplicationNotFound({ applicationId }),
        createInterview,
        404,
        "recruitment.application-not-found",
      ],
      [
        new RecruitmentInterviewSchemaNotFound({ interviewSchemaId }),
        createInterview,
        404,
        "recruitment.interview-schema-not-found",
      ],
      [
        new RecruitmentApplicationAlreadyAssigned({ applicationId }),
        createInterview,
        409,
        "recruitment.application-already-assigned",
      ],
      [
        new RecruitmentInterviewSchemaInactive({ interviewSchemaId }),
        createInterview,
        422,
        "recruitment.interview-schema-inactive",
      ],
      [
        new RecruitmentAssignmentCommandConflict({
          commandId: RecruitmentAssignmentCommandId.make("fixture-id"),
        }),
        createInterview,
        409,
        "idempotency.digest-conflict",
      ],
      [
        new InterviewQuestionsUnavailable({ interviewSchemaId, reason: "fixture" }),
        createInterview,
        503,
        "dependency.unavailable",
      ],
      [
        new RecruitmentInterviewNotFound({ interviewId }),
        interviewConduct,
        404,
        "recruitment.interview-not-found",
      ],
      [
        new RecruitmentInterviewNotScheduled({ interviewId }),
        interviewConduct,
        409,
        "recruitment.interview-not-scheduled",
      ],
      [
        new RecruitmentInvitationNotAccepted({ interviewId, responseState: "fixture" }),
        interviewConduct,
        409,
        "recruitment.invitation-not-accepted",
      ],
      [
        new RecruitmentInterviewAlreadyScheduled({ interviewId }),
        scheduleInterview,
        409,
        "recruitment.already-scheduled",
      ],
      [
        new RecruitmentInterviewStaleRevision({
          interviewId,
          expectedRevision: 1,
          actualRevision: 2,
        }),
        scheduleInterview,
        412,
        "precondition.failed",
      ],
      [
        new RecruitmentScheduleInPast({ interviewId }),
        scheduleInterview,
        422,
        "recruitment.schedule-in-past",
      ],
      [
        new RecruitmentScheduleCommandConflict({
          commandId: RecruitmentScheduleCommandId.make("fixture-id"),
        }),
        scheduleInterview,
        409,
        "idempotency.digest-conflict",
      ],
      [
        new RecruitmentInterviewAlreadyFinalized({ interviewId }),
        finalizeInterview,
        409,
        "recruitment.already-finalized",
      ],
      [
        new RecruitmentInterviewAlreadyCancelled({ interviewId }),
        finalizeInterview,
        409,
        "recruitment.already-cancelled",
      ],
      [
        new RecruitmentConductValidationError({ interviewId, message: "fixture" }),
        finalizeInterview,
        422,
        "recruitment.conduct-invalid",
      ],
      [
        new RecruitmentLifecycleCommandConflict({
          commandId: RecruitmentConductCommandId.make("fixture-id"),
        }),
        finalizeInterview,
        409,
        "idempotency.digest-conflict",
      ],
      [new RecruitmentInvitationNotFound({}), invitationResponse, 404, "resource.not-found"],
      [
        new RecruitmentInvitationAlreadyResponded({}),
        rejectInvitation,
        409,
        "invitation.already-responded",
      ],
      [
        new RecruitmentPersistenceError({ operation: "fixture", message: "fixture" }),
        schedulingBoard,
        503,
        "recruitment.unavailable",
      ],
      [
        new RecruitmentPersistenceError({ operation: "fixture", message: "fixture" }),
        rejectInvitation,
        503,
        "dependency.unavailable",
      ],
      [new ProfileContactNotFound({ personId }), rejectInvitation, 503, "dependency.unavailable"],
      [new RecruitmentDecodeError({ message: "fixture" }), schedulingBoard, 500, "internal.error"],
      [
        new RecruitmentInvalidContext({ message: "fixture" }),
        assignmentBoard,
        500,
        "internal.error",
      ],
      [
        new OrganizationPersistenceError({ operation: "fixture", message: "fixture" }),
        schedulingBoard,
        500,
        "internal.error",
      ],
    ] as const;

    for (const [failure, request, status, code] of cases) {
      injected = failure;

      expect({ failure: failure._tag, ...(await problemOf(await http.fetch(request()))) }).toEqual({
        failure: failure._tag,
        status,
        code,
      });
    }

    injected = undefined;

    const unauthenticated = await ingress(() =>
      Effect.fail(new UnauthenticatedActor({ message: "Authentication required" })),
    ).fetch(schedulingBoard());

    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      'VektorSession realm="native-api", Bearer realm="native-api"',
    );
    expect(await problemOf(unauthenticated)).toEqual({ status: 401, code: "credential.invalid" });

    expect(await problemOf(await http.fetch(person("/api/recruitment/interviews?x=1")))).toEqual({
      status: 400,
      code: "request.malformed",
    });
  });
});

it("preserves the native conflict protocol for PostgreSQL snapshot and deadlock failures", async () => {
  const http = ingress();

  for (const code of ["40001", "40P01"]) {
    injected = new RecruitmentPersistenceError({
      operation: "fixture",
      message: "Transaction failed",
      cause: { cause: { code } },
    });

    expect(await problemOf(await http.fetch(interviewReport()))).toEqual({
      status: 409,
      code: "transaction.conflict",
    });
  }

  injected = undefined;
});

it("denies a suspended assigned member in the HTTP access context used before receipt replay", () => {
  const personId = PersonId.make("suspended-assigned-person"),
    departmentId = DepartmentId.make("department-assigned");

  const source = {
    interviewId: RecruitmentInterviewId.make("assigned-interview"),
    departmentId,
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
  expect(
    evaluateRequirement(
      requirement,
      principal,
      recruitmentInterviewAccessContext(
        source,
        AdmissionPeriodActorSchema.cases.Member.make({ personId, departmentId, active: false }),
        false,
        false,
      ),
    )._tag,
  ).toBe("Failed");
  expect(
    evaluateRequirement(
      requirement,
      principal,
      recruitmentInterviewAccessContext(
        source,
        AdmissionPeriodActorSchema.cases.GlobalAdmin.make({ personId, active: true }),
        false,
        false,
      ),
    )._tag,
  ).toBe("Failed");
  expect(
    evaluateRequirement(
      requirement,
      principal,
      recruitmentInterviewAccessContext(
        source,
        AdmissionPeriodActorSchema.cases.Member.make({ personId, departmentId, active: true }),
        false,
        true,
      ),
    )._tag,
  ).toBe("Satisfied");
});

it("authorizes a current co-interviewer only through the participant requirement", () => {
  const primaryPersonId = PersonId.make("primary-interviewer"),
    coInterviewerPersonId = PersonId.make("co-interviewer"),
    departmentId = DepartmentId.make("department-co-interviewer");

  const source = {
    interviewId: RecruitmentInterviewId.make("co-interviewer-interview"),
    departmentId,
    interviewerPersonId: primaryPersonId,
    coInterviewerPersonId,
    interviewRevision: 1,
    linkedApplicantPersonId: null,
    authority: [],
  };

  const principal = PrincipalSchema.cases.Person.make({ personId: coInterviewerPersonId });

  const context = recruitmentInterviewAccessContext(
    source,
    AdmissionPeriodActorSchema.cases.Member.make({
      personId: coInterviewerPersonId,
      departmentId,
      active: true,
    }),
    false,
    true,
  );

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
    recruitmentInterviewAccessContext(
      { ...source, coInterviewerPersonId: null },
      AdmissionPeriodActorSchema.cases.Member.make({
        personId: coInterviewerPersonId,
        departmentId,
        active: true,
      }),
      false,
      true,
    ).authorityVersion,
  ).not.toBe(context.authorityVersion);
  expect(interviewETag({ ...source, coInterviewerPersonId: null })).not.toBe(interviewETag(source));
});

it("authorizes the report collection for its current scoped leader and rejects missing leadership", () => {
  const spec = Option.getOrThrow(reflectAccessSpec(ReadInterviewReportEndpoint));

  if (!Predicate.isTagged(spec.capabilities, "One"))
    throw new Error("report requires one capability");
  const personId = PersonId.make("report-access-leader");
  const departmentId = DepartmentId.make("report-access-department");
  const principal = PrincipalSchema.cases.Person.make({ personId });
  const instant = AuthorizationInstant.make("2031-09-15T12:00:00.000Z");

  const grant = decodeGrant({
    grantId: GrantId.make("report-access-grant"),
    subject: principal,
    capability: spec.capabilities.capability,
    scope: Scope.Department({ departmentId }),
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
            departmentId,
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
