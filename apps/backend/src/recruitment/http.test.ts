import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { NativeHttpReceiptPersistenceError } from "../http-api/receipt-transaction.js";
import {
  UnauthenticatedActor,
  AdmissionPeriodActorSchema,
} from "@vektorprogrammet/domain/admission-period";
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
import { ReadInterviewReportEndpoint, reflectAccessSpec } from "@vektorprogrammet/http-api";
import { Predicate, Option } from "effect";
import { evaluateRequirement, RequirementId } from "@vektorprogrammet/domain/authz";
import { PersonId, DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  RecruitmentInactiveActor,
  RecruitmentAdmissionPeriodNotFound,
  RecruitmentAmbiguousAdmissionPeriod,
  RecruitmentApplicationNotFound,
  RecruitmentInterviewSchemaNotFound,
  InterviewSchemaId,
  RecruitmentApplicationAlreadyAssigned,
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewAlreadyScheduled,
  RecruitmentInterviewStaleRevision,
  RecruitmentScheduleInPast,
  RecruitmentInvitationNotFound,
  RecruitmentInvitationAlreadyResponded,
  RecruitmentInterviewAlreadyFinalized,
  RecruitmentInterviewAlreadyCancelled,
  RecruitmentInterviewNotScheduled,
  RecruitmentInvitationNotAccepted,
  RecruitmentConductValidationError,
  RecruitmentAssignmentCommandConflict,
  RecruitmentAssignmentCommandId,
  RecruitmentScheduleCommandConflict,
  RecruitmentScheduleCommandId,
  RecruitmentLifecycleCommandConflict,
  RecruitmentConductCommandId,
  RecruitmentDecodeError,
  RecruitmentPersistenceError,
  RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import { SchedulingBoard } from "@vektorprogrammet/http-api";
import { RecruitmentSchedulingBoardSchema } from "@vektorprogrammet/domain/recruitment";
import { Schema } from "effect";
import {
  PreconditionDecision,
  deriveStrongETag,
  evaluateMutationPrecondition,
  HttpSemanticFailure,
} from "../http-semantics.js";
import { describe, expect, it } from "vitest";
import { runTestPromise } from "../../test/runtime.js";
import {
  RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS,
  conditionalJsonResponse,
  interviewETag,
  readRecruitmentRequestBody,
  recruitmentHttpErrorResponse,
  schedulingBoardWithETags,
  recruitmentInterviewAccessContext,
} from "./http.js";

describe("native recruitment HTTP boundary", () => {
  it("registers every frozen recruitment operation once with canonical action routes", () => {
    expect(RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS).toEqual({
      readInvitationResponse: {
        operationId: "recruitment.readInvitationResponse",
        method: "GET",
        path: "/api/recruitment/invitation-response",
      },
      confirmInvitation: {
        operationId: "recruitment.confirmInvitation",
        method: "POST",
        path: "/api/recruitment/invitation-response:confirm",
      },
      rejectInvitation: {
        operationId: "recruitment.rejectInvitation",
        method: "POST",
        path: "/api/recruitment/invitation-response:reject",
      },
      requestNewInvitationTime: {
        operationId: "recruitment.requestNewInvitationTime",
        method: "POST",
        path: "/api/recruitment/invitation-response:request-new-time",
      },
      readAssignmentBoard: {
        operationId: "recruitment.readAssignmentBoard",
        method: "GET",
        path: "/api/recruitment/application-assignments",
      },
      readInterviewReport: {
        operationId: "recruitment.readInterviewReport",
        method: "GET",
        path: "/api/recruitment/interview-report",
      },
      readSchedulingBoard: {
        operationId: "recruitment.readSchedulingBoard",
        method: "GET",
        path: "/api/recruitment/interviews",
      },
      createApplicationInterview: {
        operationId: "recruitment.createApplicationInterview",
        method: "POST",
        path: "/api/recruitment/applications/{applicationId}/interviews",
      },
      scheduleInterview: {
        operationId: "recruitment.scheduleInterview",
        method: "POST",
        path: "/api/recruitment/interviews/{interviewId}:schedule",
      },
      readInterviewConduct: {
        operationId: "recruitment.readInterviewConduct",
        method: "GET",
        path: "/api/recruitment/interviews/{interviewId}",
      },
      correctInterviewAssessment: {
        operationId: "recruitment.correctInterviewAssessment",
        method: "POST",
        path: "/api/recruitment/interviews/{interviewId}:correct",
      },
      finalizeInterview: {
        operationId: "recruitment.finalizeInterview",
        method: "POST",
        path: "/api/recruitment/interviews/{interviewId}:finalize",
      },
      cancelInterview: {
        operationId: "recruitment.cancelInterview",
        method: "POST",
        path: "/api/recruitment/interviews/{interviewId}:cancel",
      },
    });
  });

  it("accepts one bounded JSON object and rejects invalid transport bodies", async () => {
    await expect(
      runTestPromise(
        readRecruitmentRequestBody(
          new Request("http://backend.test/api/recruitment/invitation-response:reject", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "Another time" }),
          }),
          64,
        ),
      ),
    ).resolves.toEqual({ message: "Another time" });

    const duplicate = runTestPromise(
      readRecruitmentRequestBody(
        new Request("http://backend.test/api/recruitment/invitation-response:reject", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"message":"first","message":"second"}',
        }),
        128,
      ),
    );

    await expect(duplicate).rejects.toMatchObject({
      name: "HttpSemanticFailure",
      code: "request.malformed",
      status: 400,
    });

    const unsupported = runTestPromise(
      readRecruitmentRequestBody(
        new Request("http://backend.test/api/recruitment/invitation-response:reject", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
        64,
      ),
    );

    await expect(unsupported).rejects.toMatchObject({
      code: "media-type.unsupported",
      status: 415,
    });

    const oversizedConfirm = runTestPromise(
      readRecruitmentRequestBody(
        new Request("http://backend.test/api/recruitment/invitation-response:confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ unexpected: "x".repeat(64) }),
        }),
        16,
        true,
      ),
    );

    await expect(oversizedConfirm).rejects.toMatchObject({
      code: "request.malformed",
      status: 400,
    });

    let cancelled = false;

    const streamed = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(12)),
      cancel: () => {
        cancelled = true;
      },
    });

    await expect(
      runTestPromise(
        readRecruitmentRequestBody(
          new Request("http://backend.test/api/recruitment/invitation-response:reject", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: streamed,
            duplex: "half",
          } satisfies RequestInit & { readonly duplex: "half" }),
          16,
        ),
      ),
    ).rejects.toMatchObject({ code: "request.too-large", status: 413 });
    expect(cancelled).toBe(true);
  });

  it("applies strong validators only after the private representation exists", async () => {
    const etag = deriveStrongETag({
      representationKind: "InvitationResponseObservation",
      resourceIdentity: "recruitment-invitation:invitation-1",
      version: [2, 3],
    });

    const body = {
      scheduledAt: "2031-09-20T10:00:00.000Z",
      room: "A101",
      campus: "Gløshaugen",
      responseState: "Pending",
      responseMessage: null,
    };

    const fresh = await runTestPromise(
      conditionalJsonResponse(
        new Request("http://backend.test/api/recruitment/invitation-response"),
        body,
        etag,
      ),
    );

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
      body,
    });

    const notModified = await runTestPromise(
      conditionalJsonResponse(
        new Request("http://backend.test/api/recruitment/invitation-response", {
          headers: { "if-none-match": etag },
        }),
        body,
        etag,
      ),
    );

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

    const stale = await runTestPromise(
      conditionalJsonResponse(
        new Request("http://backend.test/api/recruitment/invitation-response", {
          headers: { "if-match": '"vkr2.stale"' },
        }),
        body,
        etag,
      ),
    );

    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({
      status: 412,
      type: "urn:vektorprogrammet:problem:v0.2:precondition.failed",
    });
  });

  it("exposes mutation-compatible strong ETags on scheduling items", () => {
    const board = Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
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

    const decoded = Schema.decodeUnknownSync(SchedulingBoard)(tagged, {
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
    const cases = [
      [
        new RecruitmentInactiveActor({ personId: PersonId.make("fixture-person") }),
        403,
        "authority.denied",
      ],
      [
        new RecruitmentAdmissionPeriodNotFound({
          departmentId: DepartmentId.make("fixture-department"),
        }),
        404,
        "recruitment.admission-period-not-found",
      ],
      [
        new RecruitmentAmbiguousAdmissionPeriod({
          departmentId: DepartmentId.make("fixture-department"),
        }),
        409,
        "application.ambiguous-period",
      ],
      [
        new RecruitmentApplicationNotFound({
          applicationId: PublicApplicationIdSchema.make("fixture-id"),
        }),
        404,
        "recruitment.application-not-found",
      ],
      [
        new RecruitmentInterviewSchemaNotFound({
          interviewSchemaId: InterviewSchemaId.make("fixture-id"),
        }),
        404,
        "recruitment.interview-schema-not-found",
      ],
      [
        new RecruitmentApplicationAlreadyAssigned({
          applicationId: PublicApplicationIdSchema.make("fixture-id"),
        }),
        409,
        "recruitment.application-already-assigned",
      ],
      [
        new RecruitmentInterviewSchemaInactive({
          interviewSchemaId: InterviewSchemaId.make("fixture-id"),
        }),
        422,
        "recruitment.interview-schema-inactive",
      ],
      [
        new RecruitmentInterviewNotFound({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
        }),
        404,
        "recruitment.interview-not-found",
      ],
      [
        new RecruitmentInterviewAlreadyScheduled({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
        }),
        409,
        "recruitment.already-scheduled",
      ],
      [
        new RecruitmentInterviewStaleRevision({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
          expectedRevision: 1,
          actualRevision: 2,
        }),
        412,
        "precondition.failed",
      ],
      [
        new RecruitmentScheduleInPast({ interviewId: RecruitmentInterviewId.make("fixture-id") }),
        422,
        "recruitment.schedule-in-past",
      ],
      [new RecruitmentInvitationNotFound({}), 404, "resource.not-found"],
      [new RecruitmentInvitationAlreadyResponded({}), 409, "invitation.already-responded"],
      [
        new RecruitmentInterviewAlreadyFinalized({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
        }),
        409,
        "recruitment.already-finalized",
      ],
      [
        new RecruitmentInterviewAlreadyCancelled({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
        }),
        409,
        "recruitment.already-cancelled",
      ],
      [
        new RecruitmentInterviewNotScheduled({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
        }),
        409,
        "recruitment.interview-not-scheduled",
      ],
      [
        new RecruitmentInvitationNotAccepted({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
          responseState: "fixture",
        }),
        409,
        "recruitment.invitation-not-accepted",
      ],
      [
        new RecruitmentConductValidationError({
          interviewId: RecruitmentInterviewId.make("fixture-id"),
          message: "fixture",
        }),
        422,
        "recruitment.conduct-invalid",
      ],
      [
        new RecruitmentAssignmentCommandConflict({
          commandId: RecruitmentAssignmentCommandId.make("fixture-id"),
        }),
        409,
        "idempotency.digest-conflict",
      ],
      [
        new RecruitmentScheduleCommandConflict({
          commandId: RecruitmentScheduleCommandId.make("fixture-id"),
        }),
        409,
        "idempotency.digest-conflict",
      ],
      [
        new RecruitmentLifecycleCommandConflict({
          commandId: RecruitmentConductCommandId.make("fixture-id"),
        }),
        409,
        "idempotency.digest-conflict",
      ],
      [
        new NativeHttpReceiptPersistenceError({
          operation: "execute",
          cause: new Error("fixture"),
        }),
        503,
        "idempotency.unavailable",
      ],
      [
        new RecruitmentPersistenceError({ operation: "fixture", message: "fixture" }),
        503,
        "dependency.unavailable",
      ],
      [new RecruitmentDecodeError({ message: "fixture" }), 500, "internal.error"],
    ] as const;

    for (const [failure, status, code] of cases) {
      const response = recruitmentHttpErrorResponse(failure);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        status,
        type: `urn:vektorprogrammet:problem:v0.2:${code}`,
      });
    }

    const unauthorized = recruitmentHttpErrorResponse(
      new UnauthenticatedActor({ message: "Authentication required" }),
    );

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'VektorSession realm="native-api", Bearer realm="native-api"',
    );

    const malformed = recruitmentHttpErrorResponse(
      new HttpSemanticFailure("request.malformed", 400),
    );

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      status: 400,
      type: "urn:vektorprogrammet:problem:v0.2:request.malformed",
    });
  });
});

it("preserves the native conflict protocol for PostgreSQL snapshot and deadlock failures", async () => {
  for (const code of ["40001", "40P01"]) {
    const response = recruitmentHttpErrorResponse(
      new RecruitmentPersistenceError({
        operation: "fixture",
        message: "Transaction failed",
        cause: { cause: { code } },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "transaction.conflict" });
  }
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
            facts: { departmentLeaderPersonIds: leaders },
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
