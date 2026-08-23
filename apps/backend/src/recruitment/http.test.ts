import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { describe, expect, it } from "vitest";
import type { RecruitmentApiConfig } from "./config.js";
import { makeRecruitmentApiHttp } from "./http.js";

const token = "recruitment-token";
const config: RecruitmentApiConfig = {
  tokens: new Map([
    [
      token,
      {
        actor: {
          _tag: "DepartmentLeader",
          personId: PersonId.make("leader-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
        },
      },
    ],
  ]),
  maxBodyBytes: 4096,
  now: () => "2031-09-15T12:00:00.000Z",
  nextInterviewId: () => RecruitmentInterviewId.make("interview-1"),
};

const backend = makeRecruitmentApiHttp({
  config,
  run: async <A>(): Promise<A> => undefined as A,
});

const request = (path: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${path}`, init));

describe("native recruitment HTTP boundary", () => {
  it("requires the exact board status query and credentials", async () => {
    const missingStatus = await request("/api/admin/recruitment/assignment-board");
    const missingCredentials = await request("/api/admin/recruitment/assignment-board?status=new");

    expect(missingStatus.status).toBe(422);
    expect(missingCredentials.status).toBe(401);
    expect(missingCredentials.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects excess command properties before executing Recruitment", async () => {
    const response = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "command-1",
        applicationId: "application-1",
        interviewerPersonId: "person-1",
        interviewSchemaId: "schema-1",
        unexpected: true,
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { tag: "RecruitmentDecodeError" } });
  });

  it("rejects malformed UTF-8 and oversized command bodies before Recruitment", async () => {
    const malformed = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: new Uint8Array([0xc3, 0x28]),
    });
    const oversized = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "x".repeat(config.maxBodyBytes) }),
    });

    expect({ status: malformed.status, body: await malformed.json() }).toEqual({
      status: 422,
      body: { error: { tag: "RecruitmentDecodeError" } },
    });
    expect({ status: oversized.status, body: await oversized.json() }).toEqual({
      status: 413,
      body: { error: { tag: "RequestBodyTooLarge" } },
    });
  });

  it.each([
    ["RecruitmentInactiveActor", "RecruitmentInactiveActor", 403],
    ["RecruitmentRoleDenied", "RecruitmentRoleDenied", 403],
    ["RecruitmentScopeDenied", "RecruitmentScopeDenied", 403],
    ["RecruitmentInterviewerNotEligible", "RecruitmentInterviewerNotEligible", 403],
    ["RecruitmentAdmissionPeriodNotFound", "RecruitmentAdmissionPeriodNotFound", 404],
    ["RecruitmentApplicationNotFound", "RecruitmentApplicationNotFound", 404],
    ["RecruitmentInterviewSchemaNotFound", "RecruitmentInterviewSchemaNotFound", 404],
    ["RecruitmentApplicationAlreadyAssigned", "RecruitmentApplicationAlreadyAssigned", 409],
    ["RecruitmentAmbiguousAdmissionPeriod", "RecruitmentAmbiguousAdmissionPeriod", 409],
    ["RecruitmentAssignmentCommandConflict", "RecruitmentAssignmentCommandConflict", 409],
    ["RecruitmentInterviewSchemaInactive", "RecruitmentInterviewSchemaInactive", 422],
    ["RecruitmentPersistenceError", "RecruitmentPersistenceError", 503],
    ["ProfileNotFound", "RecruitmentPersistenceError", 503],
    ["ProfileDecodeError", "RecruitmentPersistenceError", 503],
    ["ProfilePersistenceError", "RecruitmentPersistenceError", 503],
    ["OrganizationDecodeError", "RecruitmentPersistenceError", 503],
    ["OrganizationPersistenceError", "RecruitmentPersistenceError", 503],
    ["AdmissionPeriodPersistenceError", "RecruitmentPersistenceError", 503],
    ["RecruitmentInvalidContext", "RecruitmentPersistenceError", 503],
  ] as const)(
    "normalizes %s to %s at HTTP %i without leaking details",
    async (sourceTag, expectedTag, expectedStatus) => {
      const failedBackend = makeRecruitmentApiHttp({
        config,
        run: async <A>(): Promise<A> => {
          throw Object.assign(new Error(sourceTag), { _tag: sourceTag });
        },
      });
      const response = await failedBackend.fetch(
        new Request("http://backend.test/api/admin/recruitment/assignment-board?status=new", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: expectedStatus,
        body: { error: { tag: expectedTag } },
      });
    },
  );
});
