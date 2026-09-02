import { deriveStrongETag, HttpSemanticFailure } from "../http-semantics.js";
import { describe, expect, it } from "vitest";
import {
  RECRUITMENT_NATIVE_OPERATION_IDS,
  RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS,
  conditionalJsonResponse,
  readRecruitmentRequestBody,
  recruitmentHttpErrorResponse,
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
    expect(new Set(RECRUITMENT_NATIVE_OPERATION_IDS).size).toBe(11);
    expect(
      Object.values(RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS).map(
        (registration) => registration.operationId,
      ),
    ).toEqual(RECRUITMENT_NATIVE_OPERATION_IDS);
    expect(
      Object.values(RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS).every(
        (registration) => !registration.path.includes("::"),
      ),
    ).toBe(true);
  });

  it("accepts one bounded JSON object and rejects invalid transport bodies", async () => {
    await expect(
      readRecruitmentRequestBody(
        new Request("http://backend.test/api/recruitment/invitation-response:reject", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Another time" }),
        }),
        64,
      ),
    ).resolves.toEqual({ message: "Another time" });

    const duplicate = readRecruitmentRequestBody(
      new Request("http://backend.test/api/recruitment/invitation-response:reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"message":"first","message":"second"}',
      }),
      128,
    );
    await expect(duplicate).rejects.toMatchObject({
      name: "HttpSemanticFailure",
      code: "request.malformed",
      status: 400,
    });

    const unsupported = readRecruitmentRequestBody(
      new Request("http://backend.test/api/recruitment/invitation-response:reject", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      64,
    );
    await expect(unsupported).rejects.toMatchObject({
      code: "media-type.unsupported",
      status: 415,
    });

    const oversizedConfirm = readRecruitmentRequestBody(
      new Request("http://backend.test/api/recruitment/invitation-response:confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unexpected: "x".repeat(64) }),
      }),
      16,
      true,
    );
    await expect(oversizedConfirm).rejects.toMatchObject({
      code: "request.malformed",
      status: 400,
    });
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
    const fresh = conditionalJsonResponse(
      new Request("http://backend.test/api/recruitment/invitation-response"),
      body,
      etag,
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

    const notModified = conditionalJsonResponse(
      new Request("http://backend.test/api/recruitment/invitation-response", {
        headers: { "if-none-match": etag },
      }),
      body,
      etag,
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

    const stale = conditionalJsonResponse(
      new Request("http://backend.test/api/recruitment/invitation-response", {
        headers: { "if-match": '"vkr2.stale"' },
      }),
      body,
      etag,
    );
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({
      status: 412,
      type: "urn:vektorprogrammet:problem:v0.2:precondition.failed",
    });
  });

  it("maps recruitment failures to the frozen RFC 9457 problem vocabulary", async () => {
    const cases = [
      ["RecruitmentInactiveActor", 403, "authority.denied"],
      ["RecruitmentAdmissionPeriodNotFound", 404, "recruitment.admission-period-not-found"],
      ["RecruitmentApplicationNotFound", 404, "recruitment.application-not-found"],
      ["RecruitmentInterviewSchemaNotFound", 404, "recruitment.interview-schema-not-found"],
      ["RecruitmentApplicationAlreadyAssigned", 409, "recruitment.application-already-assigned"],
      ["RecruitmentInterviewSchemaInactive", 422, "recruitment.interview-schema-inactive"],
      ["RecruitmentInterviewNotFound", 404, "recruitment.interview-not-found"],
      ["RecruitmentInterviewAlreadyScheduled", 409, "recruitment.already-scheduled"],
      ["RecruitmentInterviewStaleRevision", 412, "precondition.failed"],
      ["RecruitmentScheduleInPast", 422, "recruitment.schedule-in-past"],
      ["RecruitmentInvitationNotFound", 404, "resource.not-found"],
      ["RecruitmentInvitationAlreadyResponded", 409, "invitation.already-responded"],
      ["RecruitmentInterviewAlreadyFinalized", 409, "recruitment.already-finalized"],
      ["RecruitmentInterviewAlreadyCancelled", 409, "recruitment.already-cancelled"],
      ["RecruitmentInterviewNotScheduled", 409, "recruitment.interview-not-scheduled"],
      ["RecruitmentInvitationNotAccepted", 409, "recruitment.invitation-not-accepted"],
      ["RecruitmentConductValidationError", 422, "recruitment.conduct-invalid"],
      ["RecruitmentAssignmentCommandConflict", 409, "idempotency.digest-conflict"],
      ["RecruitmentScheduleCommandConflict", 409, "idempotency.digest-conflict"],
      ["RecruitmentLifecycleCommandConflict", 409, "idempotency.digest-conflict"],
      ["NativeHttpReceiptPersistenceError", 503, "idempotency.unavailable"],
      ["RecruitmentPersistenceError", 503, "dependency.unavailable"],
      ["RecruitmentDecodeError", 500, "internal.error"],
    ] as const;

    for (const [tag, status, code] of cases) {
      const response = recruitmentHttpErrorResponse({ _tag: tag });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        status,
        type: `urn:vektorprogrammet:problem:v0.2:${code}`,
      });
    }

    const unauthorized = recruitmentHttpErrorResponse({ _tag: "UnauthenticatedActor" });
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
